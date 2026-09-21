// instructions.js: 「今どの指示を出すか」を1つに決める指示エンジン。
// しきい値・文言は docs/instruction_rules.json に外出ししてあり、ここには純粋なロジックだけを置く。
//
// - evaluateInstruction(context, rules): 優先順位に従って候補を評価し、主指示を1つ返す
// - isInstructionAchieved(instruction, context, rules): その指示の実際の解消条件が
//   今のcontextで満たされているかを判定する(ログのachieved/superseded判定に使う)
// - createInstructionSwitcher(minIntervalMs): 主指示の切り替えにチラつき防止の
//   デバウンスをかける小さな状態機械(analyze.jsのcreateEma/createStillnessTrackerと同じ形)
//
// 優先順位(仕様どおり、番号が小さいほど優先):
//   1. device:blur        静止していてブレスコアが低い
//   2. device:tilt        傾きがしきい値以上(センサーがある場合のみ)
//   3. device:brightness  明るさスコアが低い
//   4. server:main_problem  質問main_problemの確率がしきい値以上でnone以外
//   5. server:noul        質問セットCのみ。subject_cut/distraction/backlightの確率がしきい値以上
//   6. composition        現行のbuildInstruction(位置・大きさ)
//   7. done               6が達成状態のときの終端表示

const NOUL_ORDER = ["subject_cut", "distraction", "backlight"];
const NOUL_FIELD_BY_KEY = {
  subject_cut: "subjectCut",
  distraction: "distraction",
  backlight: "backlight",
};

// context: {
//   isStill, blurScore, brightnessScore, hasSensor, tiltDeg,
//   questionSet, mainProblem, mainProblemRaw, subjectCut, distraction, backlight,
//   compositionResult: buildInstruction()の戻り値 または null(テンプレート等が無い場合もbuildInstructionは
//     positionUnknown等で値を返すので、通常はnullにはならない)
// }
export function evaluateInstruction(context, rules) {
  const ctx = context || {};
  const r = rules || {};

  // 1. device:blur (動いている間は出さない)
  if (
    ctx.isStill &&
    typeof ctx.blurScore === "number" &&
    r.blur &&
    ctx.blurScore < r.blur.threshold
  ) {
    return { id: "device:blur", kind: "device", text: r.blur.text, achieved: false };
  }

  // 2. device:tilt(向きは使わない。絶対値だけ見る)
  if (ctx.hasSensor && typeof ctx.tiltDeg === "number" && r.tilt) {
    const absTilt = Math.abs(ctx.tiltDeg);
    if (absTilt >= r.tilt.thresholdDeg) {
      const text = (r.tilt.textTemplate || "").replace("{deg}", String(Math.round(absTilt)));
      return { id: "device:tilt", kind: "device", text, achieved: false };
    }
  }

  // 3. device:brightness
  if (
    typeof ctx.brightnessScore === "number" &&
    r.brightness &&
    ctx.brightnessScore < r.brightness.threshold
  ) {
    return { id: "device:brightness", kind: "device", text: r.brightness.text, achieved: false };
  }

  // 4. server:main_problem(確率のしきい値判定はguide.jsのparseAnswers側で既に適用済み。
  //    ここではmainProblemがnull/"none"でなければ採用する)
  if (ctx.mainProblem && ctx.mainProblem !== "none" && r.mainProblemText && r.mainProblemText[ctx.mainProblem]) {
    return {
      id: `server:main_problem:${ctx.mainProblem}`,
      kind: "server",
      text: r.mainProblemText[ctx.mainProblem],
      achieved: false,
      meta: { value: ctx.mainProblem },
    };
  }

  // 5. server:noul(質問セットCのみ。main_problemと同じ内容は重複させない)
  if (ctx.questionSet === "C" && r.noulMapping && typeof r.noulThreshold === "number") {
    for (const key of NOUL_ORDER) {
      const field = NOUL_FIELD_BY_KEY[key];
      const value = ctx[field];
      if (typeof value !== "number" || value < r.noulThreshold) continue;
      const mapped = r.noulMapping[key];
      if (!mapped || ctx.mainProblemRaw === mapped) continue; // main_problemと同一内容なら重複させない
      const text = r.mainProblemText ? r.mainProblemText[mapped] : null;
      if (!text) continue;
      return {
        id: `server:noul:${key}`,
        kind: "server",
        text,
        achieved: false,
        meta: { value: key },
      };
    }
  }

  // 6/7. composition / done
  if (ctx.compositionResult) {
    if (ctx.compositionResult.achieved) {
      return { id: "composition:done", kind: "done", text: r.doneText || "この構図で撮影", achieved: true };
    }
    return {
      id: "composition:guide",
      kind: "composition",
      text: ctx.compositionResult.message,
      achieved: false,
    };
  }

  return { id: "composition:guide", kind: "composition", text: "", achieved: false };
}

