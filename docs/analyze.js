// analyze.js: 端末内だけで完結する画質・水平・静止判定の指標計算。
// DOM/カメラには依存しない。呼び出し側でCanvasから取り出したImageData由来の
// 配列(RGBA / グレースケール)を渡して使う純関数群。

export function clamp01(x) {
  if (typeof x !== "number" || Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// ImageData.data (Uint8ClampedArray, RGBA) からグレースケール配列を作る。
export function toGrayscale(rgba) {
  const n = rgba.length / 4;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    gray[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
  return gray;
}

// ラプラシアン分散(ブレの指標)。値が大きいほどエッジがはっきりしている=鮮明。
export function laplacianVariance(gray, width, height) {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const v =
        -4 * gray[idx] +
        gray[idx - 1] +
        gray[idx + 1] +
        gray[idx - width] +
        gray[idx + width];
      sum += v;
      sumSq += v * v;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

// score = clamp((log10(v+1)-1.0)/1.6) * 100
export function blurScore(variance) {
  const v = Math.max(0, variance);
  return clamp01((Math.log10(v + 1) - 1.0) / 1.6) * 100;
}

// 平均輝度mと、黒つぶれ(<12)/白飛び(>243)の割合cを求める。
export function brightnessMetrics(gray) {
  let sum = 0;
  let clipped = 0;
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    sum += v;
    if (v < 12 || v > 243) clipped++;
  }
  const mean = gray.length ? sum / gray.length : 0;
  const clippedRatio = gray.length ? clipped / gray.length : 0;
  return { mean, clippedRatio };
}

// score = 100 - clamp((|m-125|-25)/100)*60 - clamp(c/0.25)*40
export function brightnessScore(mean, clippedRatio) {
  const meanPenalty = clamp01((Math.abs(mean - 125) - 25) / 100) * 60;
  const clipPenalty = clamp01(clippedRatio / 0.25) * 40;
  return 100 - meanPenalty - clipPenalty;
}

// devicemotionのaccelerationIncludingGravityから傾き角(度)を求める。
export function rollFromAcceleration(ax, ay) {
  return (Math.atan2(ax, ay) * 180) / Math.PI;
}

// roll(度)から、最も近い90°の倍数からの偏差t(度)を求める。
export function deviationFromLevel(rollDeg) {
  const nearest90 = Math.round(rollDeg / 90) * 90;
  return rollDeg - nearest90;
}

// score = clamp(1-(|t|-1)/7) * 100
export function levelScore(rollDeg) {
  const t = deviationFromLevel(rollDeg);
  return clamp01(1 - (Math.abs(t) - 1) / 7) * 100;
}

// 連続フレーム間の平均絶対差。サイズが違う/前フレームが無い場合はInfinity。
export function frameDiff(prevGray, currGray) {
  if (!prevGray || !currGray || prevGray.length !== currGray.length || prevGray.length === 0) {
    return Infinity;
  }
  let sum = 0;
  for (let i = 0; i < currGray.length; i++) {
    sum += Math.abs(currGray[i] - prevGray[i]);
  }
  return sum / currGray.length;
}

// 静止判定: 平均絶対差がthreshold未満のフレームがrequiredFrames回連続したらtrue。
export function createStillnessTracker(threshold = 3, requiredFrames = 6) {
  let streak = 0;
  return {
    update(diff) {
      streak = diff < threshold ? streak + 1 : 0;
      return streak >= requiredFrames;
    },
    reset() {
      streak = 0;
    },
    get streak() {
      return streak;
    },
  };
}

// ピンチ操作の指2点間の距離(px)を求める。touches は {clientX, clientY} を持つ要素2つ以上の配列。
export function touchDistance(touches) {
  if (!touches || touches.length < 2) return null;
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

// ピンチ開始時からの指の距離比に応じてズーム値を計算し、min〜maxにclampする。
export function zoomFromPinch(startDistance, currentDistance, startZoom, min, max) {
  if (!startDistance || startDistance <= 0 || typeof startZoom !== "number") return startZoom;
  const ratio = currentDistance / startDistance;
  return Math.min(max, Math.max(min, startZoom * ratio));
}

// 指数移動平均(EMA)。alpha=0.35を既定とする。
export function createEma(alpha = 0.35) {
  let value = null;
  return {
    update(x) {
      if (typeof x !== "number" || Number.isNaN(x)) return value;
      value = value === null ? x : alpha * x + (1 - alpha) * value;
      return value;
    },
    get() {
      return value;
    },
    reset() {
      value = null;
    },
  };
}
