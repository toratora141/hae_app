// app.js (angle実験専用): カメラ・UI・API呼び出しを束ねるアプリ本体。
// docs/app.js とは完全に独立している(既存ファイルは一切importせずコピーして使う)。
// 例外: docs/analyze.js の純関数(グレースケール変換・静止判定)のみ読み取り専用で再利用する。

import { parseAngleAnswers, buildAngleGuidance, ANGLE_PROB_THRESHOLD } from "./guide.js";
import { toGrayscale, frameDiff, createStillnessTracker } from "../analyze.js";

const DEFAULTS = {
  endpoint: "https://api.codiv.ai/v1/systemone",
  model: "openjev-latest",
  apiKey: "",
};

// このページ専用のlocalStorageキー(既存ページのキーとは別)
const SETTINGS_KEY = "haeApp.angle.settings.v1";
const LOG_KEY = "haeApp.angle.log.v1";
// 既存ページ(docs/app.js)の設定(読み取り専用の流用元)。書き込みは一切行わない。
const MAIN_SETTINGS_KEY_FOR_READONLY_REUSE = "haeApp.settings.v1";

const MAX_SIDE = 768; // 送信画像の長辺(px)。既存ページのDEFAULTS.maxSideと同じ値。
const JPEG_QUALITY = 0.8; // 既存ページのJPEG_QUALITYと同じ値。

// 送信間隔・再送・静止判定・タイムアウト・リトライは、既存ページ(docs/app.js)の
// 同名定数と同じ値をこのページ専用に持つ(既存ファイルは変更しない)。
const MIN_SEND_INTERVAL_MS = 3000;
const RESEND_DIFF_THRESHOLD = 2; // 32px縮小グレースケールでの平均絶対差
const STILLNESS_DIFF_THRESHOLD = 3;
const STILLNESS_FRAMES = 6;
const ANALYZE_FPS = 8;
const ANALYZE_WIDTH = 128;
const SMALL_DIFF_WIDTH = 32;

const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_MAX_RETRIES = 1; // タイムアウト/ネットワークエラー時のみ、最大1回だけ再送する
const RETRY_BASE_DELAY_MS = 800;

// HTTPエラー応答(4xx/5xx)を表す。既存ページと同様、再送はしない。
class HttpError extends Error {
  constructor(status, bodyText) {
    super(`HTTP ${status}`);
    this.status = status;
    this.bodyText = bodyText || "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const state = {
  settings: loadSettings(),
  questions: null,
  mockMode: false,
  stream: null,
  animTimer: null,
  prevAnalyzeGray: null,
  stillnessTracker: createStillnessTracker(STILLNESS_DIFF_THRESHOLD, STILLNESS_FRAMES),
  sending: false,
  lastSentAt: 0,
  lastSentSmallGray: null,
  sendSeq: 0,
  latestSendSeq: 0,
  isMoving: false,
};

const els = {};

function $(id) {
  return document.getElementById(id);
}

function cacheEls() {
  [
    "video", "cameraPlaceholder", "startCameraBtn",
    "stillnessBadge", "resultPanel", "resultStatus",
    "cameraAngleValue", "recommendedAngleValue", "guidanceMessage", "resultMeta",
    "autoSendToggle", "judgeNowBtn", "exportLogBtn", "logCount",
    "settingsToggle", "settingsDialog", "settingsForm", "endpointInput", "modelInput",
    "apiKeyInput", "closeSettingsBtn",
  ].forEach((id) => (els[id] = $(id)));
}

// --- 設定の読み書き(このページ専用キーにのみ書き込む) -----------------------

function readMainSettingsForReuse() {
  try {
    const raw = localStorage.getItem(MAIN_SETTINGS_KEY_FOR_READONLY_REUSE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      return { ...DEFAULTS, ...JSON.parse(raw) };
    }
  } catch (e) {
    // 壊れた保存値は無視してデフォルトへフォールバックする
  }
  // このページ専用の設定が無ければ、既存ページ(docs/index.html)の設定(読み取り専用)を
  // 初期値として流用する。
  const main = readMainSettingsForReuse();
  if (main) {
    return {
      endpoint: typeof main.endpoint === "string" && main.endpoint ? main.endpoint : DEFAULTS.endpoint,
      model: typeof main.model === "string" && main.model ? main.model : DEFAULTS.model,
      apiKey: typeof main.apiKey === "string" ? main.apiKey : DEFAULTS.apiKey,
    };
  }
  return { ...DEFAULTS };
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch (e) {
    // localStorageが使えない環境(プライベートモード等)では保存をあきらめる
  }
}

function applySettingsToForm() {
  els.endpointInput.value = state.settings.endpoint;
  els.modelInput.value = state.settings.model;
  els.apiKeyInput.value = state.settings.apiKey;
}

function readSettingsFromForm() {
  state.settings = {
    endpoint: els.endpointInput.value.trim() || DEFAULTS.endpoint,
    model: els.modelInput.value.trim() || DEFAULTS.model,
    apiKey: els.apiKeyInput.value,
  };
  saveSettings();
}

// --- 質問の読み込み -----------------------------------------------------------

async function loadQuestions() {
  state.questions = await fetch("questions.json").then((r) => r.json());
}

// --- カメラ --------------------------------------------------------------------

async function startCamera() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    els.video.srcObject = state.stream;
    await els.video.play();
    els.cameraPlaceholder.classList.add("hidden");
    startAnalyzeLoop();
  } catch (e) {
    els.resultStatus.textContent = "カメラを開始できませんでした: " + (e && e.message ? e.message : e);
  }
}

