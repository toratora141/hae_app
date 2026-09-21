import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  parseAnswers,
  cellToRC,
  selectTemplate,
  resolveTemplate,
  buildTemplateMatchQuestion,
  buildInstruction,
  buildActiveQuestions,
  collectProbabilities,
  expectedCell,
  pickCurrentCell,
  CONFIDENCE_THRESHOLD,
  CELL_HYSTERESIS,
} from "../docs/guide.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templates = JSON.parse(
  readFileSync(path.join(__dirname, "..", "docs", "templates.json"), "utf-8")
);

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(__dirname, "fixtures", name), "utf-8"));
}

// --- parseAnswers(実際に確認したレスポンスの構造を使用) ------------------------------

test("parseAnswers: 人物・中央の実レスポンスを解釈できる", () => {
  const parsed = parseAnswers(loadFixture("response_person_center.json"));
  assert.equal(parsed.scene, "person");
  assert.equal(parsed.subjectPos, "center");
  assert.equal(typeof parsed.subjectSize, "number");
  assert.equal(typeof parsed.haeScore, "number");
  assert.equal(typeof parsed.snsWorthy, "number");
  assert.equal(parsed.usage.inputTokens, 696);
});

test("parseAnswers: sceneの確率が0.4以上(0.483)なら採用される", () => {
  const parsed = parseAnswers(loadFixture("response_text_only.json"));
  assert.equal(parsed.scene, "object");
  assert.ok(parsed.sceneProb >= CONFIDENCE_THRESHOLD);
  assert.equal(parsed.subjectPos, "center");
});

test("parseAnswers: choiceの確率がしきい値未満なら不明(null)として扱う", () => {
  const raw = {
    answers: {
      scene: {
        type: "choice",
        choice: "food",
        probabilities: { food: 0.3, person: 0.3, landscape: 0.2, object: 0.1, pet: 0.1 },
        confidence: 0.1,
      },
      subject_pos: {
        type: "choice",
        choice: "center",
        probabilities: { center: 0.9 },
        confidence: 0.8,
      },
      subject_size: { type: "score", score: 2.5, confidence: 0.5 },
      hae_score: { type: "score", score: 3.0, confidence: 0.5 },
      sns_worthy: { type: "noul", noul: 0.7 },
    },
    usage: { input_tokens: 100, output_tokens: 0 },
  };
  const parsed = parseAnswers(raw);
  assert.equal(parsed.scene, null, "確率0.3 < 0.4 なので不明扱い");
  assert.equal(parsed.subjectPos, "center");
});

test("parseAnswers: answersが空でも例外にならない", () => {
  const parsed = parseAnswers({});
  assert.equal(parsed.scene, null);
  assert.equal(parsed.subjectSize, null);
  assert.equal(parsed.templateMatch, null);
  assert.equal(parsed.usage.inputTokens, null);
});

test("parseAnswers: template_matchもscene/subject_posと同じ形式(choice型)で解釈できる", () => {
  const raw = {
    answers: {
      template_match: {
        type: "choice",
        choice: "thirds_left",
        probabilities: {
          thirds_left: 0.6,
          thirds_right: 0.1,
          center_symmetry: 0.15,
          topdown_food: 0.1,
          person_thirds: 0.05,
        },
        confidence: 0.5,
      },
    },
    usage: {},
  };
  const parsed = parseAnswers(raw);
  assert.equal(parsed.templateMatch, "thirds_left");
  assert.ok(parsed.templateMatchProb >= CONFIDENCE_THRESHOLD);
});

test("parseAnswers: template_matchの確率がしきい値未満なら不明(null)として扱う", () => {
  const raw = {
    answers: {
      template_match: {
        type: "choice",
        choice: "thirds_left",
        probabilities: { thirds_left: 0.3, thirds_right: 0.3, center_symmetry: 0.4 },
        confidence: 0.3,
      },
    },
    usage: {},
  };
  const parsed = parseAnswers(raw);
  assert.equal(parsed.templateMatch, null);
});

test("parseAnswers: skill_level/lighting_quality/color_harmony/background_clutterを解釈できる", () => {
  const raw = {
    answers: {
      skill_level: {
        type: "choice",
        choice: "professional",
        probabilities: { professional: 0.7, amateur: 0.2, snapshot: 0.1 },
        confidence: 0.6,
      },
      lighting_quality: { type: "score", score: 3.2, confidence: 0.5 },
      color_harmony: { type: "score", score: 2.1, confidence: 0.5 },
      background_clutter: { type: "score", score: 3.8, confidence: 0.5 },
    },
    usage: {},
  };
  const parsed = parseAnswers(raw);
  assert.equal(parsed.skillLevel, "professional");
  assert.ok(parsed.skillLevelProb >= CONFIDENCE_THRESHOLD);
  assert.equal(parsed.lightingQuality, 3.2);
  assert.equal(parsed.colorHarmony, 2.1);
  assert.equal(parsed.backgroundClutter, 3.8);
});

