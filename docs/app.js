// app.js: カメラ・UI・API呼び出しを束ねるアプリ本体。
// guide.js / analyze.js の純関数を呼び出し、DOM・カメラ・ネットワークの
// グルーコードだけをここに置く(判定ロジックそのものはguide.jsに集約する)。

import {
  parseAnswers,
  cellToRC,
  resolveTemplate,
  buildInstruction,
  buildTemplateMatchQuestion,
} from "./guide.js";
import {
  toGrayscale,
  laplacianVariance,
  blurScore,
  brightnessMetrics,
  brightnessScore,
  rollFromAcceleration,
  levelScore,
  frameDiff,
  createStillnessTracker,
  createEma,
  touchDistance,
  zoomFromPinch,
} from "./analyze.js";

const DEFAULTS = {
  endpoint: "https://api.codiv.ai/v1/systemone",
  model: "openjev-latest",
  apiKey: "",
  maxSide: 768,
  autoSend: true,
  mockMode: false,
};

const SETTINGS_KEY = "haeApp.settings.v1";
const LOG_KEY = "haeApp.log.v1";

const MIN_SEND_INTERVAL_MS = 3000;
const RESEND_DIFF_THRESHOLD = 2; // 32px縮小グレースケールでの平均絶対差
const STILLNESS_DIFF_THRESHOLD = 3;
const STILLNESS_FRAMES = 6;
const ANALYZE_FPS = 8;
const ANALYZE_WIDTH = 128;
const SMALL_DIFF_WIDTH = 32;
const EMA_ALPHA = 0.35;
const JPEG_QUALITY = 0.8;

const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_MAX_RETRIES = 1; // タイムアウト/ネットワークエラー時のみ、最大1回だけ再送する
const RETRY_BASE_DELAY_MS = 800;

