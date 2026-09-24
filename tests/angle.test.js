import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseAngleAnswers,
  buildAngleGuidance,
  ANGLE_PROB_THRESHOLD,
} from "../docs/angle/guide.js";

// --- parseAngleAnswers -------------------------------------------------------

test("parseAngleAnswers: 正常なレスポンスを解釈できる", () => {
  const raw = {
    model: "openjev-latest",
    answers: {
      camera_angle: {
        type: "choice",
        choice: "eye_level",
        probabilities: { high_angle: 0.1, eye_level: 0.8, low_angle: 0.1 },
        confidence: 0.7,
      },
      recommended_angle: {
        type: "choice",
        choice: "low_angle",
        probabilities: { high_angle: 0.05, eye_level: 0.15, low_angle: 0.7, current_is_fine: 0.1 },
        confidence: 0.6,
      },
    },
    usage: { input_tokens: 123, output_tokens: 0 },
  };
  const parsed = parseAngleAnswers(raw);
  assert.equal(parsed.cameraAngle, "eye_level");
  assert.equal(parsed.cameraAngleProb, 0.8);
  assert.equal(parsed.recommendedAngle, "low_angle");
  assert.equal(parsed.recommendedAngleProb, 0.7);
  assert.equal(parsed.usage.inputTokens, 123);
});

test("parseAngleAnswers: answersが無い/nullでも例外を投げず不明を返す", () => {
  assert.doesNotThrow(() => parseAngleAnswers(null));
  assert.doesNotThrow(() => parseAngleAnswers({}));
  const parsed = parseAngleAnswers({});
  assert.equal(parsed.cameraAngle, null);
  assert.equal(parsed.cameraAngleProb, null);
  assert.equal(parsed.recommendedAngle, null);
  assert.equal(parsed.usage.inputTokens, null);
});

test("parseAngleAnswers: キーが欠如していても不明として扱う", () => {
  const raw = { answers: {}, usage: {} };
  const parsed = parseAngleAnswers(raw);
  assert.equal(parsed.cameraAngle, null);
  assert.equal(parsed.recommendedAngle, null);
});

test("parseAngleAnswers: typeが期待と異なる(choiceでない)場合は不明として扱う", () => {
  const raw = {
    answers: {
      camera_angle: { type: "score", score: 2.0 },
      recommended_angle: { type: "noul", noul: 0.5 },
    },
    usage: {},
  };
  const parsed = parseAngleAnswers(raw);
  assert.equal(parsed.cameraAngle, null);
  assert.equal(parsed.recommendedAngle, null);
});

test("parseAngleAnswers: probabilitiesが無い/choiceに対応する確率が無い場合は確率null", () => {
  const raw = {
    answers: {
      camera_angle: { type: "choice", choice: "eye_level" },
      recommended_angle: { type: "choice", choice: "low_angle", probabilities: { high_angle: 0.9 } },
    },
    usage: {},
  };
  const parsed = parseAngleAnswers(raw);
  assert.equal(parsed.cameraAngle, "eye_level");
  assert.equal(parsed.cameraAngleProb, null);
  assert.equal(parsed.recommendedAngle, "low_angle");
  assert.equal(parsed.recommendedAngleProb, null, "low_angleの確率が無いのでnull");
});

test("parseAngleAnswers: usageが数値でない/欠如していてもクラッシュしない", () => {
  const raw = { answers: {}, usage: { input_tokens: "abc" } };
  const parsed = parseAngleAnswers(raw);
  assert.equal(parsed.usage.inputTokens, null);
  assert.equal(parsed.usage.outputTokens, null);
});

// --- buildAngleGuidance -------------------------------------------------------

function makeParsed(cameraAngle, cameraProb, recommendedAngle, recommendedProb) {
  return {
    cameraAngle,
    cameraAngleProb: cameraProb,
    recommendedAngle,
    recommendedAngleProb: recommendedProb,
  };
}

test("buildAngleGuidance: camera_angle == recommended_angle なら一致(match)", () => {
  const r = buildAngleGuidance(makeParsed("eye_level", 0.9, "eye_level", 0.9));
  assert.equal(r.status, "match");
  assert.equal(r.message, "今のアングルのままでよい");
});

