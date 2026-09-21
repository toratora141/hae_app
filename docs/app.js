// app.js: カメラ・UI・API呼び出しを束ねるアプリ本体。
// guide.js / analyze.js / instructions.js の純関数を呼び出し、DOM・カメラ・ネットワークの
// グルーコードだけをここに置く(判定ロジックそのものはguide.js/instructions.jsに集約する)。

import {
  parseAnswers,
  cellToRC,
  resolveTemplate,
  buildInstruction,
  buildTemplateMatchQuestion,
  buildActiveQuestions,
  collectProbabilities,
  expectedCell,
  pickCurrentCell,
  round3,
} from "./guide.js";
import {
  toGrayscale,
  laplacianVariance,
  blurScore,
  brightnessMetrics,
  brightnessScore,
  rollFromAcceleration,
  deviationFromLevel,
  levelScore,
  frameDiff,
  createStillnessTracker,
  createEma,
  touchDistance,
  zoomFromPinch,
} from "./analyze.js";
import {
  evaluateInstruction,
  isInstructionAchieved,
  createInstructionSwitcher,
} from "./instructions.js";

const DEFAULTS = {
  endpoint: "https://api.codiv.ai/v1/systemone",
  model: "openjev-latest",
  apiKey: "",
  maxSide: 768,
  autoSend: true,
  mockMode: false,
  questionSet: "A",
  uiMode: "multi",
  templateMatchEnabled: false,
};

const SETTINGS_KEY = "haeApp.settings.v1";
const LOG_KEY_V1 = "haeApp.log.v1"; // 旧形式(数値のみ)。読み取り専用で維持する。
const LOG_KEY_V2 = "haeApp.log.v2"; // イベント形式(instruction_shown/judge/shutter等)。

const MIN_SEND_INTERVAL_MS = 3000;
const RESEND_DIFF_THRESHOLD = 2; // 32px縮小グレースケールでの平均絶対差
const STILLNESS_DIFF_THRESHOLD = 3;
const STILLNESS_FRAMES = 6;
const ANALYZE_FPS = 8;
const ANALYZE_WIDTH = 128;
const SMALL_DIFF_WIDTH = 32;
const EMA_ALPHA = 0.35;
const JPEG_QUALITY = 0.8;
const LOG_THUMBNAIL_MAX_SIDE = 160; // ログに残す縮小サムネイルの長辺px
const LOG_THUMBNAIL_QUALITY = 0.5;
const SHUTTER_JPEG_QUALITY = 0.92;
const SHOT_RATING_DISPLAY_MS = 3000;
const INSTRUCTION_SWITCH_MIN_INTERVAL_MS = 1500; // instruction_rules.jsonのswitchDebounceMsと同じ仮値

const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_MAX_RETRIES = 1; // タイムアウト/ネットワークエラー時のみ、最大1回だけ再送する
const RETRY_BASE_DELAY_MS = 800;

const QUESTION_SET_IDS = ["A", "B", "C"];
const UI_MODE_IDS = ["single", "multi"];

// HTTPエラー応答(4xx/5xx)を表す。ステータスを保持し、4xx時の質問セットA自動フォールバック判定に使う。
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

function round3Deep(value) {
  if (typeof value === "number") return round3(value);
  if (Array.isArray(value)) return value.map(round3Deep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = round3Deep(v);
    return out;
  }
  return value;
}

