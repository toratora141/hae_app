import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  evaluateInstruction,
  isInstructionAchieved,
  createInstructionSwitcher,
} from "../docs/instructions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(
  readFileSync(path.join(__dirname, "..", "docs", "instruction_rules.json"), "utf-8")
);

function baseContext(overrides = {}) {
  return {
    isStill: true,
    blurScore: 80,
    brightnessScore: 80,
    hasSensor: true,
    tiltDeg: 0,
    questionSet: "A",
    mainProblem: null,
    mainProblemRaw: null,
    subjectCut: null,
    distraction: null,
    backlight: null,
    compositionResult: { achieved: false, message: "被写体を右へ寄せる" },
    ...overrides,
  };
}

// --- 優先順位 ------------------------------------------------------------------

test("evaluateInstruction: 静止していてブレスコアが低ければdevice:blurが最優先", () => {
  const ctx = baseContext({ blurScore: 10, tiltDeg: 20, brightnessScore: 5, mainProblem: "subject_small" });
  const r = evaluateInstruction(ctx, rules);
  assert.equal(r.id, "device:blur");
});

test("evaluateInstruction: 動いている間はdevice:blurを出さない", () => {
  const ctx = baseContext({ isStill: false, blurScore: 10, tiltDeg: 20 });
  const r = evaluateInstruction(ctx, rules);
  assert.equal(r.id, "device:tilt");
});

test("evaluateInstruction: device:tiltはブレが無ければ2番目に優先され、度数が文言に入る", () => {
  const ctx = baseContext({ tiltDeg: -12, brightnessScore: 5 });
  const r = evaluateInstruction(ctx, rules);
  assert.equal(r.id, "device:tilt");
  assert.match(r.text, /約12°/);
});

test("evaluateInstruction: センサーが無ければdevice:tiltは評価しない", () => {
  const ctx = baseContext({ hasSensor: false, tiltDeg: 90, brightnessScore: 5 });
  const r = evaluateInstruction(ctx, rules);
  assert.equal(r.id, "device:brightness");
});

test("evaluateInstruction: device:brightnessはtilt以下の優先度", () => {
  const ctx = baseContext({ brightnessScore: 5, mainProblem: "subject_small" });
  const r = evaluateInstruction(ctx, rules);
  assert.equal(r.id, "device:brightness");
});

test("evaluateInstruction: server:main_problemはdevice系が無ければ採用される", () => {
  const ctx = baseContext({ mainProblem: "background_busy" });
  const r = evaluateInstruction(ctx, rules);
  assert.equal(r.id, "server:main_problem:background_busy");
  assert.match(r.text, /背景/);
});

test("evaluateInstruction: main_problemがnoneなら採用しない(compositionへ進む)", () => {
  const ctx = baseContext({ mainProblem: "none" });
  const r = evaluateInstruction(ctx, rules);
  assert.equal(r.id, "composition:guide");
});

test("evaluateInstruction: server:noulは質問セットCのときだけ評価する", () => {
  const ctxA = baseContext({ questionSet: "A", subjectCut: 0.9 });
  assert.equal(evaluateInstruction(ctxA, rules).id, "composition:guide");

  const ctxC = baseContext({ questionSet: "C", subjectCut: 0.9 });
  assert.equal(evaluateInstruction(ctxC, rules).id, "server:noul:subject_cut");
});

test("evaluateInstruction: server:noulはmain_problemの生の選択肢と同じ内容なら重複させない", () => {
  const ctx = baseContext({
    questionSet: "C",
    mainProblemRaw: "subject_cut", // main_problem自体は0.4未満で不採用だが、生の選択は subject_cut
    subjectCut: 0.9,
    distraction: 0.9,
  });
  const r = evaluateInstruction(ctx, rules);
  // subject_cutは重複なのでスキップされ、次のdistraction(background_busy)が採用される
  assert.equal(r.id, "server:noul:distraction");
});

test("evaluateInstruction: composition未達成ならcomposition:guideを返す", () => {
  const ctx = baseContext();
  const r = evaluateInstruction(ctx, rules);
  assert.equal(r.id, "composition:guide");
  assert.equal(r.achieved, false);
});

test("evaluateInstruction: composition達成ならdoneを返す", () => {
  const ctx = baseContext({ compositionResult: { achieved: true, message: "この構図で撮影" } });
  const r = evaluateInstruction(ctx, rules);
  assert.equal(r.id, "composition:done");
  assert.equal(r.kind, "done");
  assert.equal(r.achieved, true);
});