test("parseAnswers: 新設の追加判定項目が無くても例外にならない(null)", () => {
  const parsed = parseAnswers({ answers: {}, usage: {} });
  assert.equal(parsed.skillLevel, null);
  assert.equal(parsed.lightingQuality, null);
  assert.equal(parsed.colorHarmony, null);
  assert.equal(parsed.backgroundClutter, null);
  assert.equal(parsed.mainProblem, null);
  assert.equal(parsed.mainProblemRaw, null);
  assert.equal(parsed.subjectCut, null);
  assert.equal(parsed.distraction, null);
  assert.equal(parsed.backlight, null);
});

test("parseAnswers: main_problem/subject_cut/distraction/backlight(質問セットB/C)を解釈できる", () => {
  const raw = {
    answers: {
      main_problem: {
        type: "choice",
        choice: "subject_cut",
        probabilities: { none: 0.1, subject_small: 0.1, subject_cut: 0.6, background_busy: 0.1, backlight_dark: 0.05, off_balance: 0.03, obstruction: 0.02 },
        confidence: 0.5,
      },
      subject_cut: { type: "noul", noul: 0.8 },
      distraction: { type: "noul", noul: 0.2 },
      backlight: { type: "noul", noul: 0.1 },
    },
    usage: {},
  };
  const parsed = parseAnswers(raw);
  assert.equal(parsed.mainProblem, "subject_cut");
  assert.equal(parsed.mainProblemRaw, "subject_cut");
  assert.equal(parsed.subjectCut, 0.8);
  assert.equal(parsed.distraction, 0.2);
  assert.equal(parsed.backlight, 0.1);
});

test("parseAnswers: main_problemの確率がしきい値未満でもmainProblemRawには生の選択肢が残る", () => {
  const raw = {
    answers: {
      main_problem: {
        type: "choice",
        choice: "off_balance",
        probabilities: { none: 0.3, off_balance: 0.35, subject_small: 0.35 },
        confidence: 0.3,
      },
    },
    usage: {},
  };
  const parsed = parseAnswers(raw);
  assert.equal(parsed.mainProblem, null, "確率0.35 < 0.4 なので不明扱い");
  assert.equal(parsed.mainProblemRaw, "off_balance");
});

test("parseAnswers: 型が違う/範囲外の値でも例外にならず不明として扱う", () => {
  const raw = {
    answers: {
      subject_cut: { type: "noul", noul: "true" }, // 型違い(文字列)
      distraction: { type: "score", noul: 0.9 }, // typeが違う
      backlight: null,
      main_problem: { type: "choice" }, // choiceキーが無い
    },
    usage: {},
  };
  const parsed = parseAnswers(raw);
  assert.equal(parsed.subjectCut, null);
  assert.equal(parsed.distraction, null);
  assert.equal(parsed.backlight, null);
  assert.equal(parsed.mainProblem, null);
  assert.equal(parsed.mainProblemRaw, null);
});

// --- buildActiveQuestions ----------------------------------------------------

test("buildActiveQuestions: セットのキーだけをdefsから取り出す", () => {
  const defs = { a: { type: "score" }, b: { type: "choice" }, c: { type: "noul" } };
  const q = buildActiveQuestions(defs, ["a", "c"]);
  assert.deepEqual(Object.keys(q).sort(), ["a", "c"]);
  assert.equal(q.a, defs.a);
});

test("buildActiveQuestions: defsに無いキー・空配列は無視する", () => {
  const defs = { a: { type: "score" } };
  assert.deepEqual(buildActiveQuestions(defs, ["a", "no_such_key"]), { a: defs.a });
  assert.deepEqual(buildActiveQuestions(defs, []), {});
  assert.deepEqual(buildActiveQuestions(defs, undefined), {});
});

// --- collectProbabilities -----------------------------------------------------

test("collectProbabilities: choice/score型のprobabilitiesを小数3桁に丸めて集める", () => {
  const answers = {
    scene: { type: "choice", choice: "food", probabilities: { food: 0.123456, person: 0.876544 } },
    hae_score: { type: "score", score: 3, probabilities: { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.4 } },
    sns_worthy: { type: "noul", noul: 0.5 }, // probabilitiesが無いので含まれない
  };
  const out = collectProbabilities(answers, ["scene", "hae_score", "sns_worthy", "missing_key"]);
  assert.deepEqual(Object.keys(out).sort(), ["hae_score", "scene"]);
  assert.equal(out.scene.food, 0.123);
  assert.equal(out.scene.person, 0.877);
});

// --- expectedCell / pickCurrentCell -------------------------------------------