// HTTPエラー応答(4xx/5xx)を表す。認証エラー等は再送しても解決しないため
// リトライ対象から除外する目印として使う。
class HttpError extends Error {
  constructor(status, bodyText) {
    super(`HTTP ${status}`);
    this.status = status;
    this.bodyText = bodyText;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const state = {
  settings: loadSettings(),
  templates: [],
  questions: null,
  stream: null,
  animTimer: null,
  prevAnalyzeGray: null,
  stillnessTracker: createStillnessTracker(STILLNESS_DIFF_THRESHOLD, STILLNESS_FRAMES),
  emaBlur: createEma(EMA_ALPHA),
  emaBrightness: createEma(EMA_ALPHA),
  emaLevel: createEma(EMA_ALPHA),
  latestRoll: null, // devicemotionから得た水平角(度)
  motionAvailable: false,
  sending: false,
  lastSentAt: 0,
  lastSentSmallGray: null,
  sendSeq: 0,
  latestSendSeq: 0,
  lastResult: null, // parseAnswers()の結果
  manualTemplateId: null, // nullなら自動選択
  isMoving: false,
  videoTrack: null,
  zoomMin: undefined, // undefinedならズーム非対応
  zoomMax: undefined,
  zoomValue: 1,
  pinchStartDistance: null,
  pinchStartZoom: null,
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

function cacheEls() {
  [
    "cameraArea", "video", "overlay", "cameraPlaceholder", "startCameraBtn", "motionPermissionBtn",
    "zoomSection", "zoomSlider", "zoomValue",
    "blurMeter", "blurValue", "brightnessMeter", "brightnessValue", "levelMeter", "levelValue",
    "stillnessBadge", "templateChips", "instructionText", "resultPanel", "resultStatus",
    "resultDetails", "resultMeta", "feedbackButtons", "thumbsUp", "thumbsDown",
    "autoSendToggle", "judgeNowBtn", "exportLogBtn", "logCount",
    "settingsToggle", "settingsDialog", "settingsForm", "endpointInput", "modelInput",
    "apiKeyInput", "maxSideInput", "settingsAutoSendToggle", "mockModeToggle",
    "testConnectionBtn", "connectionTestResult", "closeSettingsBtn",
  ].forEach((id) => (els[id] = $(id)));
}

// --- 設定の読み書き(APIキーはlocalStorageのみ。コード・ログには出力しない) -------

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch (e) {
    // プライベートブラウジング等でlocalStorageが使えない場合は保存をあきらめる
  }
}

function applySettingsToForm() {
  els.endpointInput.value = state.settings.endpoint;
  els.modelInput.value = state.settings.model;
  els.apiKeyInput.value = state.settings.apiKey;
  els.maxSideInput.value = state.settings.maxSide;
  els.settingsAutoSendToggle.checked = state.settings.autoSend;
  els.mockModeToggle.checked = state.settings.mockMode;
  els.autoSendToggle.checked = state.settings.autoSend;
}

function readSettingsFromForm() {
  state.settings = {
    ...state.settings,
    endpoint: els.endpointInput.value.trim() || DEFAULTS.endpoint,
    model: els.modelInput.value.trim() || DEFAULTS.model,
    apiKey: els.apiKeyInput.value,
    maxSide: Math.max(128, Math.min(2048, Number(els.maxSideInput.value) || DEFAULTS.maxSide)),
    autoSend: els.settingsAutoSendToggle.checked,
    mockMode: els.mockModeToggle.checked,
  };
  saveSettings();
  els.autoSendToggle.checked = state.settings.autoSend;
}

function setAutoSend(value) {
  state.settings.autoSend = value;
  saveSettings();
  els.autoSendToggle.checked = value;
  els.settingsAutoSendToggle.checked = value;
}

// --- テンプレート/質問の読み込み --------------------------------------------

async function loadStaticData() {
  const [templates, questions] = await Promise.all([
    fetch("templates.json").then((r) => r.json()),
    fetch("questions.json").then((r) => r.json()),
  ]);
  state.templates = templates;
  state.questions = questions;
  renderTemplateChips();
}

function renderTemplateChips() {
  els.templateChips.innerHTML = "";

  const autoChip = document.createElement("button");
  autoChip.type = "button";
  autoChip.className = "chip" + (state.manualTemplateId === null ? " selected" : "");
  autoChip.textContent = "自動";
  autoChip.addEventListener("click", () => {
    state.manualTemplateId = null;
    renderTemplateChips();
    refreshGuidance();
  });
  els.templateChips.appendChild(autoChip);

  for (const t of state.templates) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (state.manualTemplateId === t.id ? " selected" : "");
    chip.textContent = t.name;
    chip.addEventListener("click", () => {
      state.manualTemplateId = t.id;
      renderTemplateChips();
      refreshGuidance();
    });
    els.templateChips.appendChild(chip);
  }
}

// --- カメラ ------------------------------------------------------------------

async function startCamera() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    els.video.srcObject = state.stream;
    await els.video.play();
    els.cameraPlaceholder.classList.add("hidden");
    setupCameraTrackControls();
    startAnalyzeLoop();
  } catch (e) {
    els.resultStatus.textContent =
      "カメラを開始できませんでした: " + (e && e.message ? e.message : e);
  }
}

// --- ズーム・オートフォーカス --------------------------------------------------
// 対応はブラウザ・端末依存(主にAndroid Chrome系)。非対応の場合は何もしない。

function setupCameraTrackControls() {
  const track = state.stream.getVideoTracks()[0];
  state.videoTrack = track || null;
  els.zoomSection.hidden = true;
  if (!track || typeof track.getCapabilities !== "function") return;

  let capabilities;
  try {
    capabilities = track.getCapabilities();
  } catch (e) {
    return;
  }

  // オートフォーカス: 対応していれば連続オートフォーカスを明示的に有効化する。
  if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
    track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
  }

  // ズーム: 対応していればスライダーとピンチ操作を有効化する。
  if (capabilities.zoom && typeof capabilities.zoom.min === "number") {
    state.zoomMin = capabilities.zoom.min;
    state.zoomMax = capabilities.zoom.max;
    const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
    state.zoomValue = typeof settings.zoom === "number" ? settings.zoom : state.zoomMin;

    els.zoomSlider.min = state.zoomMin;
    els.zoomSlider.max = state.zoomMax;
    els.zoomSlider.step = capabilities.zoom.step || 0.1;
    els.zoomSlider.value = state.zoomValue;
    els.zoomValue.textContent = `${state.zoomValue.toFixed(1)}x`;
    els.zoomSection.hidden = false;
  } else {
    state.zoomMin = undefined;
    state.zoomMax = undefined;
  }
}

function applyZoom(value) {
  if (!state.videoTrack || state.zoomMin === undefined) return;
  const clamped = Math.min(state.zoomMax, Math.max(state.zoomMin, value));
  state.zoomValue = clamped;
  state.videoTrack.applyConstraints({ advanced: [{ zoom: clamped }] }).catch(() => {});
  els.zoomSlider.value = clamped;
  els.zoomValue.textContent = `${clamped.toFixed(1)}x`;
}