const state = {
  settings: loadSettings(),
  templates: [],
  questionDefs: null,
  questionSets: null,
  instructionRules: null,
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
  lastJudgeTime: null,
  manualTemplateId: null, // nullなら自動選択
  isMoving: false,
  videoTrack: null,
  zoomMin: undefined, // undefinedならズーム非対応
  zoomMax: undefined,
  zoomValue: 1,
  pinchStartDistance: null,
  pinchStartZoom: null,
  // --- 質問セット/表示モード -------------------------------------------
  effectiveQuestionSet: "A", // 4xxフォールバック後はsettings.questionSetと異なる場合がある
  fallbackNotified: false,
  // --- 位置の連続化(ヒステリシス) ---------------------------------------------
  currentCell: null, // pickCurrentCell()で決めた現在マス(テンプレート判定・矢印目標に使う)
  expectedPos: null, // expectedCell()の連続座標(矢印の起点に使う)
  compositionTemplate: null,
  compositionResult: null,
  // --- 指示エンジン -----------------------------------------------------------
  instructionSwitcher: createInstructionSwitcher(INSTRUCTION_SWITCH_MIN_INTERVAL_MS),
  // --- 撮影 -------------------------------------------------------------------
  shutterCounter: 0,
  pendingShotRatingShutterId: null,
  pendingShotRatingTimer: null,
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

function cacheEls() {
  [
    "appRoot", "cameraArea", "video", "overlay", "cameraPlaceholder", "startCameraBtn", "motionPermissionBtn",
    "modeIndicator", "fallbackNotice",
    "zoomSection", "zoomSlider", "zoomValue",
    "shutterButton", "shotRatingBand", "shotRatingUp", "shotRatingDown",
    "blurMeter", "blurValue", "brightnessMeter", "brightnessValue", "levelMeter", "levelValue",
    "stillnessBadge", "templateChips", "instructionText", "instructionFeedback",
    "instructionUnderstoodBtn", "instructionUnclearBtn",
    "resultPanel", "resultStatus", "resultThumbnail", "resultDetails", "resultMeta",
    "feedbackButtons", "thumbsUp", "thumbsDown",
    "autoSendToggle", "judgeNowBtn", "exportLogBtn", "logCount",
    "settingsToggle", "settingsDialog", "settingsForm", "questionSetSelect", "uiModeSelect",
    "templateMatchToggle", "endpointInput", "modelInput",
    "apiKeyInput", "maxSideInput", "settingsAutoSendToggle", "mockModeToggle",
    "testConnectionBtn", "connectionTestResult", "closeSettingsBtn",
  ].forEach((id) => (els[id] = $(id)));
  els.appRoot = $("app");
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
  els.questionSetSelect.value = state.settings.questionSet;
  els.uiModeSelect.value = state.settings.uiMode;
  els.templateMatchToggle.checked = state.settings.templateMatchEnabled;
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
    questionSet: QUESTION_SET_IDS.includes(els.questionSetSelect.value) ? els.questionSetSelect.value : DEFAULTS.questionSet,
    uiMode: UI_MODE_IDS.includes(els.uiModeSelect.value) ? els.uiModeSelect.value : DEFAULTS.uiMode,
    templateMatchEnabled: els.templateMatchToggle.checked,
  };
  saveSettings();
  els.autoSendToggle.checked = state.settings.autoSend;

  // 質問セットを明示的に選び直したら、4xxフォールバック状態はリセットする。
  state.effectiveQuestionSet = state.settings.questionSet;
  state.fallbackNotified = false;
  els.fallbackNotice.hidden = true;
  applyUiModeClass();
  updateModeIndicator();
}

function setAutoSend(value) {
  state.settings.autoSend = value;
  saveSettings();
  els.autoSendToggle.checked = value;
  els.settingsAutoSendToggle.checked = value;
}

function applyUiModeClass() {
  els.appRoot.classList.toggle("ui-mode-single", state.settings.uiMode === "single");
}

// 画面上部の常時表示(仕様: テスト中の質問セット/表示モードの取り違え防止)。
function updateModeIndicator() {
  const modeLabel = state.settings.uiMode === "single" ? "single" : "multi";
  let text = `質問セット: ${state.effectiveQuestionSet} / 表示: ${modeLabel}`;
  if (state.effectiveQuestionSet !== state.settings.questionSet) {
    text += "(自動切替中)";
  }
  els.modeIndicator.textContent = text;
}