// --- isInstructionAchieved -----------------------------------------------------

test("isInstructionAchieved: device:blurはachievedThreshold以上で解消", () => {
  const inst = { id: "device:blur", kind: "device" };
  assert.equal(isInstructionAchieved(inst, { blurScore: 49 }, rules), false);
  assert.equal(isInstructionAchieved(inst, { blurScore: 50 }, rules), true);
});

test("isInstructionAchieved: device:tiltはachievedThresholdDeg未満で解消(符号は問わない)", () => {
  const inst = { id: "device:tilt", kind: "device" };
  assert.equal(isInstructionAchieved(inst, { tiltDeg: -3 }, rules), false);
  assert.equal(isInstructionAchieved(inst, { tiltDeg: 1.9 }, rules), true);
});

test("isInstructionAchieved: server:main_problem:*は値が変われば解消", () => {
  const inst = { id: "server:main_problem:subject_small" };
  assert.equal(isInstructionAchieved(inst, { mainProblem: "subject_small" }, rules), false);
  assert.equal(isInstructionAchieved(inst, { mainProblem: "none" }, rules), true);
  assert.equal(isInstructionAchieved(inst, { mainProblem: null }, rules), true);
});

test("isInstructionAchieved: server:noul:*は確率がしきい値未満になれば解消", () => {
  const inst = { id: "server:noul:backlight" };
  assert.equal(isInstructionAchieved(inst, { backlight: 0.6 }, rules), false);
  assert.equal(isInstructionAchieved(inst, { backlight: 0.4 }, rules), true);
});

test("isInstructionAchieved: doneは常にachieved", () => {
  assert.equal(isInstructionAchieved({ id: "composition:done", kind: "done" }, {}, rules), true);
});

// --- createInstructionSwitcher --------------------------------------------------

test("createInstructionSwitcher: 初回は即座に表示する", () => {
  const sw = createInstructionSwitcher(1500);
  const r = sw.update({ id: "device:blur", kind: "device", text: "a" }, 0);
  assert.equal(r.switched, true);
  assert.equal(r.displayed.id, "device:blur");
  assert.equal(r.previous, null);
});

test("createInstructionSwitcher: 1.5秒未満での切り替えは拑制される", () => {
  const sw = createInstructionSwitcher(1500);
  sw.update({ id: "device:blur", kind: "device", text: "a" }, 0);
  const r = sw.update({ id: "device:tilt", kind: "device", text: "b" }, 1000);
  assert.equal(r.switched, false);
  assert.equal(r.displayed.id, "device:blur");
});

test("createInstructionSwitcher: 1.5秒以上経てば切り替わり、直前の指示と表示開始時刻を返す", () => {
  const sw = createInstructionSwitcher(1500);
  sw.update({ id: "device:blur", kind: "device", text: "a" }, 0);
  const r = sw.update({ id: "device:tilt", kind: "device", text: "b" }, 1600);
  assert.equal(r.switched, true);
  assert.equal(r.displayed.id, "device:tilt");
  assert.equal(r.previous.id, "device:blur");
  assert.equal(r.previousShownAt, 0);
});

test("createInstructionSwitcher: doneへの切り替えは即時", () => {
  const sw = createInstructionSwitcher(1500);
  sw.update({ id: "device:blur", kind: "device", text: "a" }, 0);
  const r = sw.update({ id: "composition:done", kind: "done", text: "この構図で撮影" }, 100);
  assert.equal(r.switched, true);
  assert.equal(r.displayed.id, "composition:done");
});

test("createInstructionSwitcher: doneから他の指示への切り替えも即時", () => {
  const sw = createInstructionSwitcher(1500);
  sw.update({ id: "composition:done", kind: "done", text: "done" }, 0);
  const r = sw.update({ id: "device:blur", kind: "device", text: "a" }, 50);
  assert.equal(r.switched, true);
  assert.equal(r.displayed.id, "device:blur");
});

test("createInstructionSwitcher: 同じidのままなら切り替えなしで文言だけ更新する", () => {
  const sw = createInstructionSwitcher(1500);
  sw.update({ id: "device:tilt", kind: "device", text: "約10°" }, 0);
  const r = sw.update({ id: "device:tilt", kind: "device", text: "約8°" }, 100);
  assert.equal(r.switched, false);
  assert.equal(r.displayed.text, "約8°");
});
