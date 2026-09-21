// guide.js: DOMに依存しない純関数群(テンプレート選択・指示文生成・レスポンス解釈)。
//
// - parseAnswers(raw): APIの生レスポンスを画面表示・ガイド計算用の形に整形する
// - cellToRC(cell): 9マス名を {row, col} (0-2) に変換する
// - buildActiveQuestions(defs, setKeys): 質問定義(defs.json)から質問セット(sets.json)の
//   キーだけを取り出してリクエスト用questionsを組み立てる
// - buildTemplateMatchQuestion(templates): テンプレート一覧からサーバーに送る「どのテンプレートに
//   一番近いか」を選ばせるchoice型の質問を組み立てる
// - expectedCell(probabilities) / pickCurrentCell(expected, previousCell): subject_posの
//   確率分布から連続的な期待座標を求め、ヒステリシス付きで現在マスを決める
// - selectTemplate(templates, scene, pos): シーン・現在位置から最適なテンプレートを選ぶ(自動選択)
// - resolveTemplate(templates, opts): 手動選択・自動選択・サーバー判定(template_match)の
//   優先順位でテンプレートを1つに決める
// - buildInstruction(template, pos, size): テンプレートと現在の位置・大きさから指示文を作る
// - collectProbabilities(answers, keys): ログ用に、choice/score型の全probabilitiesを
//   小数3桁に丸めて集める

export const CELL_ORDER = [
  "top_left", "top_center", "top_right",
  "mid_left", "center", "mid_right",
  "bottom_left", "bottom_center", "bottom_right",
];

// choice型の確率がこの値未満なら「不明」として扱う。
export const CONFIDENCE_THRESHOLD = 0.4;

// 期待座標と前回マスの距離がこの値以下ならマスを切り替えない(ヒステリシス、仮値)。
export const CELL_HYSTERESIS = 0.65;

export function cellToRC(cell) {
  const idx = CELL_ORDER.indexOf(cell);
  if (idx === -1) return null;
  return { row: Math.floor(idx / 3), col: idx % 3 };
}

export function round3(x) {
  if (typeof x !== "number" || Number.isNaN(x)) return x;
  return Math.round(x * 1000) / 1000;
}

// choice型の応答から、選択肢とその確率(probabilities[choice])を、しきい値を掛けずに取り出す。
function readChoiceRaw(answer) {
  if (!answer || answer.type !== "choice") {
    return { choice: null, prob: null };
  }
  const raw = answer.choice;
  const prob =
    answer.probabilities && typeof answer.probabilities[raw] === "number"
      ? answer.probabilities[raw]
      : null;
  return { choice: raw === undefined ? null : raw, prob };
}