test("buildAngleGuidance: recommended_angle が current_is_fine なら一致(match)", () => {
  const r = buildAngleGuidance(makeParsed("high_angle", 0.9, "current_is_fine", 0.9));
  assert.equal(r.status, "match");
  assert.equal(r.message, "今のアングルのままでよい");
});

test("buildAngleGuidance: low_angle推奨・現状high_angle は低い位置からの指示", () => {
  const r = buildAngleGuidance(makeParsed("high_angle", 0.9, "low_angle", 0.9));
  assert.equal(r.status, "mismatch");
  assert.equal(r.message, "もっと低い位置から撮ってみてください（しゃがむ、地面に近づける）");
});

test("buildAngleGuidance: low_angle推奨・現状eye_level は低い位置からの指示", () => {
  const r = buildAngleGuidance(makeParsed("eye_level", 0.9, "low_angle", 0.9));
  assert.equal(r.status, "mismatch");
  assert.equal(r.message, "もっと低い位置から撮ってみてください（しゃがむ、地面に近づける）");
});

test("buildAngleGuidance: high_angle推奨・現状low_angle は高い位置からの指示", () => {
  const r = buildAngleGuidance(makeParsed("low_angle", 0.9, "high_angle", 0.9));
  assert.equal(r.status, "mismatch");
  assert.equal(r.message, "もっと高い位置から見下ろして撮ってみてください");
});

test("buildAngleGuidance: high_angle推奨・現状eye_level は高い位置からの指示", () => {
  const r = buildAngleGuidance(makeParsed("eye_level", 0.9, "high_angle", 0.9));
  assert.equal(r.status, "mismatch");
  assert.equal(r.message, "もっと高い位置から見下ろして撮ってみてください");
});

test("buildAngleGuidance: eye_level推奨・現状high_angle は同じ高さへの指示", () => {
  const r = buildAngleGuidance(makeParsed("high_angle", 0.9, "eye_level", 0.9));
  assert.equal(r.status, "mismatch");
  assert.equal(r.message, "被写体と同じ高さまでカメラを動かしてください");
});

test("buildAngleGuidance: eye_level推奨・現状low_angle は同じ高さへの指示", () => {
  const r = buildAngleGuidance(makeParsed("low_angle", 0.9, "eye_level", 0.9));
  assert.equal(r.status, "mismatch");
  assert.equal(r.message, "被写体と同じ高さまでカメラを動かしてください");
});

test(`buildAngleGuidance: camera_angleの確率が${ANGLE_PROB_THRESHOLD}未満なら不明`, () => {
  const r = buildAngleGuidance(makeParsed("eye_level", 0.3, "low_angle", 0.9));
  assert.equal(r.status, "unknown");
  assert.equal(r.message, "アングルの判定ができませんでした");
});

test(`buildAngleGuidance: recommended_angleの確率が${ANGLE_PROB_THRESHOLD}未満なら不明`, () => {
  const r = buildAngleGuidance(makeParsed("eye_level", 0.9, "low_angle", 0.39));
  assert.equal(r.status, "unknown");
});

test("buildAngleGuidance: 確率がちょうど閾値(0.4)なら不明扱いにしない", () => {
  const r = buildAngleGuidance(makeParsed("eye_level", 0.4, "eye_level", 0.4));
  assert.equal(r.status, "match");
});

test("buildAngleGuidance: choiceがnull(未解釈)なら不明", () => {
  const r = buildAngleGuidance(makeParsed(null, null, "low_angle", 0.9));
  assert.equal(r.status, "unknown");
});

test("buildAngleGuidance: parsedがnullでもクラッシュせず不明を返す", () => {
  assert.doesNotThrow(() => buildAngleGuidance(null));
  const r = buildAngleGuidance(null);
  assert.equal(r.status, "unknown");
});

test("buildAngleGuidance: 未知のrecommended_angle値でもクラッシュせず不明を返す", () => {
  const r = buildAngleGuidance(makeParsed("eye_level", 0.9, "diagonal_angle", 0.9));
  assert.equal(r.status, "unknown");
});