test("expectedCell: 1マスに確率が集中していれば、その座標に一致する", () => {
  const e = expectedCell({ center: 1 });
  assert.equal(e.col, 1);
  assert.equal(e.row, 1);
});

test("expectedCell: 分布に応じた期待座標(中間値)を返す", () => {
  // mid_left(col0,row1)とmid_right(col2,row1)で半々 → colの期待値は1
  const e = expectedCell({ mid_left: 0.5, mid_right: 0.5 });
  assert.equal(e.col, 1);
  assert.equal(e.row, 1);
});

test("expectedCell: 確率の合計が正規化されていなくても比率で計算する", () => {
  // top_left:2, top_right:2 (合蠈4) → colの期待値は(0*2+2*2)/4=1
  const e = expectedCell({ top_left: 2, top_right: 2 });
  assert.equal(e.col, 1);
  assert.equal(e.row, 0);
});

test("expectedCell: 分布が無い/合計0ならnullを返す", () => {
  assert.equal(expectedCell(null), null);
  assert.equal(expectedCell({}), null);
  assert.equal(expectedCell({ center: 0 }), null);
});

test("pickCurrentCell: 前回マスが無ければ最寄りの整数マスに丸める", () => {
  assert.equal(pickCurrentCell({ col: 1.9, row: 0.1 }, null), "top_right");
});

test("pickCurrentCell: 期待座標がヒステリシス範囲内(<=0.65)なら前回のマスを維持する", () => {
  // center(1,1)から距離0.65ちょうど: sqrt(0.65^2)なので片軸だけ0.65動いた場合は維持される
  const kept = pickCurrentCell({ col: 1.65, row: 1 }, "center");
  assert.equal(kept, "center");
});

test("pickCurrentCell: ヒステリシス範囲を超えたら切り替える", () => {
  const switched = pickCurrentCell({ col: 2, row: 1 }, "center");
  assert.equal(switched, "mid_right");
});

test("pickCurrentCell: 期待座標がnullなら前回のマスをそのまま返す", () => {
  assert.equal(pickCurrentCell(null, "center"), "center");
  assert.equal(pickCurrentCell(null, null), null);
});

// --- cellToRC ------------------------------------------------------------

test("cellToRC: 9マスをrow/colに変換する", () => {
  assert.deepEqual(cellToRC("top_left"), { row: 0, col: 0 });
  assert.deepEqual(cellToRC("center"), { row: 1, col: 1 });
  assert.deepEqual(cellToRC("bottom_right"), { row: 2, col: 2 });
  assert.equal(cellToRC("unknown_cell"), null);
});

// --- selectTemplate --------------------------------------------------------

test("selectTemplate: sceneが一致し、現在位置から距離が最小のテンプレートを選ぶ", () => {
  const t = selectTemplate(templates, "food", "top_left");
  // food候補: thirds_left(mid_left,dist1) / thirds_right(mid_right,dist3) /
  // center_symmetry(center,dist2) / topdown_food(center,dist2)。
  // 距離最小のthirds_leftが選ばれる。
  assert.equal(t.id, "thirds_left");
});

test("selectTemplate: 距離が同点の場合はpriorityが高い方を選ぶ", () => {
  // center_symmetry(center, priority1) と topdown_food(center, priority3) は
  // 同じセルなので距離0で同点となり、priorityが高いtopdown_foodが選ばれる。
  const t = selectTemplate(templates, "food", "center");
  assert.equal(t.id, "topdown_food");
});

test("selectTemplate: posがnullなら一致するテンプレートのうちpriority最大を選ぶ", () => {
  const t = selectTemplate(templates, "food", null);
  assert.equal(t.id, "topdown_food");
});

test("selectTemplate: sceneがnullならnullを返す", () => {
  assert.equal(selectTemplate(templates, null, "center"), null);
});

test("selectTemplate: 一致するsceneが無ければnullを返す", () => {
  assert.equal(selectTemplate(templates, "no_such_scene", "center"), null);
});

// --- buildTemplateMatchQuestion ----------------------------------------------

test("buildTemplateMatchQuestion: テンプレート一覧からchoice型の質問を組み立てる", () => {
  const q = buildTemplateMatchQuestion(templates);
  assert.equal(q.type, "choice");
  assert.equal(q.criteria.thirds_left, "三分割・左寄せ");
  assert.equal(Object.keys(q.criteria).length, templates.length);
});

test("buildTemplateMatchQuestion: テンプレートが空でも例外にならない", () => {
  const q = buildTemplateMatchQuestion([]);
  assert.deepEqual(q.criteria, {});
});

// --- resolveTemplate -----------------------------------------------------------

test("resolveTemplate: 手動選択が最優先される", () => {
  const t = resolveTemplate(templates, {
    manualId: "center_symmetry",
    templateMatchId: "thirds_left",
    scene: "food",
    pos: "center",
  });
  assert.equal(t.id, "center_symmetry");
});