// instruction(evaluateInstructionの戻り値)が、今のcontextで実際に解消しているかを判定する。
// instruction_resolvedログの result を achieved / superseded のどちらにするか決めるために使う
// (superseded=単に別の指示に押しのけられただけで、根本条件は直っていない可能性がある)。
export function isInstructionAchieved(instruction, context, rules) {
  if (!instruction) return false;
  const ctx = context || {};
  const r = rules || {};

  if (instruction.kind === "done") return true;

  if (instruction.id === "device:blur") {
    return typeof ctx.blurScore === "number" && r.blur && ctx.blurScore >= r.blur.achievedThreshold;
  }
  if (instruction.id === "device:tilt") {
    return typeof ctx.tiltDeg === "number" && r.tilt && Math.abs(ctx.tiltDeg) < r.tilt.achievedThresholdDeg;
  }
  if (instruction.id === "device:brightness") {
    return (
      typeof ctx.brightnessScore === "number" &&
      r.brightness &&
      ctx.brightnessScore >= r.brightness.achievedThreshold
    );
  }
  if (instruction.id.startsWith("server:main_problem:")) {
    const value = instruction.id.slice("server:main_problem:".length);
    // 次のサーバー判定でこの値が選ばれなくなっていれば解消したとみなす。
    return ctx.mainProblem !== value;
  }
  if (instruction.id.startsWith("server:noul:")) {
    const key = instruction.id.slice("server:noul:".length);
    const field = NOUL_FIELD_BY_KEY[key];
    const value = ctx[field];
    return typeof value !== "number" || value < (r.noulThreshold ?? 0.5);
  }
  if (instruction.id === "composition:guide") {
    return Boolean(ctx.compositionResult && ctx.compositionResult.achieved);
  }
  return false;
}

// 主指示の切り替えにチラつき防止のデバウンスをかける状態機械。
// 前回の切り替えから minIntervalMs 未満では切り替えない。ただし doneへの切り替え・
// doneから他への切り替えは即時(仕様どおり)。
export function createInstructionSwitcher(minIntervalMs = 1500) {
  let displayed = null;
  let shownAt = null;
  let lastSwitchAt = 0;

  return {
    // candidate: evaluateInstructionの戻り値。now: Date.now()相当の数値。
    // 戻り値: { displayed, switched, previous, previousShownAt }
    //   switchedがtrueのとき、previousに直前まで表示していた指示(初回はnull)、
    //   previousShownAtにその表示開始時刻が入る(呼び出し側でelapsedMs計算に使う)。
    update(candidate, now) {
      if (!displayed) {
        displayed = candidate;
        shownAt = now;
        lastSwitchAt = now;
        return { displayed, switched: true, previous: null, previousShownAt: null };
      }

      if (displayed.id === candidate.id) {
        displayed = candidate; // 文言等が更新されている場合があるので入れ替える(表示開始時刻は維持)
        return { displayed, switched: false, previous: null, previousShownAt: null };
      }

      const isDoneTransition = candidate.kind === "done" || displayed.kind === "done";
      if (!isDoneTransition && now - lastSwitchAt < minIntervalMs) {
        return { displayed, switched: false, previous: null, previousShownAt: null };
      }

      const previous = displayed;
      const previousShownAt = shownAt;
      displayed = candidate;
      shownAt = now;
      lastSwitchAt = now;
      return { displayed, switched: true, previous, previousShownAt };
    },
    get current() {
      return displayed;
    },
    get currentShownAt() {
      return shownAt;
    },
    reset() {
      displayed = null;
      shownAt = null;
      lastSwitchAt = 0;
    },
  };
}