// カメラ映像上のピンチ操作でズームを操作する(ズーム対応時のみ動作する)。
function setupPinchZoom() {
  els.cameraArea.addEventListener("touchstart", (ev) => {
    if (ev.touches.length === 2 && state.zoomMin !== undefined) {
      state.pinchStartDistance = touchDistance(ev.touches);
      state.pinchStartZoom = state.zoomValue;
    }
  });

  els.cameraArea.addEventListener(
    "touchmove",
    (ev) => {
      if (ev.touches.length === 2 && state.pinchStartDistance && state.zoomMin !== undefined) {
        ev.preventDefault();
        const dist = touchDistance(ev.touches);
        const next = zoomFromPinch(state.pinchStartDistance, dist, state.pinchStartZoom, state.zoomMin, state.zoomMax);
        applyZoom(next);
      }
    },
    { passive: false }
  );

  els.cameraArea.addEventListener("touchend", () => {
    state.pinchStartDistance = null;
  });
}

// --- devicemotion(水平指標) ---------------------------------------------------

function attachMotionListener() {
  window.addEventListener("devicemotion", (ev) => {
    const g = ev.accelerationIncludingGravity;
    if (!g || typeof g.x !== "number" || typeof g.y !== "number") return;
    state.latestRoll = rollFromAcceleration(g.x, g.y);
    state.motionAvailable = true;
  });
}

function setupMotionPermission() {
  const needsPermission =
    typeof DeviceMotionEvent !== "undefined" &&
    typeof DeviceMotionEvent.requestPermission === "function";

  if (!needsPermission) {
    if (typeof DeviceMotionEvent !== "undefined") attachMotionListener();
    return;
  }

  els.motionPermissionBtn.hidden = false;
  els.motionPermissionBtn.addEventListener("click", async () => {
    try {
      const result = await DeviceMotionEvent.requestPermission();
      if (result === "granted") {
        attachMotionListener();
        els.motionPermissionBtn.hidden = true;
      } else {
        els.motionPermissionBtn.textContent = "センサーの利用が許可されませんでした";
      }
    } catch (e) {
      els.motionPermissionBtn.textContent = "センサー許可の取得に失敗しました";
    }
  });
}

// --- 端末内指標の計算ループ(約8fps) -------------------------------------------

let analyzeCanvas, analyzeCtx, smallCanvas, smallCtx, captureCanvas, captureCtx;

function ensureOffscreenCanvases() {
  if (!analyzeCanvas) {
    analyzeCanvas = document.createElement("canvas");
    analyzeCtx = analyzeCanvas.getContext("2d", { willReadFrequently: true });
  }
  if (!smallCanvas) {
    smallCanvas = document.createElement("canvas");
    smallCtx = smallCanvas.getContext("2d", { willReadFrequently: true });
  }
  if (!captureCanvas) {
    captureCanvas = document.createElement("canvas");
    captureCtx = captureCanvas.getContext("2d");
  }
}

function startAnalyzeLoop() {
  ensureOffscreenCanvases();
  if (state.animTimer) clearInterval(state.animTimer);
  state.animTimer = setInterval(analyzeFrame, 1000 / ANALYZE_FPS);
}

function analyzeFrame() {
  if (!els.video.videoWidth) return;

  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const w = ANALYZE_WIDTH;
  const h = Math.max(1, Math.round((ANALYZE_WIDTH * vh) / vw));

  analyzeCanvas.width = w;
  analyzeCanvas.height = h;
  analyzeCtx.drawImage(els.video, 0, 0, w, h);
  const gray = toGrayscale(analyzeCtx.getImageData(0, 0, w, h).data);

  const variance = laplacianVariance(gray, w, h);
  const blur = blurScore(variance);

  const { mean, clippedRatio } = brightnessMetrics(gray);
  const brightness = brightnessScore(mean, clippedRatio);

  const level =
    state.motionAvailable && state.latestRoll !== null ? levelScore(state.latestRoll) : null;

  const blurS = state.emaBlur.update(blur);
  const brightnessS = state.emaBrightness.update(brightness);
  const levelS = level !== null ? state.emaLevel.update(level) : null;
  updateMetricsUI(blurS, brightnessS, levelS);

  const diff = frameDiff(state.prevAnalyzeGray, gray);
  state.prevAnalyzeGray = gray;
  const isStill = state.stillnessTracker.update(diff);
  state.isMoving = !isStill;
  updateStillnessUI(isStill);
  updateResultStaleUI();

  if (isStill && state.settings.autoSend && !state.sending) {
    maybeSendJudgement("auto");
  }
}