// choice型の応答から、選択肢とその確率(probabilities[choice])を取り出す。
// 確率がしきい値未満なら choice を null にして「不明」を表す。
function readChoice(answer) {
  const { choice, prob } = readChoiceRaw(answer);
  if (prob === null || prob < CONFIDENCE_THRESHOLD) {
    return { choice: null, prob };
  }
  return { choice, prob };
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

function readProbabilitiesDict(answer) {
  if (!answer || !answer.probabilities || typeof answer.probabilities !== "object") {
    return null;
  }
  return answer.probabilities;
}

// raw: { model, answers: {...}, usage }
// main_problem/subject_cut/distraction/backlight は質問セットB/Cで追加した項目で、
// hae_photoでは確認されていない(仕様: 未確認の追加項目)。回答に該当キーが無い・型が違う・
// 値が範囲外の場合は、readChoice/readScore/readNoulがそれぞれnullを返すため例外にはならない。
export function parseAnswers(raw) {
  const answers = (raw && raw.answers) || {};
  const usage = (raw && raw.usage) || {};

  const scene = readChoice(answers.scene);
  const subjectPos = readChoice(answers.subject_pos);
  const templateMatch = readChoice(answers.template_match);
  const skillLevel = readChoice(answers.skill_level);
  const mainProblem = readChoice(answers.main_problem);
  const mainProblemRaw = readChoiceRaw(answers.main_problem);

  return {
    scene: scene.choice,
    sceneProb: scene.prob,
    subjectPos: subjectPos.choice,
    subjectPosProb: subjectPos.prob,
    // しきい値を掛けていない生の確率分布(9マス分)。expectedCell()に渡して連続座標を計算する。
    subjectPosDistribution: readProbabilitiesDict(answers.subject_pos),
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
    mainProblem: mainProblem.choice,
    mainProblemProb: mainProblem.prob,
    // しきい値未満でも捨てない生の選択値。指示エンジンでserver:noulとの重複判定に使う。
    mainProblemRaw: mainProblemRaw.choice,
    subjectCut: readNoul(answers.subject_cut),
    distraction: readNoul(answers.distraction),
    backlight: readNoul(answers.backlight),
    usage: {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
    },
    model: (raw && raw.model) || null,
  };
}

// 質問定義(docs/questions/defs.json)から、質問セット(docs/questions/sets.jsonの
// キー配列、例: ["scene","subject_pos",...])に含まれるものだけを取り出す。
// defsに無いキーは無視する(型違い・未定義への耐性)。
export function buildActiveQuestions(defs, setKeys) {
  const out = {};
  for (const key of setKeys || []) {
    if (defs && defs[key]) out[key] = defs[key];
  }
  return out;
}

// ログ記録用に、choice/score型の各質問について応答のprobabilities一式を
// 小数3桁に丸めて集める(仕様: 「choiceの全probabilities、scoreのprobabilities」)。
export function collectProbabilities(answers, keys) {
  const out = {};
  for (const key of keys || []) {
    const dict = answers ? readProbabilitiesDict(answers[key]) : null;
    if (!dict) continue;
    const rounded = {};
    for (const [k, v] of Object.entries(dict)) {
      rounded[k] = typeof v === "number" ? round3(v) : v;
    }
    out[key] = rounded;
  }
  return out;
}

// subject_posの確率分布(9マス、キーはCELL_ORDER)から、列(left=0,center=1,right=2)・
// 行(top=0,mid=1,bottom=2)の期待値(0〜2の実数)を求める。分布が無い/合計0ならnull。
export function expectedCell(probabilities) {
  if (!probabilities || typeof probabilities !== "object") return null;
  let total = 0;
  let colSum = 0;
  let rowSum = 0;
  for (const cell of CELL_ORDER) {
    const p = probabilities[cell];
    if (typeof p !== "number" || Number.isNaN(p)) continue;
    const rc = cellToRC(cell);
    total += p;
    colSum += p * rc.col;
    rowSum += p * rc.row;
  }
  if (total <= 0) return null;
  return { col: colSum / total, row: rowSum / total };
}

// 期待座標(expectedCell)から現在マスを1つ決める。前回のマス(previousCell)の座標との
// 距離がCELL_HYSTERESIS以下ならマスを切り替えず前回の値を維持する(チラつき防止、仮値)。
// expectedがnullならprevious Cellをそのまま返す(仕様: 不明時の扱いは現行どおり=呼び出し側で
// subjectPosがnullのときは事前にpreviousCellをnullにリセットしてから呼ぶ想定)。
export function pickCurrentCell(expected, previousCell = null) {
  if (!expected) return previousCell;
  const prevRC = previousCell ? cellToRC(previousCell) : null;
  if (prevRC) {
    const dist = Math.hypot(expected.col - prevRC.col, expected.row - prevRC.row);
    if (dist <= CELL_HYSTERESIS) return previousCell;
  }
  const col = Math.min(2, Math.max(0, Math.round(expected.col)));
  const row = Math.min(2, Math.max(0, Math.round(expected.row)));
  return CELL_ORDER[row * 3 + col];
}

// テンプレート一覧(docs/templates.json)から、APIに送る「どのテンプレートに一番近いか」を
// 選ばせるchoice型の質問を組み立てる。テンプレートは運用中に増減し得るため、
// questions/defs.jsonに固定せずリクエストのたびにここで生成する。
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
// 2. 自動選択(scene・posからのselectTemplateによる決定的な推定)
// 3. サーバー判定(templateMatchId、APIのtemplate_matchの回答。設定でONのときだけ
//    呼び出し側がtemplateMatchIdを渡す想定)
// manualIdが指すテンプレートが見つからない場合、自動選択が候補を出せない場合、それぞれ
// 次の優先度にフォールバックする。
//
// 【変更】以前はサーバー判定(2)が自動選択(3)より優先されていたが、template_matchは
// hae_photoで未確認の実験的な項目であるため、決定的に計算できる自動選択を優先するよう
// 順序を変更した(仕様: 「手動テンプレート > 決定的選択 > サーバーのtemplate_match」)。
export function resolveTemplate(templates, { manualId = null, templateMatchId = null, scene = null, pos = null } = {}) {
  if (manualId) {
    const found = (templates || []).find((t) => t.id === manualId);
    if (found) return found;
  }
  const auto = selectTemplate(templates, scene, pos);
  if (auto) return auto;
  if (templateMatchId) {
    const found = (templates || []).find((t) => t.id === templateMatchId);
    if (found) return found;
  }
  return null;
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