// --- 端末内での静止判定ループ(docs/analyze.jsの純関数を再利用) ----------------

let analyzeCanvas, analyzeCtx, smallCanvas, smallCtx;

function ensureOffscreenCanvases() {
  if (!analyzeCanvas) {
    analyzeCanvas = document.createElement("canvas");
    analyzeCtx = analyzeCanvas.getContext("2d", { willReadFrequently: true });
  }
  if (!smallCanvas) {
    smallCanvas = document.createElement("canvas");
    smallCtx = smallCanvas.getContext("2d", { willReadFrequently: true });
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
  const imageData = analyzeCtx.getImageData(0, 0, w, h);
  const gray = toGrayscale(imageData.data);

  const diff = frameDiff(state.prevAnalyzeGray, gray);
  state.prevAnalyzeGray = gray;
  const isStill = state.stillnessTracker.update(diff);
  state.isMoving = !isStill;
  updateStillnessUI(isStill);
  updateResultStaleUI();

  if (isStill && els.autoSendToggle.checked && !state.sending) {
    maybeSendJudgement("auto");
  }
}

function updateStillnessUI(isStill) {
  els.stillnessBadge.textContent = isStill ? "静止" : "静止待ち";
  els.stillnessBadge.classList.toggle("still", isStill);
}

function updateResultStaleUI() {
  els.resultPanel.classList.toggle("stale", state.isMoving && !!state.lastResult);
}

// --- 判定リクエストの送信 ------------------------------------------------------

function downscaleGray(width) {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw) return null;
  const h = Math.max(1, Math.round((width * vh) / vw));
  smallCanvas.width = width;
  smallCanvas.height = h;
  smallCtx.drawImage(els.video, 0, 0, width, h);
  const data = smallCtx.getImageData(0, 0, width, h).data;
  return toGrayscale(data);
}

function captureDataUrl() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  const cap = document.createElement("canvas");
  cap.width = w;
  cap.height = h;
  cap.getContext("2d").drawImage(els.video, 0, 0, w, h);
  return cap.toDataURL("image/jpeg", JPEG_QUALITY);
}

async function maybeSendJudgement(trigger) {
  if (state.sending) return;
  if (!els.video.videoWidth) return;

  const now = Date.now();
  if (now - state.lastSentAt < MIN_SEND_INTERVAL_MS) return;

  const smallGray = downscaleGray(SMALL_DIFF_WIDTH);
  if (state.lastSentSmallGray && smallGray) {
    const d = frameDiff(state.lastSentSmallGray, smallGray);
    if (d < RESEND_DIFF_THRESHOLD && trigger === "auto") {
      return; // 前回送信からほぼ変化なし
    }
  }

  await sendJudgement(smallGray);
}