function showFallbackNotice(failedSet) {
  els.fallbackNotice.textContent =
    `質問セット${failedSet}でエラーが発生したため、このセッションではA(現行9項目)に自動的に切り替えました。`;
  els.fallbackNotice.hidden = false;
}

// --- テンプレート/質問の読み込み --------------------------------------------

async function loadStaticData() {
  const [defs, sets, templates, rules] = await Promise.all([
    fetch("questions/defs.json").then((r) => r.json()),
    fetch("questions/sets.json").then((r) => r.json()),
    fetch("templates.json").then((r) => r.json()),
    fetch("instruction_rules.json").then((r) => r.json()),
  ]);
  state.questionDefs = defs;
  state.questionSets = sets;
  state.templates = templates;
  state.instructionRules = rules;
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

// --- 端末内指標の計算ループ(甄8fps) -------------------------------------------

let analyzeCanvas, analyzeCtx, smallCanvas, smallCtx, captureCanvas, captureCtx, shutterCanvas, shutterCtx;

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
  if (!shutterCanvas) {
    shutterCanvas = document.createElement("canvas");
    shutterCtx = shutterCanvas.getContext("2d");
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
  refreshInstruction();

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

// --- 指示エンジン(docs/instructions.js)への橋渡し ------------------------------

function buildInstructionContext() {
  const parsed = state.lastResult;
  return {
    isStill: !state.isMoving,
    blurScore: state.emaBlur.get(),
    brightnessScore: state.emaBrightness.get(),
    hasSensor: state.motionAvailable,
    tiltDeg: state.motionAvailable && state.latestRoll !== null ? deviationFromLevel(state.latestRoll) : null,
    questionSet: state.effectiveQuestionSet,
    mainProblem: parsed ? parsed.mainProblem : null,
    mainProblemRaw: parsed ? parsed.mainProblemRaw : null,
    subjectCut: parsed ? parsed.subjectCut : null,
    distraction: parsed ? parsed.distraction : null,
    backlight: parsed ? parsed.backlight : null,
    compositionResult: state.compositionResult || null,
  };
}

// device系(ブレ・傾き・明るさ)はフレームごとに、server/composition系は判定結果が
// 更新されたときだけ変化する。呼び出しは8fpsループ+判定成功時の両方から行う。
function refreshInstruction() {
  if (!state.instructionRules) return;

  const context = buildInstructionContext();
  const candidate = evaluateInstruction(context, state.instructionRules);

  // 判定も一般構図メッセージも無い最初の状態は、プレースホルダーのまま何もログしない。
  if (candidate.kind === "composition" && !candidate.text && !state.instructionSwitcher.current) {
    els.instructionText.textContent = "被写体を認識するとガイドが表示されます";
    els.instructionFeedback.hidden = true;
    return;
  }

  const now = Date.now();
  const { displayed, switched, previous, previousShownAt } = state.instructionSwitcher.update(candidate, now);

  if (switched) {
    if (previous) {
      const achieved = isInstructionAchieved(previous, context, state.instructionRules);
      logEvent("instruction_resolved", {
        instructionId: previous.id,
        result: achieved ? "achieved" : "superseded",
        elapsedMs: previousShownAt !== null ? now - previousShownAt : null,
      });
    }
    logEvent("instruction_shown", {
      instructionId: displayed.id,
      kind: displayed.kind,
      text: displayed.text,
      questionSet: state.effectiveQuestionSet,
      uiMode: state.settings.uiMode,
      sceneAtShown: state.lastResult ? state.lastResult.scene : null,
      cellAtShown: state.currentCell,
    });
  }

  renderInstruction(displayed);
}

function renderInstruction(displayed) {
  if (!displayed) return;
  els.instructionText.textContent = displayed.text || "";
  els.instructionText.classList.toggle("achieved", displayed.kind === "done");
  els.instructionFeedback.hidden = !displayed.text;
}

function sendInstructionFeedback(understood) {
  const current = state.instructionSwitcher.current;
  if (!current) return;
  logEvent("instruction_feedback", { instructionId: current.id, understood });
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

// 長辺maxSideにリサイズしてJPEGのdata URLにする。
function captureDataUrl(maxSide, quality = JPEG_QUALITY) {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  captureCanvas.width = w;
  captureCanvas.height = h;
  captureCtx.drawImage(els.video, 0, 0, w, h);
  return captureCanvas.toDataURL("image/jpeg", quality);
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
  const thumbnail = captureDataUrl(LOG_THUMBNAIL_MAX_SIDE, LOG_THUMBNAIL_QUALITY);
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
    state.lastJudgeTime = new Date().toISOString();

    updateCurrentCell(parsed);

    logEvent("judge", buildJudgeEventFields(parsed, thumbnail, raw && raw.answers));
    renderResult(parsed, thumbnail);
    refreshGuidance();
  } catch (e) {
    if (mySeq === state.latestSendSeq) {
      handleJudgementError(e);
    }
  } finally {
    state.sending = false;
    els.judgeNowBtn.disabled = false;
  }
}

// subject_posの確率分布から連続座標(expectedPos)を求め、ヒステリシス付きで現在マスを決める。
// 位置が不明(しきい値未満)のときは現行どおり(マスをリセットしてunknown扱いに戻す)。
function updateCurrentCell(parsed) {
  if (parsed.subjectPos === null) {
    state.currentCell = null;
    state.expectedPos = null;
    return;
  }
  state.expectedPos = expectedCell(parsed.subjectPosDistribution);
  state.currentCell = pickCurrentCell(state.expectedPos, state.currentCell);
}

function handleJudgementError(e) {
  els.resultStatus.textContent = "判定に失敗しました: " + (e && e.message ? e.message : e);
  els.resultPanel.classList.remove("stale");

  const failedSet = state.effectiveQuestionSet;
  if (
    !state.settings.mockMode &&
    e &&
    typeof e.status === "number" &&
    e.status >= 400 &&
    e.status < 500 &&
    failedSet !== "A"
  ) {
    state.effectiveQuestionSet = "A";
    updateModeIndicator();
    if (!state.fallbackNotified) {
      state.fallbackNotified = true;
      showFallbackNotice(failedSet);
    }
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

function activeQuestionSetKeys() {
  return (state.questionSets && state.questionSets[state.effectiveQuestionSet]) || [];
}

// 質問セット(sets.json)のキーだけをdefs.jsonから取り出し、template_matchが有効なら
// (設定でONのときだけ)動的に組み立てたquestionを追加する。
function buildRequestQuestions() {
  const questions = buildActiveQuestions(state.questionDefs, activeQuestionSetKeys());
  if (state.settings.templateMatchEnabled) {
    questions.template_match = buildTemplateMatchQuestion(state.templates);
  }
  return questions;
}

// api.codiv.ai へのリクエスト。タイムアウト/ネットワークエラー時のみ、
// 短い待機を挿んで最大1回まで再送する(認証エラー等のHTTPエラー応答は再送しない)。
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
    const err = new Error(`HTTP ${lastError.status}: ${lastError.bodyText.slice(0, 200)}`);
    err.status = lastError.status;
    throw err;
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

// 質問定義(type: choice/score/noul)から、その型に応じた模似応答を1つ作る。
function fakeAnswerForDef(def) {
  if (!def) return null;
  if (def.type === "choice") {
    const keys = Object.keys(def.criteria || {});
    if (keys.length === 0) return null;
    return fakeChoiceAnswer(keys, randChoice(def.criteria));
  }
  if (def.type === "score") {
    return { type: "score", score: Math.random() * 4, confidence: 0.5 };
  }
  if (def.type === "noul") {
    return { type: "noul", noul: Math.random() };
  }
  return null;
}

async function mockRequest() {
  // ネットワークを呼ばず、現在の質問セットに含まれるキーそれぞれについて、
  // questions/defs.jsonの定義(type)に応じたランダムな模似応答を作る。
  await sleep(200 + Math.random() * 400);

  const answers = {};
  for (const key of activeQuestionSetKeys()) {
    const ans = fakeAnswerForDef(state.questionDefs ? state.questionDefs[key] : null);
    if (ans) answers[key] = ans;
  }

  if (state.settings.templateMatchEnabled) {
    const templateCriteria = buildTemplateMatchQuestion(state.templates).criteria;
    const templateIds = Object.keys(templateCriteria);
    if (templateIds.length > 0) {
      answers.template_match = fakeChoiceAnswer(templateIds, randChoice(templateCriteria));
    }
  }

  return {
    model: "mock",
    answers,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// --- 結果表示 ------------------------------------------------------------------

function renderResult(parsed, thumbnail) {
  els.resultPanel.classList.remove("stale");
  els.resultStatus.textContent = "判定結果";
  els.resultDetails.innerHTML = "";

  if (thumbnail) {
    els.resultThumbnail.src = thumbnail;
    els.resultThumbnail.hidden = false;
  }

  const matchedTemplate = parsed.templateMatch
    ? state.templates.find((t) => t.id === parsed.templateMatch)
    : null;

  const rows = [
    ["シーン", parsed.scene ? state.questionDefs.scene.criteria[parsed.scene] : "不明"],
    [
      "被写体の位置(サーバー回答)",
      parsed.subjectPos ? state.questionDefs.subject_pos.criteria[parsed.subjectPos] : "不明",
    ],
    ["現在マス(平滑化後)", state.currentCell ? state.questionDefs.subject_pos.criteria[state.currentCell] : "不明"],
    ["サーバー判定の構図", matchedTemplate ? matchedTemplate.name : "不明"],
    ["被写体の大きさ", parsed.subjectSize !== null ? parsed.subjectSize.toFixed(2) : "--"],
    ["映え度", parsed.haeScore !== null ? parsed.haeScore.toFixed(2) : "--"],
    ["SNS映え確率", parsed.snsWorthy !== null ? (parsed.snsWorthy * 100).toFixed(1) + "%" : "--"],
    ["スキル感", parsed.skillLevel ? state.questionDefs.skill_level.criteria[parsed.skillLevel] : "不明"],
    ["光の使い方", parsed.lightingQuality !== null ? parsed.lightingQuality.toFixed(2) : "--"],
    ["配色の統一感", parsed.colorHarmony !== null ? parsed.colorHarmony.toFixed(2) : "--"],
    ["背景のすっきり度", parsed.backgroundClutter !== null ? parsed.backgroundClutter.toFixed(2) : "--"],
    [
      "直すべき点",
      parsed.mainProblem && state.questionDefs.main_problem
        ? state.questionDefs.main_problem.criteria[parsed.mainProblem]
        : "不明",
    ],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    els.resultDetails.appendChild(dt);
    els.resultDetails.appendChild(dd);
  }

  const metaParts = [`質問セット: ${state.effectiveQuestionSet}`];
  if (typeof parsed.elapsedMs === "number") metaParts.push(`応答時間: ${Math.round(parsed.elapsedMs)}ms`);
  if (parsed.usage.inputTokens !== null) metaParts.push(`input_tokens: ${parsed.usage.inputTokens}`);
  els.resultMeta.textContent = metaParts.join(" / ");

  els.feedbackButtons.hidden = false;
  els.thumbsUp.classList.remove("picked");
  els.thumbsDown.classList.remove("picked");
}

// --- 画角ガイド ------------------------------------------------------------------

// テンプレートの決定優先順位: 手動選択 > 自動選択(scene+現在マス) > サーバー判定(template_match、
// 設定でONのときだけ)。優先順位の変更点はguide.jsのresolveTemplateのコメントを参照。
function currentTemplate() {
  if (!state.lastResult) return null;
  return resolveTemplate(state.templates, {
    manualId: state.manualTemplateId,
    templateMatchId: state.settings.templateMatchEnabled ? state.lastResult.templateMatch : null,
    scene: state.lastResult.scene,
    pos: state.currentCell,
  });
}

function refreshGuidance() {
  const template = currentTemplate();
  const size = state.lastResult ? state.lastResult.subjectSize : null;
  const result = buildInstruction(template, state.currentCell, size);

  state.compositionTemplate = template;
  state.compositionResult = result;

  drawOverlay(template, state.currentCell, state.expectedPos);
  refreshInstruction();
}

function drawOverlay(template, pos, expectedPos) {
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

  if (targetRect) {
    // 矢印の起点は連続座標(expectedPos)を優先する(仕様: 「矢印は期待座標から目標マスの中心へ描く」)。
    // 連続座標が無ければ従来どおり現在マスの中心を使う。
    let from = null;
    if (expectedPos) {
      from = { x: expectedPos.col * cellW + cellW / 2, y: expectedPos.row * cellH + cellH / 2 };
    } else if (currentRect) {
      from = { x: currentRect.x + currentRect.w / 2, y: currentRect.y + currentRect.h / 2 };
    }
    const to = { x: targetRect.x + targetRect.w / 2, y: targetRect.y + targetRect.h / 2 };
    if (from && Math.hypot(to.x - from.x, to.y - from.y) > 4) {
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

// --- ログ(端末のlocalStorageにのみ保存。イベント形式v2。v1は読み取り専用で維持) ------

function loadLogV2() {
  try {
    const raw = localStorage.getItem(LOG_KEY_V2);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function loadLogV1() {
  try {
    const raw = localStorage.getItem(LOG_KEY_V1);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

// 容量超過時は、まずjudgeイベントのサムネイルを古い方から間引き(仕様どおり画像を優先的に消す)、
// それでも入らなければ古いイベントそのものを間引く。
function saveLogV2(log) {
  let toSave = log;

  for (let i = 0; i < toSave.length + 1; i++) {
    try {
      localStorage.setItem(LOG_KEY_V2, JSON.stringify(toSave));
      return;
    } catch (e) {
      const idx = toSave.findIndex((ev) => ev.type === "judge" && ev.thumbnail);
      if (idx === -1) break;
      toSave = toSave.slice();
      toSave[idx] = { ...toSave[idx], thumbnail: null };
    }
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      localStorage.setItem(LOG_KEY_V2, JSON.stringify(toSave));
      return;
    } catch (e) {
      if (toSave.length <= 1) return;
      toSave = toSave.slice(Math.ceil(toSave.length * 0.2));
    }
  }
}

function logEvent(type, fields) {
  const log = loadLogV2();
  log.push({ type, time: new Date().toISOString(), ...round3Deep(fields) });
  saveLogV2(log);
  updateLogCount();
}

// 実際に質問セットに含まれる項目だけをログに残す(含まれない項目はキー自体を省略する)。
// こうしないと、質問していない項目まで「不明」として集計されてしまうため
// (scripts/summarize_log.mjs の「質問ごとの不明割合」が意味を持つようにするための対応)。
function buildJudgeEventFields(parsed, thumbnail, rawAnswers) {
  const template = state.compositionTemplate;
  const activeKeys = activeQuestionSetKeys();
  const has = (key) => activeKeys.includes(key);
  const probabilityKeys = state.settings.templateMatchEnabled
    ? [...activeKeys, "template_match"]
    : activeKeys;

  const fields = {
    thumbnail: thumbnail || null,
    model: parsed.model,
    questionSet: state.effectiveQuestionSet,
    scene: parsed.scene,
    sceneProb: parsed.sceneProb,
    subjectPos: parsed.subjectPos,
    subjectPosProb: parsed.subjectPosProb,
    currentCell: state.currentCell,
    subjectSize: parsed.subjectSize,
    templateId: template ? template.id : null,
    probabilities: collectProbabilities(rawAnswers, probabilityKeys),
    responseTimeMs: typeof parsed.elapsedMs === "number" ? Math.round(parsed.elapsedMs) : null,
    deviceMetrics: {
      blur: state.emaBlur.get(),
      brightness: state.emaBrightness.get(),
      level: state.emaLevel.get(),
    },
    feedback: null,
  };

  if (has("hae_score")) fields.haeScore = parsed.haeScore;
  if (has("sns_worthy")) fields.snsWorthy = parsed.snsWorthy;
  if (has("skill_level")) {
    fields.skillLevel = parsed.skillLevel;
    fields.skillLevelProb = parsed.skillLevelProb;
  }
  if (has("lighting_quality")) fields.lightingQuality = parsed.lightingQuality;
  if (has("color_harmony")) fields.colorHarmony = parsed.colorHarmony;
  if (has("background_clutter")) fields.backgroundClutter = parsed.backgroundClutter;
  if (has("main_problem")) {
    fields.mainProblem = parsed.mainProblem;
    fields.mainProblemProb = parsed.mainProblemProb;
  }
  if (has("subject_cut")) fields.subjectCut = parsed.subjectCut;
  if (has("distraction")) fields.distraction = parsed.distraction;
  if (has("backlight")) fields.backlight = parsed.backlight;
  if (state.settings.templateMatchEnabled) {
    fields.templateMatch = parsed.templateMatch;
    fields.templateMatchProb = parsed.templateMatchProb;
  }

  return fields;
}

function updateLogCount() {
  const v2Count = loadLogV2().length;
  const v1Count = loadLogV1().length;
  els.logCount.textContent =
    v1Count > 0 ? `記録: ${v2Count}件(旧形式${v1Count}件は書き出しにのみ含む)` : `記録: ${v2Count}件`;
}

// 直近のjudgeイベントに👍/👎を記録する。
function setJudgeFeedback(value) {
  const log = loadLogV2();
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].type === "judge") {
      log[i].feedback = value;
      break;
    }
  }
  saveLogV2(log);
  els.thumbsUp.classList.toggle("picked", value === "up");
  els.thumbsDown.classList.toggle("picked", value === "down");
}

function exportLog() {
  const payload = {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    events: loadLogV2(),
    legacyV1: loadLogV1(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hae-app-log-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- 撮影ボタン ------------------------------------------------------------------

function buildLastJudgeSummary() {
  if (!state.lastResult) return null;
  return {
    time: state.lastJudgeTime,
    scene: state.lastResult.scene,
    haeScore: typeof state.lastResult.haeScore === "number" ? round3(state.lastResult.haeScore) : null,
    snsWorthy: typeof state.lastResult.snsWorthy === "number" ? round3(state.lastResult.snsWorthy) : null,
    mainProblem: state.lastResult.mainProblem,
    templateId: state.compositionTemplate ? state.compositionTemplate.id : null,
  };
}

function primaryInstructionState(primary) {
  if (!state.lastResult) return "unknown";
  if (!primary) return "unknown";
  return primary.kind === "done" ? "achieved" : "unresolved";
}

async function handleShutter() {
  if (!els.video.videoWidth) return;

  const shutterId = `shot-${Date.now()}-${state.shutterCounter++}`;
  const primary = state.instructionSwitcher.current;
  const primaryState = primaryInstructionState(primary);

  // 撮影ボタンが押された時点でまだ未解決の指示があれば、resolved(shutter)として記録する。
  if (primary && primary.kind !== "done") {
    logEvent("instruction_resolved", {
      instructionId: primary.id,
      result: "shutter",
      elapsedMs:
        state.instructionSwitcher.currentShownAt !== null
          ? Date.now() - state.instructionSwitcher.currentShownAt
          : null,
    });
  }

  logEvent("shutter", {
    shutterId,
    questionSet: state.effectiveQuestionSet,
    uiMode: state.settings.uiMode,
    primaryInstructionId: primary ? primary.id : null,
    primaryState,
    deviceMetrics: {
      blur: state.emaBlur.get(),
      brightness: state.emaBrightness.get(),
      level: state.emaLevel.get(),
    },
    lastJudge: buildLastJudgeSummary(),
  });

  state.pendingShotRatingShutterId = shutterId;
  showShotRatingBand();

  try {
    await captureAndShareOrDownload();
  } catch (e) {
    els.resultStatus.textContent = "写真の保存/共有に失敗しました: " + (e && e.message ? e.message : e);
  }
}

// videoのフレームをvideoWidth×videoHeightでJPEG(品質0.92)にし、navigator.share({files})が
// 使えれば共有シート、使えなければダウンロードにフォールバックする。画像はアプリ内・ログに保存しない。
async function captureAndShareOrDownload() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw) return;
  shutterCanvas.width = vw;
  shutterCanvas.height = vh;
  shutterCtx.drawImage(els.video, 0, 0, vw, vh);

  const blob = await new Promise((resolve) => shutterCanvas.toBlob(resolve, "image/jpeg", SHUTTER_JPEG_QUALITY));
  if (!blob) throw new Error("画像の生成に失敗しました");

  const filename = `photo-${Date.now()}.jpg`;
  const file = typeof File === "function" ? new File([blob], filename, { type: "image/jpeg" }) : null;

  if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // 共有をキャンセルしただけ
      // それ以外の失敗はダウンロードにフォールバックする
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function showShotRatingBand() {
  clearTimeout(state.pendingShotRatingTimer);
  els.shotRatingBand.hidden = false;
  state.pendingShotRatingTimer = setTimeout(() => {
    els.shotRatingBand.hidden = true;
    state.pendingShotRatingShutterId = null;
  }, SHOT_RATING_DISPLAY_MS);
}

function rateShot(rating) {
  if (!state.pendingShotRatingShutterId) return;
  logEvent("shot_rating", { shutterId: state.pendingShotRatingShutterId, rating });
  clearTimeout(state.pendingShotRatingTimer);
  els.shotRatingBand.hidden = true;
  state.pendingShotRatingShutterId = null;
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
            hae_score:
              state.questionDefs && state.questionDefs.hae_score
                ? state.questionDefs.hae_score
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

  els.shutterButton.addEventListener("click", handleShutter);
  els.shotRatingUp.addEventListener("click", () => rateShot("up"));
  els.shotRatingDown.addEventListener("click", () => rateShot("down"));

  els.instructionUnderstoodBtn.addEventListener("click", () => sendInstructionFeedback(true));
  els.instructionUnclearBtn.addEventListener("click", () => sendInstructionFeedback(false));

  els.thumbsUp.addEventListener("click", () => setJudgeFeedback("up"));
  els.thumbsDown.addEventListener("click", () => setJudgeFeedback("down"));

  els.exportLogBtn.addEventListener("click", exportLog);

  window.addEventListener("resize", () => refreshGuidance());
}

async function init() {
  cacheEls();

  const params = new URLSearchParams(location.search);
  if (params.get("mock") === "1") {
    state.settings.mockMode = true;
  }
  const qsParam = params.get("qs");
  if (qsParam && QUESTION_SET_IDS.includes(qsParam)) {
    state.settings.questionSet = qsParam; // mock=1と同様、URL指定はこのセッション限りで永続化しない
  }
  const uiParam = params.get("ui");
  if (uiParam && UI_MODE_IDS.includes(uiParam)) {
    state.settings.uiMode = uiParam;
  }

  state.effectiveQuestionSet = state.settings.questionSet;

  applySettingsToForm();
  applyUiModeClass();
  updateModeIndicator();
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
