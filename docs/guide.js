// guide.js: DOMに依存しない純関数群(テンプレート選択・指示文生成)。
//
// - parseAnswers(raw): APIの生レスポンスを画面表示・ガイド計算用の形に整形する
// - cellToRC(cell): 9マス名を {row, col} (0-2) に変換する
// - buildTemplateMatchQuestion(templates): テンプレート一覧からサーバーに送る「どのテンプレートに
//   一番近いか」を選ばせるchoice型の質問を組み立てる
// - selectTemplate(templates, scene, pos): シーン・現在位置から最適なテンプレートを選ぶ(自動選択)
// - resolveTemplate(templates, opts): 手動選択・サーバー判定(template_match)・自動選択の
//   優先順位でテンプレートを1つに決める
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

// raw: { model, answers: {scene, subject_pos, subject_size, hae_score, sns_worthy,
//        skill_level, lighting_quality, color_harmony, background_clutter, template_match}, usage }
// template_match は questions.jsonに含まれる固定項目ではなく、送信のたびに
// buildTemplateMatchQuestion() で組み立ててリクエストに含める(仕様: 未確認の追加項目)。
// skill_level/lighting_quality/color_harmony/background_clutter は、映え度以外の判定を
// 精度検証のために追加した項目で、hae_photoでは確認されていない(仕様: 未確認の追加項目)。
export function parseAnswers(raw) {
  const answers = (raw && raw.answers) || {};
  const usage = (raw && raw.usage) || {};

  const scene = readChoice(answers.scene);
  const subjectPos = readChoice(answers.subject_pos);
  const templateMatch = readChoice(answers.template_match);
  const skillLevel = readChoice(answers.skill_level);

  return {
    scene: scene.choice,
    sceneProb: scene.prob,
    subjectPos: subjectPos.choice,
    subjectPosProb: subjectPos.prob,
    subjectSize: readScore(answers.subject_size),
    haeScore: readScore(answers.hae_score),
    snsWorthy: readNoul(answers.sns_worthy),
    templateMatch: templateMatch.choice,
    templateMatchProb: templateMatch.prob,
    skillLevel: skillLevel.choice,
    skillLevelProb: skillLevel.prob,
    lightingQuality: readScore(answers.lighting_quality),
    colorHarmony: readScore(answers.color_harmony),
    backgroundClutter: readScore(answers.background_clutter),
    usage: {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
    },
    model: (raw && raw.model) || null,
  };
}

// テンプレート一覧(docs/templates.json)から、APIに送る「どのテンプレートに一番近いか」を
// 選ばせるchoice型の質問を組み立てる。テンプレートは運用中に増減し得るため、
// questions.jsonに固定せずリクエストのたびにここで生成する。
export function buildTemplateMatchQuestion(templates) {
  const criteria = {};
  for (const t of templates || []) {
    if (t && t.id) criteria[t.id] = t.name || t.id;
  }
  return {
    type: "choice",
    instructions: "この写真の構図に最も近いテンプレートはどれか",
    criteria,
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

// テンプレートを1つに決める。優先順位は
// 1. 手動選択(manualId、チップでの選択)
// 2. サーバー判定(templateMatchId、APIのtemplate_matchの回答)
// 3. 自動選択(scene・posからのselectTemplateによる推定)
// manualId/templateMatchIdが指すテンプレートが見つからない場合は次の優先度にフォールバックする。
export function resolveTemplate(templates, { manualId = null, templateMatchId = null, scene = null, pos = null } = {}) {
  if (manualId) {
    const found = (templates || []).find((t) => t.id === manualId);
    if (found) return found;
  }
  if (templateMatchId) {
    const found = (templates || []).find((t) => t.id === templateMatchId);
    if (found) return found;
  }
  return selectTemplate(templates, scene, pos);
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