function updateMetricsUI(blur, brightness, level) {
  if (blur !== null) {
    els.blurMeter.value = blur;
    els.blurValue.textContent = Math.round(blur);
  }
  if (brightness !== null) {
    els.brightnessMeter.value = brightness;
    els.brightnessValue.textContent = Math.round(brightness);
  }
  if (level !== null) {
    els.levelMeter.value = level;
    els.levelValue.textContent = Math.round(level);
  } else {
    els.levelValue.textContent = "--";
  }
}

function updateStillnessUI(isStill) {
  els.stillnessBadge.textContent = isStill ? "静止" : "静止待ち";
  els.stillnessBadge.classList.toggle("still", isStill);
}

// 応答待ち中にカメラが動いた場合や、直近の結果が古くなった場合はグレー表示にする。
function updateResultStaleUI() {
  if (!state.lastResult) return;
  const stale = state.isMoving || state.sending;
  els.resultPanel.classList.toggle("stale", stale);
  if (state.sending) {
    els.resultStatus.textContent = "更新待ち...";
  }
}

// --- 判定リクエストの送信 -------------------------------------------------------

function downscaleGray(width) {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw) return null;
  const h = Math.max(1, Math.round((width * vh) / vw));
  smallCanvas.width = width;
  smallCanvas.height = h;
  smallCtx.drawImage(els.video, 0, 0, width, h);
  return toGrayscale(smallCtx.getImageData(0, 0, width, h).data);
}

