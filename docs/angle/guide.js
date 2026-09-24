// guide.js (angle実験専用): DOMに依存しない純関数群。
// - parseAngleAnswers: APIの生レスポンス(camera_angle/recommended_angleのみ)を解釈する
// - buildAngleGuidance: 現在アングルと推奨アングルから、表示する指示文を決める
//
// 未検証のAPI仕様に対する防御的実装: キー欠如・型不一致・確率欠如/範囲外は
// 例外を投げず「不明」として扱う。

// choiceの確率がこの値未満なら「不明」として扱う(docs/guide.jsのCONFIDENCE_THRESHOLDと同じ考え方)
export const ANGLE_PROB_THRESHOLD = 0.4;

function pickChoiceAngle(answer) {
  if (!answer || typeof answer !== "object" || answer.type !== "choice") {
    return { choice: null, prob: null };
  }
  const choice = typeof answer.choice === "string" ? answer.choice : null;
  const probs = answer.probabilities;
  const rawProb =
    choice && probs && typeof probs === "object" ? probs[choice] : undefined;
  const prob = typeof rawProb === "number" && !Number.isNaN(rawProb) ? rawProb : null;
  return { choice, prob };
}

// APIレスポンス全体(raw)を受け取り、表示に使う形に整形する。
// raw: { model, answers: { camera_angle, recommended_angle }, usage }
export function parseAngleAnswers(raw) {
  const answers = (raw && typeof raw === "object" && raw.answers) || {};
  const usage = (raw && typeof raw === "object" && raw.usage) || {};

  const cam = pickChoiceAngle(answers.camera_angle);
  const rec = pickChoiceAngle(answers.recommended_angle);

  return {
    cameraAngle: cam.choice,
    cameraAngleProb: cam.prob,
    recommendedAngle: rec.choice,
    recommendedAngleProb: rec.prob,
    usage: {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
    },
    model: (raw && typeof raw === "object" && raw.model) || null,
  };
}

// recommended_angleごとの、現在アングルに応じた指示文の対応表。
// (仕様書の3パターンをそのまま表にしたもの)
const MISMATCH_RULES = [
  {
    recommended: "low_angle",
    current: ["high_angle", "eye_level"],
    message: "もっと低い位置から撮ってみてください（しゃがむ、地面に近づける）",
  },
  {
    recommended: "high_angle",
    current: ["low_angle", "eye_level"],
    message: "もっと高い位置から見下ろして撮ってみてください",
  },
  {
    recommended: "eye_level",
    current: ["high_angle", "low_angle"],
    message: "被写体と同じ高さまでカメラを動かしてください",
  },
];

// parsed(parseAngleAnswersの戻り値)から、画面に出す指示を決める。
// 戻り値: { status: "unknown" | "match" | "mismatch", message: string }
export function buildAngleGuidance(parsed) {
  const cameraAngle = parsed ? parsed.cameraAngle : null;
  const cameraAngleProb = parsed ? parsed.cameraAngleProb : null;
  const recommendedAngle = parsed ? parsed.recommendedAngle : null;
  const recommendedAngleProb = parsed ? parsed.recommendedAngleProb : null;

  const cameraUnknown =
    !cameraAngle || cameraAngleProb === null || cameraAngleProb < ANGLE_PROB_THRESHOLD;
  const recommendedUnknown =
    !recommendedAngle ||
    recommendedAngleProb === null ||
    recommendedAngleProb < ANGLE_PROB_THRESHOLD;

  if (cameraUnknown || recommendedUnknown) {
    return { status: "unknown", message: "アングルの判定ができませんでした" };
  }

  if (recommendedAngle === "current_is_fine" || recommendedAngle === cameraAngle) {
    return { status: "match", message: "今のアングルのままでよい" };
  }

  const rule = MISMATCH_RULES.find(
    (r) => r.recommended === recommendedAngle && r.current.includes(cameraAngle)
  );
  if (rule) {
    return { status: "mismatch", message: rule.message };
  }

  // 対応表に無い組み合わせ(想定外の選択肢値など)はクラッシュさせず不明として扱う
  return { status: "unknown", message: "アングルの判定ができませんでした" };
}
