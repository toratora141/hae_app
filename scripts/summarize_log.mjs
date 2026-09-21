#!/usr/bin/env node
// scripts/summarize_log.mjs
//
// 使い方: node scripts/summarize_log.mjs <ログJSONのパス>
//
// 「ログをJSONで書き出す」で得たファイル(スキーマ: { schemaVersion, events, legacyV1 })、
// または合成ログの配列(tests/fixtures/synthetic_log.json のようなイベント配列そのもの)を渡せる。
// legacyV1(旧数値のみのログ)は本集計の対象外(instruction/shutter系のイベントを持たないため)。
//
// 質問セット(questionSet) × 表示モード(uiMode)ごとに、旅行テストで見るべき指標を
// 標準出力にテキスト表で出す。件数が少ない集計は「※参考値」と明記する。
//
// 注意: instruction_resolved / instruction_feedback / judge イベント自体は
// questionSet・uiModeを(仕様どおり)持たないため、直近のinstruction_shownイベント
// (同じinstructionId、無ければ直近のいずれか)から推定して突き合わせている。
// これは近似であり、実測値そのものではない。

import { readFileSync } from "node:fs";

const MIN_N = 30;

function loadEvents(path) {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const events = Array.isArray(raw) ? raw : raw.events || [];
  return events
    .slice()
    .filter((e) => e && typeof e === "object" && typeof e.type === "string")
    .sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
}