async function sendJudgement(smallGray) {
  state.sending = true;
  state.sendSeq += 1;
  const mySeq = state.sendSeq;
  state.latestSendSeq = mySeq;
  els.judgeNowBtn.disabled = true;

  const t0 = performance.now();
  try {
    let raw;
    if (state.mockMode) {
      raw = await mockRequest();
    } else {
      const dataUrl = captureDataUrl();
      raw = await realRequest(dataUrl);
    }
    const elapsedMs = performance.now() - t0;

    if (mySeq !== state.latestSendSeq) {
      return; // より新しい送信が既に走っている場合は破棄する
    }

    state.lastSentAt = Date.now();
    state.lastSentSmallGray = smallGray;

    const parsed = parseAngleAnswers(raw);
    parsed.elapsedMs = elapsedMs;
    const guidance = buildAngleGuidance(parsed);
    state.lastResult = parsed;

    appendLog(parsed, guidance);
    renderResult(parsed, guidance);
  } catch (e) {
    if (mySeq === state.latestSendSeq) {
      els.resultStatus.textContent = "判定に失敗しました: " + (e && e.message ? e.message : e);
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

async function realRequest(dataUrl) {
  const body = JSON.stringify({
    model: state.settings.model,
    state: "Look at the photo.",
    images: [dataUrl],
    questions: state.questions,
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
      if (e instanceof HttpError) break; // HTTPエラー応答は再送しない(既存ページと同じ方針)
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

function randChoice(keys) {
  return keys[Math.floor(Math.random() * keys.length)];
}

function fakeChoiceAnswer(keys, picked) {
  const probs = {};
  let remaining = 1;
  keys.forEach((k, i) => {
    if (k === picked) return;
    const p = i === keys.length - 1 ? remaining : Math.random() * remaining * 0.5;
    probs[k] = p;
    remaining -= p;
  });
  probs[picked] = Math.min(1, Math.max(ANGLE_PROB_THRESHOLD, remaining + Math.random() * 0.3));
  return { type: "choice", choice: picked, probabilities: probs, confidence: probs[picked] };
}

async function mockRequest() {
  // ネットワークを呼ばず、questions.jsonの選択肢からランダムな疑似応答を作る。
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
  const cameraKeys = Object.keys(state.questions.camera_angle.criteria);
  const recommendedKeys = Object.keys(state.questions.recommended_angle.criteria);
  const camera = randChoice(cameraKeys);
  const recommended = randChoice(recommendedKeys);

  return {
    model: "mock",
    answers: {
      camera_angle: fakeChoiceAnswer(cameraKeys, camera),
      recommended_angle: fakeChoiceAnswer(recommendedKeys, recommended),
    },
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// --- 結果表示 ------------------------------------------------------------------

function formatChoiceLabel(key, criteria) {
  if (!key) return "不明";
  return (criteria && criteria[key]) || key;
}

function renderResult(parsed, guidance) {
  els.resultPanel.classList.remove("stale");
  els.resultStatus.textContent = "判定結果";

  const cameraCriteria = state.questions ? state.questions.camera_angle.criteria : {};
  const recommendedCriteria = state.questions ? state.questions.recommended_angle.criteria : {};

  els.cameraAngleValue.textContent =
    parsed.cameraAngle !== null
      ? `${formatChoiceLabel(parsed.cameraAngle, cameraCriteria)} (${(parsed.cameraAngleProb * 100).toFixed(0)}%)`
      : "不明";
  els.recommendedAngleValue.textContent =
    parsed.recommendedAngle !== null
      ? `${formatChoiceLabel(parsed.recommendedAngle, recommendedCriteria)} (${(parsed.recommendedAngleProb * 100).toFixed(0)}%)`
      : "不明";

  els.guidanceMessage.textContent = guidance.message;
  els.guidanceMessage.classList.toggle("match", guidance.status === "match");
  els.guidanceMessage.classList.toggle("mismatch", guidance.status === "mismatch");
  els.guidanceMessage.classList.toggle("unknown", guidance.status === "unknown");

  const metaParts = [];
  if (typeof parsed.elapsedMs === "number") metaParts.push(`応答時間: ${Math.round(parsed.elapsedMs)}ms`);
  if (parsed.usage.inputTokens !== null) metaParts.push(`input_tokens: ${parsed.usage.inputTokens}`);
  els.resultMeta.textContent = metaParts.join(" / ");
}

// --- ログ(このページ専用。サムネイル・元画像は保存しない) ----------------------

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

function appendLog(parsed, guidance) {
  const log = loadLog();
  log.push({
    time: new Date().toISOString(),
    cameraAngle: parsed.cameraAngle,
    cameraAngleProb: parsed.cameraAngleProb,
    recommendedAngle: parsed.recommendedAngle,
    recommendedAngleProb: parsed.recommendedAngleProb,
    matched: guidance.status === "match",
    responseMs: typeof parsed.elapsedMs === "number" ? Math.round(parsed.elapsedMs) : null,
    inputTokens: parsed.usage.inputTokens,
  });
  saveLog(log);
  updateLogCount();
}

function updateLogCount() {
  els.logCount.textContent = `記録: ${loadLog().length}件`;
}

function exportLog() {
  const log = loadLog();
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hae-angle-log-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- 初期化 ---------------------------------------------------------------------

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

  els.judgeNowBtn.addEventListener("click", () => maybeSendJudgement("manual"));
  els.exportLogBtn.addEventListener("click", exportLog);
}

async function init() {
  cacheEls();

  const params = new URLSearchParams(location.search);
  state.mockMode = params.get("mock") === "1";

  applySettingsToForm();
  wireEvents();
  updateLogCount();

  await loadQuestions();
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", init);
}

// テストや将来の拡張のために公開しておく(ブラウザ実行には影響しない)。
export { state };