test("resolveTemplate: 手動選択が無ければ自動選択(selectTemplate)が優先される(template_matchより先)", () => {
  // 【変更】以前はtemplateMatchIdが自動選択より優先されていたが、決定的な自動選択を
  // template_match(未確認の実験項目)より優先するよう順序を変更した。
  const t = resolveTemplate(templates, {
    manualId: null,
    templateMatchId: "person_thirds",
    scene: "food",
    pos: "top_left",
  });
  assert.equal(t.id, "thirds_left", "food×top_leftではthirds_leftが自動選択されるため、templateMatchIdより優先される");
});

test("resolveTemplate: 手動選択・自動選択とも無ければサーバー判定(template_match)にフォールバックする", () => {
  // sceneがnullだとselectTemplateはnullを返すため、template_matchが使われる。
  const t = resolveTemplate(templates, {
    manualId: null,
    templateMatchId: "person_thirds",
    scene: null,
    pos: null,
  });
  assert.equal(t.id, "person_thirds");
});

test("resolveTemplate: 手動選択・自動選択・サーバー判定のいずれも無ければnullを返す", () => {
  const t = resolveTemplate(templates, {
    manualId: null,
    templateMatchId: null,
    scene: null,
    pos: null,
  });
  assert.equal(t, null);
});

test("resolveTemplate: templateMatchIdが存在しないIDでも、自動選択が既に決まっていれば無視される", () => {
  const t = resolveTemplate(templates, {
    manualId: null,
    templateMatchId: "no_such_template",
    scene: "food",
    pos: "center",
  });
  assert.equal(t.id, "topdown_food");
});

// --- buildInstruction --------------------------------------------------------

const thirdsRight = templates.find((t) => t.id === "thirds_right"); // cell: mid_right, size [2,3]
const thirdsLeft = templates.find((t) => t.id === "thirds_left"); // cell: mid_left, size [2,3]

test("buildInstruction: dx>0(目標が右)なら被写体を右へ寄せる(カメラを左へ振る)指示を出す", () => {
  const r = buildInstruction(thirdsRight, "mid_left", 2.5);
  assert.equal(r.achieved, false);
  assert.match(r.message, /右へ寄せる/);
  assert.match(r.message, /カメラを左へ振る/);
});

test("buildInstruction: dx<0(目標が左)なら被写体を左へ寄せる(カメラを右へ振る)指示を出す", () => {
  const r = buildInstruction(thirdsLeft, "mid_right", 2.5);
  assert.match(r.message, /左へ寄せる/);
  assert.match(r.message, /カメラを右へ振る/);
});

test("buildInstruction: dy>0(目標が下)なら被写体を下へ寄せる(カメラを上へ傾ける)指示を出す", () => {
  const r = buildInstruction(thirdsRight, "top_right", 2.5);
  assert.match(r.message, /下へ寄せる/);
  assert.match(r.message, /カメラを上へ傾ける/);
});

test("buildInstruction: dy<0(目標が上)なら被写体を上へ寄せる(カメラを下へ傾ける)指示を出す", () => {
  const r = buildInstruction(thirdsRight, "bottom_right", 2.5);
  assert.match(r.message, /上へ寄せる/);
  assert.match(r.message, /カメラを下へ傾ける/);
});

test("buildInstruction: サイズが小さすぎれば近づく指示を出す", () => {
  const r = buildInstruction(thirdsRight, "mid_right", 1.0); // min=2, 1.0 < 2-0.5
  assert.match(r.message, /近づく/);
  assert.equal(r.sizeDir, "closer");
});

test("buildInstruction: サイズが大きすぎれば離れる指示を出す", () => {
  const r = buildInstruction(thirdsRight, "mid_right", 4.0); // max=3, 4.0 > 3+0.5
  assert.match(r.message, /離れる/);
  assert.equal(r.sizeDir, "farther");
});

test("buildInstruction: 位置・サイズがすべて条件を満たせば達成と表示する", () => {
  const r = buildInstruction(thirdsRight, "mid_right", 2.5);
  assert.equal(r.achieved, true);
  assert.equal(r.message, "この構図で撮影");
});

test("buildInstruction: posがnullならテンプレートの一般説明のみを表示する", () => {
  const r = buildInstruction(thirdsRight, null, 2.5);
  assert.equal(r.achieved, false);
  assert.equal(r.positionUnknown, true);
  assert.equal(r.message, thirdsRight.instruction);
});

test("buildInstruction: templateがnullなら手動選択を促すメッセージを返す", () => {
  const r = buildInstruction(null, "center", 2.5);
  assert.equal(r.achieved, false);
  assert.equal(r.positionUnknown, true);
  assert.match(r.message, /手動で選んで/);
});
