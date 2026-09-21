import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadEvents, summarize, groupKey, median, percentile, ratioText } from "../scripts/summarize_log.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "synthetic_log.json");

test("median: 偶数/奇数個の配列を正しく計算する", () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test("percentile: p95のインデックス計算", () => {
  const nums = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
  assert.equal(percentile(nums, 95), 19);
  assert.equal(percentile([], 95), null);
});

test("ratioText: 分母0はn/aを返す", () => {
  assert.equal(ratioText(0, 0), "n/a (n=0)");
});

test("ratioText: n<30は参考値と表示する", () => {
  assert.match(ratioText(5, 10), /※参考値/);
});

test("ratioText: n>=30は参考値表示にならない", () => {
  assert.doesNotMatch(ratioText(15, 30), /※参考値/);
});

test("loadEvents: 配列(合成ログ)をそのまま読める", () => {
  const events = loadEvents(fixturePath);
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => typeof e.type === "string"));
});

test("loadEvents: {events:[...]}形式(エクスポートしたJSON)も読める", () => {
  const tmp = path.join(__dirname, "fixtures", "_tmp_export_shape.json");
  const events = JSON.parse(readFileSync(fixturePath, "utf-8"));
  writeFileSync(tmp, JSON.stringify({ schemaVersion: 2, events, legacyV1: [] }));
  const loaded = loadEvents(tmp);
  assert.equal(loaded.length, events.length);
  unlinkSync(tmp);
});

test("summarize: 合成ログから質問セット×UIモードの3グループができる", () => {
  const events = loadEvents(fixturePath);
  const groups = summarize(events);
  assert.deepEqual(
    [...groups.keys()].sort(),
    ["A / multi", "B / single", "C / multi"].sort()
  );
});

test("summarize: A/multiグループの指示表示・撮影・満足度を正しく集計する", () => {
  const events = loadEvents(fixturePath);
  const groups = summarize(events);
  const g = groups.get(groupKey("A", "multi"));

  assert.equal(g.shownByKind.get("device"), 1);
  assert.equal(g.shownByKind.get("composition"), 1);
  assert.equal(g.shownByKind.get("done"), 1);

  assert.equal(g.shutters.length, 1);
  assert.equal(g.ratings.length, 1);
  assert.equal(g.ratings[0].rating, "up");
  assert.equal(g.ratings[0].primaryState, "achieved");
});

test("summarize: B/singleグループでmain_problemの分布と解消率を突き合わせる", () => {
  const events = loadEvents(fixturePath);
  const groups = summarize(events);
  const g = groups.get(groupKey("B", "single"));

  assert.deepEqual(
    Object.fromEntries(g.mainProblemCounts),
    { subject_small: 1, background_busy: 1, none: 1 }
  );

  const subjectSmall = g.mainProblemResolved.get("subject_small");
  assert.equal(subjectSmall.total, 1);
  assert.equal(subjectSmall.achieved, 0); // superseded(未解消のまま切り替わった)

  const backgroundBusy = g.mainProblemResolved.get("background_busy");
  assert.equal(backgroundBusy.total, 1);
  assert.equal(backgroundBusy.achieved, 1);
});

test("summarize: judgeイベントに無いキー(質問セットに含まれない項目)は不明率に数えない", () => {
  const events = loadEvents(fixturePath);
  const groups = summarize(events);
  const gA = groups.get(groupKey("A", "multi"));
  // 質問セットAにはmain_problemが含まれないため、judgeイベント自体にキーが無く集計対象外になる。
  assert.equal(gA.judgeUnknownCounts.has("main_problem"), false);

  const gB = groups.get(groupKey("B", "single"));
  // 質問セットBにはskill_levelが含まれない。
  assert.equal(gB.judgeUnknownCounts.has("skill_level"), false);
  assert.equal(gB.judgeUnknownCounts.get("main_problem").total, 3);
});

test("summarize: C/multiグループでshutterのlastJudge要約とinstruction_resolved(shutter)を保持する", () => {
  const events = loadEvents(fixturePath);
  const groups = summarize(events);
  const g = groups.get(groupKey("C", "multi"));

  assert.equal(g.shutters.length, 1);
  assert.equal(g.shutters[0].lastJudge.mainProblem, "none");

  const resolvedResults = g.resolved.map((r) => r.result);
  assert.ok(resolvedResults.includes("shutter"), "composition:doneがshutterで終端したイベントを含む");
});