// 長辺maxSideにリサイズしてJPEG(quality 0.8)のdata URLにする。
function captureDataUrl(maxSide) {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  captureCanvas.width = w;
  captureCanvas.height = h;
  captureCtx.drawImage(els.video, 0, 0, w, h);
  return captureCanvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

async function maybeSendJudgement(trigger) {
  if (state.sending) return; // 同時に飛ばすリクエストは1つだけ
  if (!els.video.videoWidth) return;

  const now = Date.now();
  if (now - state.lastSentAt < MIN_SEND_INTERVAL_MS) return; // 前回送信から3秒未満

  const smallGray = downscaleGray(SMALL_DIFF_WIDTH);
  if (trigger === "auto" && state.lastSentSmallGray && smallGray) {
    const d = frameDiff(state.lastSentSmallGray, smallGray);
    if (d < RESEND_DIFF_THRESHOLD) return; // 前回送信フレームとほぼ変化なし
  }

  await sendJudgement(smallGray);
}

async function sendJudgement(smallGray) {
  state.sending = true;
  state.sendSeq += 1;
  const mySeq = state.sendSeq;
  state.latestSendSeq = mySeq;
  els.judgeNowBtn.disabled = true;
  updateResultStaleUI();

  const t0 = performance.now();
  try {
    const raw = state.settings.mockMode
      ? await mockRequest()
      : await realRequest(captureDataUrl(state.settings.maxSide));
    const elapsedMs = performance.now() - t0;

    if (mySeq !== state.latestSendSeq) return; // より新しい送信が既にあるため破棄

    state.lastSentAt = Date.now();
    state.lastSentSmallGray = smallGray;

    const parsed = parseAnswers(raw);
    parsed.elapsedMs = elapsedMs;
    state.lastResult = parsed;

    appendLog(parsed);
    renderResult(parsed);
    refreshGuidance();
  } catch (e) {
    if (mySeq === state.latestSendSeq) {
      els.resultStatus.textContent = "判定に失敗しました: " + (e && e.message ? e.message : e);
      els.resultPanel.classList.remove("stale");
    }
  } finally {
    state.sending = false;
    els.judgeNowBtn.disabled = false;
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// questions.jsonの固定項目に、テンプレート一覧から都度組み立てるtemplate_matchを足したものを
// リクエストのquestionsとして使う(テンプレートは運用中に増減し得るため)。
function buildRequestQuestions() {
  return {
    ...state.questions,
    template_match: buildTemplateMatchQuestion(state.templates),
  };
}

// api.codiv.ai へのリクエスト。タイムアウト/ネットワークエラー時のみ、
// 短い待機を挟んで最大1回まで再送する(認証エラー等のHTTPエラー応答は再送しない)。
async function realRequest(dataUrl) {
  const body = JSON.stringify({
    model: state.settings.model,
    state: "Look at the photo.",
    images: [dataUrl],
    questions: buildRequestQuestions(),
  });
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${state.settings.apiKey}`,
  };

  let lastError = null;
  for (let attempt = 0; attempt <= REQUEST_MAX_RETRIES; attempt++) {
    try {
      const resp = await fetchWithTimeout(
        state.settings.endpoint,
        { method: "POST", headers, body },
        REQUEST_TIMEOUT_MS
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new HttpError(resp.status, text);
      }
      return await resp.json();
    } catch (e) {
      lastError = e;
      if (e instanceof HttpError) break; // HTTPエラー応答は再送しない
      if (attempt === REQUEST_MAX_RETRIES) break;
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }

  if (lastError instanceof HttpError) {
    throw new Error(`HTTP ${lastError.status}: ${lastError.bodyText.slice(0, 200)}`);
  }
  if (lastError && lastError.name === "AbortError") {
    throw new Error(`タイムアウトしました(${REQUEST_TIMEOUT_MS}ms)`);
  }
  throw lastError || new Error("不明なエラー");
}

function randChoice(obj) {
  const keys = Object.keys(obj);
  return keys[Math.floor(Math.random() * keys.length)];
}

async function mockRequest() {
  // ネットワークを呼ばず、questions.jsonの選択肢からランダムな疑似応答を作る。
  await sleep(200 + Math.random() * 400);
  const scenes = Object.keys(state.questions.scene.criteria);
  const positions = Object.keys(state.questions.subject_pos.criteria);
  const scene = randChoice(state.questions.scene.criteria);
  const pos = randChoice(state.questions.subject_pos.criteria);

  function fakeChoiceAnswer(keys, picked) {
    const probabilities = {};
    let remaining = 1;
    keys.forEach((k, i) => {
      if (k === picked) return;
      const p = i === keys.length - 1 ? remaining : Math.random() * remaining * 0.5;
      probabilities[k] = p;
      remaining -= p;
    });
    probabilities[picked] = Math.max(0.4, remaining + Math.random() * 0.3);
    return { type: "choice", choice: picked, probabilities, confidence: probabilities[picked] };
  }

  const skillLevels = Object.keys(state.questions.skill_level.criteria);
  const skillLevel = randChoice(state.questions.skill_level.criteria);

  const answers = {
    scene: fakeChoiceAnswer(scenes, scene),
    subject_pos: fakeChoiceAnswer(positions, pos),
    subject_size: { type: "score", score: Math.random() * 4, confidence: 0.5 },
    hae_score: { type: "score", score: Math.random() * 4, confidence: 0.5 },
    sns_worthy: { type: "noul", noul: Math.random() },
    skill_level: fakeChoiceAnswer(skillLevels, skillLevel),
    lighting_quality: { type: "score", score: Math.random() * 4, confidence: 0.5 },
    color_harmony: { type: "score", score: Math.random() * 4, confidence: 0.5 },
    background_clutter: { type: "score", score: Math.random() * 4, confidence: 0.5 },
  };

  const templateCriteria = buildTemplateMatchQuestion(state.templates).criteria;
  const templateIds = Object.keys(templateCriteria);
  if (templateIds.length > 0) {
    answers.template_match = fakeChoiceAnswer(templateIds, randChoice(templateCriteria));
  }

  return {
    model: "mock",
    answers,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// --- 結果表示 ------------------------------------------------------------------

function renderResult(parsed) {
  els.resultPanel.classList.remove("stale");
  els.resultStatus.textContent = "判定結果";
  els.resultDetails.innerHTML = "";

  const matchedTemplate = parsed.templateMatch
    ? state.templates.find((t) => t.id === parsed.templateMatch)
    : null;

  const rows = [
    ["シーン", parsed.scene ? state.questions.scene.criteria[parsed.scene] : "不明"],
    ["被写体の位置", parsed.subjectPos ? state.questions.subject_pos.criteria[parsed.subjectPos] : "不明"],
    ["サーバー判定の構図", matchedTemplate ? matchedTemplate.name : "不明"],
    ["被写体の大きさ", parsed.subjectSize !== null ? parsed.subjectSize.toFixed(2) : "--"],
    ["映え度", parsed.haeScore !== null ? parsed.haeScore.toFixed(2) : "--"],
    ["SNS映え確率", parsed.snsWorthy !== null ? (parsed.snsWorthy * 100).toFixed(1) + "%" : "--"],
    ["スキル感", parsed.skillLevel ? state.questions.skill_level.criteria[parsed.skillLevel] : "不明"],
    ["光の使い方", parsed.lightingQuality !== null ? parsed.lightingQuality.toFixed(2) : "--"],
    ["配色の統一感", parsed.colorHarmony !== null ? parsed.colorHarmony.toFixed(2) : "--"],
    ["背景のすっきり度", parsed.backgroundClutter !== null ? parsed.backgroundClutter.toFixed(2) : "--"],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    els.resultDetails.appendChild(dt);
    els.resultDetails.appendChild(dd);
  }

  const metaParts = [];
  if (typeof parsed.elapsedMs === "number") metaParts.push(`応答時間: ${Math.round(parsed.elapsedMs)}ms`);
  if (parsed.usage.inputTokens !== null) metaParts.push(`input_tokens: ${parsed.usage.inputTokens}`);
  els.resultMeta.textContent = metaParts.join(" / ");

  els.feedbackButtons.hidden = false;
  els.thumbsUp.classList.remove("picked");
  els.thumbsDown.classList.remove("picked");
}

// --- 画角ガイド ------------------------------------------------------------------

// テンプレートの決定優先順位: 手動選択 > サーバー判定(template_match) > 自動選択。
function currentTemplate() {
  if (!state.lastResult) return null;
  return resolveTemplate(state.templates, {
    manualId: state.manualTemplateId,
    templateMatchId: state.lastResult.templateMatch,
    scene: state.lastResult.scene,
    pos: state.lastResult.subjectPos,
  });
}

function refreshGuidance() {
  const template = currentTemplate();
  const pos = state.lastResult ? state.lastResult.subjectPos : null;
  const size = state.lastResult ? state.lastResult.subjectSize : null;

  const instruction = buildInstruction(template, pos, size);
  els.instructionText.textContent = instruction.message;
  els.instructionText.classList.toggle("achieved", instruction.achieved);

  drawOverlay(template, pos);
}

function drawOverlay(template, pos) {
  const canvas = els.overlay;
  const rect = els.video.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  const cellW = w / 3;
  const cellH = h / 3;

  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(cellW * i, 0);
    ctx.lineTo(cellW * i, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, cellH * i);
    ctx.lineTo(w, cellH * i);
    ctx.stroke();
  }

  function cellRect(cell) {
    const rc = cellToRC(cell);
    if (!rc) return null;
    return { x: rc.col * cellW, y: rc.row * cellH, w: cellW, h: cellH };
  }

  let targetRect = null;
  if (template) {
    targetRect = cellRect(template.target.cell);
    if (targetRect) {
      ctx.strokeStyle = "#2f6fed";
      ctx.lineWidth = 3;
      ctx.strokeRect(targetRect.x + 3, targetRect.y + 3, targetRect.w - 6, targetRect.h - 6);
    }
  }

  let currentRect = null;
  if (pos) {
    currentRect = cellRect(pos);
    if (currentRect) {
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.strokeRect(currentRect.x + 6, currentRect.y + 6, currentRect.w - 12, currentRect.h - 12);
      ctx.setLineDash([]);
    }
  }

  if (targetRect && currentRect) {
    const from = { x: currentRect.x + currentRect.w / 2, y: currentRect.y + currentRect.h / 2 };
    const to = { x: targetRect.x + targetRect.w / 2, y: targetRect.y + targetRect.h / 2 };
    if (Math.hypot(to.x - from.x, to.y - from.y) > 4) {
      drawArrow(ctx, from, to);
    }
  }
}

function drawArrow(ctx, from, to) {
  ctx.strokeStyle = "#ffd23f";
  ctx.fillStyle = "#ffd23f";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const headLen = 12;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI / 6), to.y - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI / 6), to.y - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

// --- ログ(APIレスポンスの数値のみ。画像は保存しない) ------------------------------

function loadLog() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveLog(log) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch (e) {
    // 保存できない場合は無視する
  }
}

function appendLog(parsed) {
  const log = loadLog();
  const template = currentTemplate();
  log.push({
    time: new Date().toISOString(),
    scene: parsed.scene,
    sceneProb: parsed.sceneProb,
    subjectPos: parsed.subjectPos,
    subjectPosProb: parsed.subjectPosProb,
    subjectSize: parsed.subjectSize,
    haeScore: parsed.haeScore,
    snsWorthy: parsed.snsWorthy,
    templateMatch: parsed.templateMatch,
    templateMatchProb: parsed.templateMatchProb,
    skillLevel: parsed.skillLevel,
    skillLevelProb: parsed.skillLevelProb,
    lightingQuality: parsed.lightingQuality,
    colorHarmony: parsed.colorHarmony,
    backgroundClutter: parsed.backgroundClutter,
    templateId: template ? template.id : null,
    deviceMetrics: {
      blur: state.emaBlur.get(),
      brightness: state.emaBrightness.get(),
      level: state.emaLevel.get(),
    },
    feedback: null,
  });
  saveLog(log);
  updateLogCount();
}

function updateLogCount() {
  els.logCount.textContent = `記録: ${loadLog().length}件`;
}

function setFeedback(value) {
  const log = loadLog();
  if (log.length === 0) return;
  log[log.length - 1].feedback = value;
  saveLog(log);
  els.thumbsUp.classList.toggle("picked", value === "up");
  els.thumbsDown.classList.toggle("picked", value === "down");
}

function exportLog() {
  const log = loadLog();
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hae-app-log-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- 接続テスト --------------------------------------------------------------

async function testConnection() {
  els.connectionTestResult.textContent = "テスト中...";
  els.connectionTestResult.className = "";
  const endpoint = els.endpointInput.value.trim() || DEFAULTS.endpoint;
  try {
    const resp = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${els.apiKeyInput.value}`,
        },
        body: JSON.stringify({
          model: els.modelInput.value.trim() || DEFAULTS.model,
          state: "Look at the photo.",
          questions: {
            hae_score: state.questions
              ? state.questions.hae_score
              : { type: "score", instructions: "test", criteria: ["a", "b", "c", "d", "e"] },
          },
        }),
      },
      REQUEST_TIMEOUT_MS
    );
    if (resp.ok) {
      els.connectionTestResult.textContent = `接続成功 (HTTP ${resp.status})`;
      els.connectionTestResult.className = "ok";
    } else {
      els.connectionTestResult.textContent = `接続失敗 (HTTP ${resp.status})`;
      els.connectionTestResult.className = "ng";
    }
  } catch (e) {
    els.connectionTestResult.textContent =
      "接続に失敗しました。CORS制限によりブラウザから直接アクセスできない可能性があります" +
      "(relay/worker.js の中継を経由するURLをエンドポイントに設定してください)。詳細: " +
      (e && e.message ? e.message : e);
    els.connectionTestResult.className = "ng";
  }
}

