// guide.js: DOMに依存しない純関数群(テンプレート選択・指示文生成)。
//
// - parseAnswers(raw): APIの生レスポンスを画面表示・ガイド計算用の形に整形する
// - cellToRC(cell): 9マス名を {row, col} (0-2) に変換する
// - selectTemplate(templates, scene, pos): シーン・現在位置から最適なテンプレートを選ぶ
// - buildInstruction(template, pos, size): テンプレートと現在の位置・大きさから指示文を作る

export const CELL_ORDER = [
  "top_left", "top_center", "top_right",
  "mid_left", "center", "mid_right",
  "bottom_left", "bottom_center", "bottom_right",
];

// choice型の確率がこの値未満なら「不明」として扱う。
export const CONFIDENCE_THRESHOLD = 0.4;

export function cellToRC(cell) {
  const idx = CELL_ORDER.indexOf(cell);
  if (idx === -1) return null;
  return { row: Math.floor(idx / 3), col: idx % 3 };
}

// choice型の応答から、選択肢とその確率(probabilities[choice])を取り出す。
// 確率がしきい値未満なら choice を null にして「不明」を表す。
function readChoice(answer) {
  if (!answer || answer.type !== "choice") {
    return { choice: null, prob: null };
  }
  const raw = answer.choice;
  const prob =
    answer.probabilities && typeof answer.probabilities[raw] === "number"
      ? answer.probabilities[raw]
      : null;
  if (prob === null || prob < CONFIDENCE_THRESHOLD) {
    return { choice: null, prob };
  }
  return { choice: raw, prob };
}

function readScore(answer) {
  if (!answer || answer.type !== "score" || typeof answer.score !== "number") {
    return null;
  }
  return answer.score;
}

function readNoul(answer) {
  if (!answer || answer.type !== "noul" || typeof answer.noul !== "number") {
    return null;
  }
  return answer.noul;
}

// raw: { model, answers: {scene, subject_pos, subject_size, hae_score, sns_worthy}, usage }
export function parseAnswers(raw) {
  const answers = (raw && raw.answers) || {};
  const usage = (raw && raw.usage) || {};

  const scene = readChoice(answers.scene);
  const subjectPos = readChoice(answers.subject_pos);

  return {
    scene: scene.choice,
    sceneProb: scene.prob,
    subjectPos: subjectPos.choice,
    subjectPosProb: subjectPos.prob,
    subjectSize: readScore(answers.subject_size),
    haeScore: readScore(answers.hae_score),
    snsWorthy: readNoul(answers.sns_worthy),
    usage: {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
    },
    model: (raw && raw.model) || null,
  };
}

// scenesが一致するテンプレートのうち、現在の9マス位置(pos)からの
// マンハッタン距離が最小のものを選ぶ。同点はpriorityが大きい方。
// posが不明(null)な場合は距離が計算できないため、priorityが最大のものを選ぶ。
export function selectTemplate(templates, scene, pos) {
  if (!scene || !Array.isArray(templates)) return null;

  const candidates = templates.filter(
    (t) => Array.isArray(t.scenes) && t.scenes.includes(scene)
  );
  if (candidates.length === 0) return null;

  const currentRC = pos ? cellToRC(pos) : null;
  if (!currentRC) {
    return candidates.reduce(
      (best, t) => (!best || t.priority > best.priority ? t : best),
      null
    );
  }

  let best = null;
  let bestDist = Infinity;
  for (const t of candidates) {
    const targetRC = cellToRC(t.target && t.target.cell);
    if (!targetRC) continue;
    const dist =
      Math.abs(targetRC.row - currentRC.row) + Math.abs(targetRC.col - currentRC.col);
    if (dist < bestDist || (dist === bestDist && best && t.priority > best.priority)) {
      best = t;
      bestDist = dist;
    }
  }
  return best;
}

// template・現在の被写体位置(pos)・大きさの期待値(size)から指示文を作る。
// 戻り値: { achieved, message, dx, dy, sizeDir, positionUnknown }
export function buildInstruction(template, pos, size) {
  if (!template) {
    return {
      achieved: false,
      message: "被写体の種類を判定できませんでした。テンプレートを手動で選んでください。",
      dx: null,
      dy: null,
      sizeDir: null,
      positionUnknown: true,
    };
  }

  const currentRC = pos ? cellToRC(pos) : null;
  const targetRC = template.target ? cellToRC(template.target.cell) : null;
  if (!currentRC || !targetRC) {
    return {
      achieved: false,
      message: template.instruction,
      dx: null,
      dy: null,
      sizeDir: null,
      positionUnknown: true,
    };
  }

  const dx = targetRC.col - currentRC.col;
  const dy = targetRC.row - currentRC.row;
  const parts = [];

  if (dx < 0) parts.push("被写体を画面の左へ寄せる(カメラを右へ振る)");
  if (dx > 0) parts.push("被写体を画面の右へ寄せる(カメラを左へ振る)");
  if (dy < 0) parts.push("被写体を画面の上へ寄せる(カメラを下へ傾ける)");
  if (dy > 0) parts.push("被写体を画面の下へ寄せる(カメラを上へ傾ける)");

  let sizeDir = null;
  const sizeRange = template.target ? template.target.size : null;
  if (Array.isArray(sizeRange) && typeof size === "number") {
    const [min, max] = sizeRange;
    if (size < min - 0.5) {
      sizeDir = "closer";
      parts.push("被写体に近づく");
    } else if (size > max + 0.5) {
      sizeDir = "farther";
      parts.push("被写体から離れる");
    }
  }

  if (parts.length === 0) {
    return {
      achieved: true,
      message: "この構図で撮影",
      dx,
      dy,
      sizeDir,
      positionUnknown: false,
    };
  }

  return {
    achieved: false,
    message: parts.join("、"),
    dx,
    dy,
    sizeDir,
    positionUnknown: false,
  };
}