function groupKey(questionSet, uiMode) {
  return `${questionSet || "unknown"} / ${uiMode || "unknown"}`;
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(nums, p) {
  if (nums.length === 0) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

function fmtMs(ms) {
  return ms === null || ms === undefined ? "n/a" : `${Math.round(ms)}ms`;
}

function refNote(n) {
  return n < MIN_N ? ` ※参考値(n=${n})` : ` (n=${n})`;
}

function ratioText(numerator, denominator) {
  if (denominator === 0) return "n/a (n=0)";
  const pct = ((numerator / denominator) * 100).toFixed(1);
  return `${pct}% (${numerator}/${denominator})${denominator < MIN_N ? " ※参考値" : ""}`;
}

function newGroup() {
  return {
    shownByKind: new Map(),
    feedback: new Map(), // kind -> {understood, unclear}
    resolved: [], // {result, elapsedMs, kind}
    mainProblemResolved: new Map(), // value -> {achieved, total}
    mainProblemCounts: new Map(), // value -> count
    judgeResponseTimes: [],
    judgeUnknownCounts: new Map(), // questionKey -> {unknown, total}
    shutters: [],
    ratings: [], // {rating, primaryState}
  };
}

// judgeイベントに載っている主要フィールドのみを対象に「不明」割合を数える。
// (どの質問が実際に問われたかはログから完全には復元できないため、
//  ログに載る主要な質問だけを対象にする、という限定つきの集計)
const JUDGE_UNKNOWN_FIELDS = {
  scene: "scene",
  subject_pos: "subjectPos",
  main_problem: "mainProblem",
  skill_level: "skillLevel",
  template_match: "templateMatch",
};

function summarize(events) {
  const groups = new Map();
  const group = (key) => {
    if (!groups.has(key)) groups.set(key, newGroup());
    return groups.get(key);
  };

  const lastShownById = new Map();
  const shutterById = new Map();
  let currentUiMode = null;

  for (const ev of events) {
    if (ev.type === "instruction_shown") {
      currentUiMode = ev.uiMode || currentUiMode;
      lastShownById.set(ev.instructionId, ev);
      group(groupKey(ev.questionSet, ev.uiMode)).shownByKind.set(
        ev.kind,
        (group(groupKey(ev.questionSet, ev.uiMode)).shownByKind.get(ev.kind) || 0) + 1
      );
    } else if (ev.type === "instruction_resolved") {
      const shown = lastShownById.get(ev.instructionId) || null;
      const key = groupKey(shown && shown.questionSet, shown && shown.uiMode);
      const g = group(key);
      g.resolved.push({ result: ev.result, elapsedMs: ev.elapsedMs, kind: shown ? shown.kind : null });

      if (ev.instructionId && ev.instructionId.startsWith("server:main_problem:")) {
        const value = ev.instructionId.slice("server:main_problem:".length);
        if (!g.mainProblemResolved.has(value)) g.mainProblemResolved.set(value, { achieved: 0, total: 0 });
        const m = g.mainProblemResolved.get(value);
        m.total += 1;
        if (ev.result === "achieved") m.achieved += 1;
      }
    } else if (ev.type === "instruction_feedback") {
      const shown = lastShownById.get(ev.instructionId) || null;
      const key = groupKey(shown && shown.questionSet, shown && shown.uiMode);
      const g = group(key);
      const bucket = shown ? shown.kind : "unknown";
      if (!g.feedback.has(bucket)) g.feedback.set(bucket, { understood: 0, unclear: 0 });
      const b = g.feedback.get(bucket);
      if (ev.understood) b.understood += 1;
      else b.unclear += 1;
    } else if (ev.type === "judge") {
      const key = groupKey(ev.questionSet, currentUiMode);
      const g = group(key);
      if (typeof ev.responseTimeMs === "number") g.judgeResponseTimes.push(ev.responseTimeMs);

      for (const [qKey, field] of Object.entries(JUDGE_UNKNOWN_FIELDS)) {
        if (!(field in ev)) continue;
        if (!g.judgeUnknownCounts.has(qKey)) g.judgeUnknownCounts.set(qKey, { unknown: 0, total: 0 });
        const c = g.judgeUnknownCounts.get(qKey);
        c.total += 1;
        if (ev[field] === null) c.unknown += 1;
      }

      if ("mainProblem" in ev) {
        const mp = ev.mainProblem || "(不明/none)";
        g.mainProblemCounts.set(mp, (g.mainProblemCounts.get(mp) || 0) + 1);
      }
    } else if (ev.type === "shutter") {
      shutterById.set(ev.shutterId, ev);
      group(groupKey(ev.questionSet, ev.uiMode)).shutters.push(ev);
    } else if (ev.type === "shot_rating") {
      const shutter = shutterById.get(ev.shutterId);
      if (!shutter) continue;
      group(groupKey(shutter.questionSet, shutter.uiMode)).ratings.push({
        rating: ev.rating,
        primaryState: shutter.primaryState,
      });
    }
  }

  return groups;
}

function printGroup(key, g) {
  console.log(`\n=== ${key} ===`);

  // 指示の表示回数(kind別)・伝わった率
  console.log("-- 指示(kind別) --");
  const kinds = new Set([...g.shownByKind.keys(), ...g.feedback.keys()]);
  if (kinds.size === 0) {
    console.log("  データ無し");
  }
  for (const kind of kinds) {
    const shown = g.shownByKind.get(kind) || 0;
    const fb = g.feedback.get(kind) || { understood: 0, unclear: 0 };
    const fbTotal = fb.understood + fb.unclear;
    console.log(
      `  ${kind}: 表示${shown}回 / 伝わった率 ${ratioText(fb.understood, fbTotal)}`
    );
  }

  // 解消率・解消までの時間の中央値(kind別)
  console.log("-- 解消率(achieved/表示) --");
  const resolvedByKind = new Map();
  for (const r of g.resolved) {
    const k = r.kind || "unknown";
    if (!resolvedByKind.has(k)) resolvedByKind.set(k, { achieved: 0, total: 0, elapsed: [] });
    const b = resolvedByKind.get(k);
    b.total += 1;
    if (r.result === "achieved") {
      b.achieved += 1;
      if (typeof r.elapsedMs === "number") b.elapsed.push(r.elapsedMs);
    }
  }
  if (resolvedByKind.size === 0) console.log("  データ無し");
  for (const [kind, b] of resolvedByKind) {
    console.log(
      `  ${kind}: 解消率 ${ratioText(b.achieved, b.total)} / 解消までの時間(中央値) ${fmtMs(median(b.elapsed))}${refNote(b.elapsed.length)}`
    );
  }

  // 撮影数・primaryState別の満足率・achieved有無での満足率の差
  console.log("-- 撮影・満足度 --");
  console.log(`  撮影数: ${g.shutters.length}`);
  const byState = new Map();
  for (const r of g.ratings) {
    if (!byState.has(r.primaryState)) byState.set(r.primaryState, { up: 0, down: 0 });
    const b = byState.get(r.primaryState);
    if (r.rating === "up") b.up += 1;
    else if (r.rating === "down") b.down += 1;
  }
  if (byState.size === 0) {
    console.log("  評価(👍/👎)データ無し");
  }
  for (const [state, b] of byState) {
    console.log(`  primaryState=${state}: 満足率 ${ratioText(b.up, b.up + b.down)}`);
  }
  const achieved = byState.get("achieved") || { up: 0, down: 0 };
  const otherUp = [...byState.entries()].filter(([k]) => k !== "achieved").reduce((s, [, b]) => s + b.up, 0);
  const otherDown = [...byState.entries()].filter(([k]) => k !== "achieved").reduce((s, [, b]) => s + b.down, 0);
  const achievedTotal = achieved.up + achieved.down;
  const otherTotal = otherUp + otherDown;
  if (achievedTotal > 0 && otherTotal > 0) {
    const achievedRate = achieved.up / achievedTotal;
    const otherRate = otherUp / otherTotal;
    const delta = ((achievedRate - otherRate) * 100).toFixed(1);
    console.log(
      `  achieved撮影とそれ以外の満足率の差: ${delta}pt${(achievedTotal < MIN_N || otherTotal < MIN_N) ? " ※参考値" : ""} (achieved n=${achievedTotal}, other n=${otherTotal})`
    );
  } else {
    console.log("  achieved撮影とそれ以外の満足率の差: 比較に必要なデータが不足");
  }

  // main_problemの分布・解消率
  console.log("-- main_problemの分布と解消率 --");
  if (g.mainProblemCounts.size === 0) {
    console.log("  データ無し(このセットにはmain_problemが含まれないか、未回答)");
  }
  for (const [value, count] of g.mainProblemCounts) {
    const res = g.mainProblemResolved.get(value) || { achieved: 0, total: 0 };
    console.log(`  ${value}: 出現${count}回 / 解消率 ${ratioText(res.achieved, res.total)}`);
  }

  // 各質問の不明割合
  console.log("-- 質問ごとの不明割合 --");
  if (g.judgeUnknownCounts.size === 0) {
    console.log("  データ無し");
  }
  for (const [q, c] of g.judgeUnknownCounts) {
    console.log(`  ${q}: 不明率 ${ratioText(c.unknown, c.total)}`);
  }

  // 応答時間
  console.log("-- 判定の応答時間 --");
  console.log(
    `  中央値 ${fmtMs(median(g.judgeResponseTimes))} / p95 ${fmtMs(percentile(g.judgeResponseTimes, 95))}${refNote(g.judgeResponseTimes.length)}`
  );
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("使い方: node scripts/summarize_log.mjs <ログJSONのパス>");
    process.exit(1);
  }
  const events = loadEvents(path);
  if (events.length === 0) {
    console.log("イベントが0件です(legacyV1のみのファイル、または空のログの可能性があります)。");
    return;
  }
  const groups = summarize(events);
  console.log(`合計 ${events.length} イベント / ${groups.size} グループ(質問セット×表示モード)`);
  for (const [key, g] of groups) {
    printGroup(key, g);
  }
}

// テストからimportしたときはmain()を実行しない(直接 node scripts/summarize_log.mjs で
// 実行されたときだけ動く)。
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}

export { loadEvents, summarize, groupKey, median, percentile, ratioText };