// --- 初期化 --------------------------------------------------------------------

function wireEvents() {
  els.startCameraBtn.addEventListener("click", startCamera);

  els.settingsToggle.addEventListener("click", () => {
    applySettingsToForm();
    els.settingsDialog.showModal();
  });
  els.closeSettingsBtn.addEventListener("click", () => els.settingsDialog.close());
  els.settingsForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    readSettingsFromForm();
    els.settingsDialog.close();
  });
  els.testConnectionBtn.addEventListener("click", testConnection);

  els.autoSendToggle.addEventListener("change", () => setAutoSend(els.autoSendToggle.checked));
  els.settingsAutoSendToggle.addEventListener("change", () =>
    setAutoSend(els.settingsAutoSendToggle.checked)
  );
  els.judgeNowBtn.addEventListener("click", () => maybeSendJudgement("manual"));

  els.zoomSlider.addEventListener("input", () => applyZoom(Number(els.zoomSlider.value)));

  els.thumbsUp.addEventListener("click", () => setFeedback("up"));
  els.thumbsDown.addEventListener("click", () => setFeedback("down"));

  els.exportLogBtn.addEventListener("click", exportLog);

  window.addEventListener("resize", () => refreshGuidance());
}

async function init() {
  cacheEls();

  const params = new URLSearchParams(location.search);
  if (params.get("mock") === "1") {
    state.settings.mockMode = true;
  }

  applySettingsToForm();
  wireEvents();
  setupMotionPermission();
  setupPinchZoom();
  updateLogCount();

  await loadStaticData();
  refreshGuidance();
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", init);
}

// テストや将来の拡張のために状態オブジェクトをエクスポートしておく(ブラウザ実行には影響しない)。
export { state };
