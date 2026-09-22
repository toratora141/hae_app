# hae_app

映え判定API(`api.codiv.ai`)を使った、スマホ向け「撮影前の画角ガイド付き 映えチェック」のプロトタイプです。
GitHub Pages(`main` ブランチの `/docs`)で公開する静的サイトとして動作します。

このリポジトリは公開(Public)です。写真・APIキー・個人情報・実際のAPIレスポンスに含まれる画像データは、
コード・ログ・コミット・テストのどこにも含めていません。APIキーはブラウザの `localStorage` にのみ保存され、
リポジトリやサーバーには送られません。

## 公開手順 (GitHub Pages)

1. GitHubリポジトリの **Settings → Pages** を開く
2. **Source** を `Deploy from a branch` にする
3. **Branch** を `main` / `/docs` にして **Save**
4. 数分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開される

## 使い方

1. 公開されたページをスマホのブラウザで開く
2. 右上の「設定」から、APIキー・モデル名・エンドポイントを入力して保存する
   - `api.codiv.ai` はブラウザから直接CORSで呼び出せないため(下記参照)、実運用では
     後述のCloudflare Workers中継のURLをエンドポイントに設定してください
   - 設定ダイアログでは、質問セット(A/B/C)・表示モード(multi/single)・
     template_match(構図マッチ、既定OFF)も選べます。詳細は「質問セット」「指示エンジン」の各節を参照
3. 「カメラを開始」を押し、背面カメラでプレビューを表示する
   - 端末・ブラウザがズームに対応していれば、ズームスライダーが表示され、カメラ映像上のピンチ操作でも
     ズームできる(非対応の端末ではスライダーごと表示されない)
   - オートフォーカスは対応していれば自動で連続オートフォーカスに設定される(操作不要)
4. iOSの場合は「センサーの利用を許可」ボタンで水平センサーの利用を許可する
5. 画面が静止すると自動1枚だけAPIに送信され、判定結果と画角ガイド(矢印・枠)、主指示(1つに絞った
   案内文)が表示される
   - 自動送信はオフにでき、その場合は「今すぐ判定」ボタンで手動送信する
6. 判定結果には、その判定に使われた写真の縮小サムネイルが一緒に表示されるので、どの1枚に対する
   結果かが分かる。判定への👍/👎、主指示への「伝わった/分かりにくい」のフィードバックをそれぞれ
   記録でき、「ログをJSONで書き出す」でこれまでの記録(このサムネイルを含む)を保存できる
7. テンプレート(構図)は自動選択されるが、チップから手動で選ぶと自動選択より優先される
8. カメラ映像下の「撮影する」ボタンで実際に1枚保存できる(共有シート、対応していなければダウンロード)

動作確認だけしたい場合は、URLに `?mock=1` を付けて開くとAPIを呼ばずに疑似応答で一通り動作します
(設定ダイアログの「モックモード」トグルからも切り替え可能です)。`?qs=A|B|C`・`?ui=single|multi` を
URLに付けると、そのセッションだけ質問セット・表示モードを指定できます(例: `?mock=1&qs=C&ui=single`)。

旅行での実地テストの具体的な手順は「旅行テスト手順」の節にまとめています。

## hae_photo(非公開の参照元)からの取り込み内容

このプロトタイプの作成にあたり、同一開発者が所有する非公開リポジトリ `hae_photo` を
読み取り専用の参照元として使い、以下の**確認済みの内容のみ**を取り込みました。`hae_photo` 自体への
変更は行っていません。

**取り込んだもの:**

1. **使用しているmodel名**: `openjev-latest`(リクエスト時に指定するモデル名)
2. **`/v1/systemone` の実際のリクエスト/レスポンス構造**(下記「確認したAPIレスポンスの構造」を参照)
3. **画像の縮小・JPEG化・data URL化の実装方針**: 長辺を指定サイズに収まるようにCanvasで
   リサイズし、`canvas.toDataURL("image/jpeg", 0.8)` でJPEG化・data URL化する方針。
   `docs/app.js` の `captureDataUrl()` として、参照元をそのままコピーせずに書き直しました。
   リトライ・タイムアウトは参照元(`hae_photo`)には実装されていなかったため、この機能追加分は
   本リポジトリで新たに設計しました(後述「仮定」を参照)。
4. **実レスポンスのサンプル2件**(画像データ・APIキー・ファイル名を含まないもの)を
   `tests/fixtures/response_person_center.json` / `tests/fixtures/response_text_only.json` として保存

これにより、機能2で指示されていた「model名とレスポンス構造をクラウド環境から自分でAPIに問い合わせて確認する」
作業は省略しました。

**取り込まなかったもの(意図的に一切コピー・コミットしていません):**

- 写真ファイルおよびそのファイル名
- 判定結果の記録・ラベル・評価データ
- APIキーや認証の設定値
- 上記に該当するファイルのファイル名・パス自体(README・コミットメッセージ・テストのどこにも記載していません)

## 確認したAPIレスポンスの構造(hae_photoでの確認結果を引用)

```
POST https://api.codiv.ai/v1/systemone
{
  "model": "openjev-latest",
  "state": "Look at the photo.",
  "images": ["data:image/jpeg;base64,..."],   // テキストのみ確認する場合は省略可
  "questions": { ... 選択中の質問セットの内容(docs/questions/defs.json + sets.json) ... }
}
```

レスポンス (`answers` の各キーは `questions` のキーに対応):

- `type: "choice"` (`scene`, `subject_pos`): `{ type, choice, probabilities: {選択肢: 確率}, confidence }`
- `type: "score"` (`subject_size`, `hae_score`): `{ type, score, legend, probabilities, confidence }`
- `type: "noul"` (`sns_worthy`): `{ type, noul }`
- `usage`: `{ input_tokens, output_tokens }`

この構造の解釈は `docs/guide.js` の `parseAnswers(raw)` に集約しています。

「確率が0.4未満のscene/subject_posは不明として扱う」という仕様における「確率」は、
選択された選択肢の `probabilities[choice]` の値としました(`confidence` フィールドは別の指標のため
使っていません。実際に `probabilities.object=0.483` に対し `confidence=0.28` という値が返ってきており、
両者は一致しないことをhae_photoでの確認で把握しています)。

### 質問セット(A/B/C)

質問の定義は `docs/questions/defs.json` に、セットごとに使うキーの一覧は `docs/questions/sets.json` に
分けて置いています(以前は単一の `docs/questions.json` でしたが、複数の質問セットを切り替えられるよう
分割しました)。`docs/guide.js` の `buildActiveQuestions(defs, setKeys)` が、指定されたセットのキーだけを
`defs` から取り出してリクエスト用の `questions` を組み立てます。

| セット | 内容 | 用途の想定 |
|---|---|---|
| A(既定) | 従来どおりの9項目全部(`scene`/`subject_pos`/`subject_size`/`hae_score`/`sns_worthy`/`skill_level`/`lighting_quality`/`color_harmony`/`background_clutter`) | 何も指定しない場合の既定動作。従来と同じ |
| B | `scene`/`subject_pos`/`subject_size`/`main_problem` の4項目のみ | 質問数を絞った軽量版。「直すべき点」だけをAPIに一言で答えさせる |
| C | `scene`/`subject_pos`/`subject_size`/`hae_score`/`sns_worthy`/`lighting_quality`/`background_clutter`/`main_problem`/`subject_cut`/`distraction`/`backlight` の11項目 | Bの`main_problem`(choice)に加え、個別のはい/いいえ質問(noul)でも同じような問題を検出できるか比較する詳細版 |

切り替えは設定ダイアログの「質問セット」、またはURLの `?qs=A|B|C` で行います(既定はA)。画面上部に
現在の質問セットと表示モードを小さく常時表示するので、テスト中にどちらを使っているか見失いません。

今回、以下の4項目を新設し `docs/questions/defs.json` に追加しました。**これらはhae_photoで確認された
質問ではなく、今回新しく追加したものです**。実際のAPIが期待どおりの構造・分布で答えてくれるかは未確認です
(回答に該当キーが無い・型が違う・値が範囲外の場合は、`docs/guide.js` の `parseAnswers` がその項目を
「不明」として扱い、アプリがクラッシュすることはありません)。

| キー | type | 内容 |
|---|---|---|
| `main_problem` | choice | この写真を良くするために最初に直すべき点はどれか(7択、`none`含む) |
| `subject_cut` | noul | 主な被写体の一部が画面の端で切れているか |
| `distraction` | noul | 被写体以外に目を引く余計な物が写っているか |
| `backlight` | noul | 逆光で被写体が暗く沈んでいるか |

以前追加した `skill_level`/`lighting_quality`/`color_harmony`/`background_clutter` の4項目(セットAに
含まれる)についての説明は変わりません。判定結果画面にはそれぞれの値を表示し、ログ(`judge`イベント、
後述)にも実際に質問した項目の生の値・確率を記録しています。

**注意(不具合修正)**: 判定結果画面は、その質問セットで実際に問い合わせた項目の行だけを表示します。
以前は質問セットAで「直すべき点」の行を常に表示していましたが、Aには`main_problem`が含まれないため
常に「不明」と表示されてしまう不具合がありました(旅行での実機テストで発覚)。同じ理由で、質問セット
B使用中は`スキル感`/`光の使い方`等の行も表示されません(そのセットでは問い合わせていないため)。
「不明」は「質問したが判定できなかった」ことを示し、行が無いのは「そもそも質問していない」ことを
示す、という区別にしています。

質問セットB・Cで実APIが4xx応答を返した場合(新設項目をAPI側が受け付けない等)、`docs/app.js` は
そのセッションの間だけ質問セットAへ自動的にフォールバックし、画面に一度だけ通知バナーを出します
(設定で選び直したセット自体は変更しません)。この動作はPlaywright(フェイクカメラ・実APIの代わりに
400応答を返すモックサーバー)で実際に確認済みです。

なお「シーン(scene)によって尋ねる項目を変えてはどうか」というアイデアも別途検討しましたが、今回の
質問セットA/B/Cはシーンではなく「何を検証したいか」で分けたものであり、シーンに応じた自動出し分けは
引き続き実装していません。理由は以前と同じで、まず各セットでログを取ってから設計する方が手戻りが
少ないためです。`judge`イベントは `scene` と各項目を同じレコードに記録しているので、書き出したログを
シーンでフィルタすれば精度の違いは確認できます。

## CORSについて

`api.codiv.ai` はGitHub Pages上のブラウザから直接 `fetch()` することができません
(hae_photoでの確認: `OPTIONS /v1/systemone` へのプリフライトが404で返り、CORSヘッダーも
実際のPOSTレスポンスにも付与されない)。したがって、以下のCloudflare Workers中継が実運用には必須です。
設定ダイアログの「接続テスト」ボタンでも、CORSエラーを検知した場合は日本語でその旨と対処方法を表示します。

## Cloudflare Workers 中継のデプロイ手順

`relay/worker.js` が中継本体です(**未デプロイ**)。APIキーはWorkerのシークレットから読み、
アプリ側にはキーを渡さずにCORSヘッダー付きでapi.codiv.aiへ転送します。

1. [Cloudflareアカウント](https://dash.cloudflare.com/)を用意し、`npm install -g wrangler` するか `npx wrangler` を使う
2. `relay/` ディレクトリで以下を実行してログインする
   ```
   npx wrangler login
   ```
3. APIキーをシークレットとして登録する(値はターミナルに直接ペーストするプロンプトが出ます。コミットしないこと)
   ```
   npx wrangler secret put CODIV_API_KEY
   ```
4. 必要であれば `relay/wrangler.toml` の `ALLOWED_ORIGIN` を、公開したGitHub PagesのオリジンURL
   (例: `https://<ユーザー名>.github.io`)に変更する(既定は `*` で全オリジン許可のプロトタイプ設定)
5. デプロイする
   ```
   npx wrangler deploy
   ```
6. 発行されたWorkerのURL(例: `https://hae-app-relay.<サブドメイン>.workers.dev`)を、
   アプリの設定パネルの「エンドポイント」に設定する

## docs/templates.json の初期セット

値は仮置きです。ログがたまったら見直してください。

| id | name | scenes | target cell | size範囲 | priority |
|---|---|---|---|---|---|
| thirds_left | 三分割・左寄せ | food, object, pet | mid_left | 2-3 | 2 |
| thirds_right | 三分割・右寄せ | food, object, pet | mid_right | 2-3 | 2 |
| center_symmetry | 日の丸構図 | object, food, landscape | center | 2-4 | 1 |
| topdown_food | 真上から | food | center | 3-4 | 3 |
| person_thirds | 人物・三分割 | person | mid_right | 2-3 | 2 |

`docs/guide.js` の `selectTemplate` は、シーンが一致するテンプレートのうち現在の9マス位置から
`target.cell` までの距離(マンハッタン距離)が最小のものを選び、同点なら `priority` が大きい方を選びます。

### テンプレートの決定方法(手動選択 / 自動選択 / サーバー判定)

画面に表示するテンプレートは、次の優先順位で1つに決まります(`docs/guide.js` の `resolveTemplate`)。

1. **手動選択**: チップで選んだテンプレート
2. **自動選択**: `selectTemplate`(シーン+現在マスからの距離計算、決定的なロジック)
3. **サーバー判定**: APIに問い合わせる `template_match` という質問(「この写真の構図に最も近い
   テンプレートはどれか」を `docs/templates.json` のテンプレート一覧から選ばせるchoice型)への回答。
   設定ダイアログで明示的にONにしたときだけリクエストに含まれ、テンプレート決定にも使われる
   (**既定はOFF**)

**【変更点】** 以前は手動選択の次にサーバー判定(template_match)を優先し、自動選択は最後の
フォールバックでした。`template_match` はhae_photoで未確認の実験的な質問であるため、決定的に
計算できる自動選択をサーバー判定より優先するよう順序を変更し、あわせて `template_match` 自体を
既定OFFの設定項目にしました(指示にあった「template_matchは既定OFFにする」という意図的な変更です)。
ONにした場合のみ、自動選択が候補を出せない(scene不明等)場合の最後のフォールバックとして使われます。

`template_match` の質問は `docs/questions/defs.json`/`sets.json` には含めず、`docs/app.js` の
`buildRequestQuestions()` が、設定でONのときだけ `docs/templates.json` の内容からリクエストのたびに
組み立てて追加します(テンプレートを追加・変更しても質問側を手で同期させる必要がないようにするため)。

一方、「目標とのズレの方向・量」自体(左右上下・近づく/離れるの指示文)は、これまで通り
現在マスと `subject_size`(大きさの期待値)からクライアント側で機械的に計算しています
(`buildInstruction`)。モデルに直接ズレの量を答えさせる案も検討しましたが、`choice`/`score`/`noul` という
確認済みのレスポンス形式には「方向・量」を表すフィールドが無く、モデルがそれを正確に返せる保証もないため、
確実に計算できるこの方式のままにしています。

**注意**: `template_match` はhae_photoで実際に確認された質問ではなく、今回新しく追加したものです。
実際のAPIがこの質問に対して同じ `choice` 形式(`{ type, choice, probabilities, confidence }`)で
答えてくれるかどうかは未確認です。設定でONにして「今すぐ判定」を試し、判定結果の「サーバー判定の構図」欄が
空欄(不明)ばかりにならないか確認してください。

## 位置の連続化(ヒステリシス)

`subject_pos` は9マスのうちどれか1つを選ぶchoice型の質問ですが、境界付近では隣のマスとの間で
判定がちらつきやすい問題がありました。これを緪和するため、`docs/guide.js` に以下を追加しました。

- `expectedCell(probabilities)`: `subject_pos` の9マス分の確率分布から、列(left=0/center=1/right=2)・
  行(top=0/mid=1/bottom=2)それぞれの期待値(0〜2の実数)を計算する純関数
- `pickCurrentCell(expected, previousCell)`: 期待座標を最寄りの整数マスに丸めて現在マスとするが、
  期待座標と前回のマスの座標との距離が `CELL_HYSTERESIS`(仮値: 0.65)以下ならマスを切り替えず
  前回の値を維持する(チラつき防止)

`docs/app.js` はサーバー回答が「不明」(確率0.4未満)でない限り、判定のたびにこの2関数で現在マスを
更新し、テンプレートの自動選択・`buildInstruction`・矢印の目標算出に使います。位置が「不明」の場合は
これまで通りマスをリセットします(仕様の「不明時の扱いは現行どおり」に対応)。

画角ガイドの矢印は、この連続的な期待座標(丸める前の値)を起点として目標マスの中心へ描きます
(仕様の「矢印は期待座標から目標マスの中心へ描く」に対応)。破線の現在マス表示自体は、従来どおり
ヒステリシス適用後の離散マスを使っています。

## 指示エンジン(今どの1つを伝えるか)

これまでは画角ガイド(位置・大きさのズレ)だけを表示していましたが、ブレ・傾き・明るさといった
端末側の問題や、新設した `main_problem`/`subject_cut`/`distraction`/`backlight` の回答も踏まえて
「今いちばん優先して直すべきこと」を1つに絞って表示するようにしました。ロジックは
`docs/instructions.js`(純関数)に、しきい値・文言は `docs/instruction_rules.json` に分けています。

優先順位(数字が小さいほど優先。しきい値・文言はすべて仮置きで、旅行のログを見てから見直します):

1. `device:blur` — 静止していて、ブレスコアが35未満(動いている間は出さない)
2. `device:tilt` — センサーがあり、傾きの絶対値が4°以上(向きは使わない)
3. `device:brightness` — 明るさスコアが40未満
4. `server:main_problem` — `main_problem` の確率が0.4以上で、値が `none` 以外
5. `server:noul` — 質問セットCのときのみ。`subject_cut`/`distraction`/`backlight` の値(確率)が
   0.5以上のとき、対応する文言を表示する(`distraction`は`background_busy`と同じ文言、`backlight`は
   `backlight_dark`と同じ文言を使う)。`main_problem` と同じ内容になる場合は重複させない
6. `composition` — 現行の `buildInstruction`(位置・大きさ)
7. `done` — 6が達成状態のときの終端表示(「この構図で撮影」)

主指示の切り替えは、チラつき防止のため前回の切り替えから1.5秒以上経ってから行います
(`createInstructionSwitcher`)。ただし `done` への切り替え・`done` から他の指示への切り替えは即時です。

表示モードは設定ダイアログの「表示モード」、またはURLの `?ui=single|multi` で切り替えます(既定はmulti)。

- **multi**(既定): 従来のガイド画面の構成を維持し、その中の指示文(`#instructionText`)がこの
  指示エンジンの主指示になります
- **single**: 主指示だけを大きく(22.4px、実機のブラウザ既定フォントサイズ16pxに対して1.4rem。
  仕様の「20px以上」を満たす)表示し、指標・テンプレート選択・判定結果パネルなど他の情報は非表示にします

どちらのモードでも主指示の計算・記録(ログ)は同じロジックで行います。指示の表示エリアには
「伝わった」「分かりにくい」の小さなボタンを1組置いており、押すと表示中の指示IDに紐付けて記録されます
(任意、複数回押しても構いません)。

Playwrightのフェイクカメラを使い、`?mock=1` で質問セットA/B/C×表示モードsingle/multiの塆6通りを
実際のChromium上で確認しました。いずれもコンソールエラー無く、判定→指示表示→撮影→ログ記録まで
一通り動作しています(single時に `#metrics` 等が非表示になり `#instructionText` が22.4pxで
表示されることも確認済み)。ただし、これは合成映像(フェイクデバイス)上での確認であり、実機のカメラ・
実際の判定APIでの確認ではありません。

## ズーム・オートフォーカス

`MediaStreamTrack` の `getCapabilities()`/`applyConstraints()`(主にAndroid Chrome系で対応している
非標準の拡張API)を使い、対応している端末・ブラウザでのみ動作します。

- **オートフォーカス**: カメラ開始時に、`focusMode` capabilityに `"continuous"` が含まれていれば
  `applyConstraints({ advanced: [{ focusMode: "continuous" }] })` を1回呼び、連続オートフォーカスを
  明示的に有効化します。UI操作は不要です。対応していない端末では何もしません
  (多くの端末はJSからの制御が無くても既定でオートフォーカスが効くため、実害はありません)。
- **ズーム**: `zoom` capability(`{min, max, step}`)が取得できた場合のみ、カメラ映像の下に
  ズームスライダー(`#zoomSection`)を表示します。あわせて、カメラ映像上を2本指でピンチすると
  `docs/analyze.js` の `touchDistance`/`zoomFromPinch`(ピンチ開始時からの指の距離比でズーム値を
  計算する純関数)でズーム値を計算し、スライダーと同じ `applyConstraints` 経路でズームを反映します。
  非対応の端末ではスライダーごと非表示になります。

**注意**: `zoom`/`focusMode` はW3Cの正式な標準ではなく、ブラウザ・端末ごとの対応状況にばらつきがある
拡張APIです。特にiOS Safariは(このプロトタイプ作成時点で)対応していないことが多く、その場合は
ズームスライダーが表示されずピンチ操作も効きません(エラーにはならず、通常のカメラ表示のまま動作します)。

## ログ(イベント形式 v2)

これまでのログ(`haeApp.log.v1`、数値だけの1判定=1レコード形式)に代え、`haeApp.log.v2` として
イベント形式に切り替えました。「指示がいつ表示され、どう解消し、伝わったと感じたか」「撮影した時点で
主指示が達成状態だったか」「撮影後の満足度」まで含めて時系列で追えるようにするためです。`haeApp.log.v1`
キー自体は削除せず読み取り専用で残しており、「ログをJSONで書き出す」でエクスポートしたJSONには
新形式(`events`)と旧形式(`legacyV1`)の両方がそのまま含まれます(スキーマ: `{ schemaVersion: 2,
exportedAt, events: [...], legacyV1: [...] }`)。

記録するイベントの種類(`docs/app.js` の `logEvent`):

| type | 主なフィールド | 記録タイミング |
|---|---|---|
| `instruction_shown` | `instructionId, kind, text, questionSet, uiMode, sceneAtShown, cellAtShown` | 主指示が切り替わったとき |
| `instruction_resolved` | `instructionId, result(achieved/superseded/shutter), elapsedMs` | 直前の主指示が別の指示に置き換わる/撮影で打ち切られるとき |
| `instruction_feedback` | `instructionId, understood` | 「伝わった/分かりにくい」ボタンを押したとき |
| `judge` | `model, questionSet, scene, ..., probabilities, responseTimeMs, thumbnail, feedback` | 判定APIの応答を受け取ったとき |
| `shutter` | `shutterId, questionSet, uiMode, primaryInstructionId, primaryState, deviceMetrics, lastJudge` | 撮影ボタンを押したとき |
| `shot_rating` | `shutterId, rating(up/down)` | 撮影直後の満足度バンドで👍/👎を押したとき |

補足:

- `judge` イベントは、実際にその質問セットで問い合わせた項目のキーだけを載せます(セットに含まれない
  項目のキー自体を省略します)。そうしないと「質問していない項目」まで不明として集計されてしまうためです
- `judge` イベントには、応答の `model`・`questionSet`・choice/score型の全 `probabilities`(小数3桁に
  丸め)・応答時間(`responseTimeMs`)を追加しました。数値はイベント全体で小数3桁に丸めています
- `instruction_resolved` の `result` は、`achieved`(その指示自身の解消条件が実際に満たされた)・
  `superseded`(単に別の指示に押しのけられただけ)・`shutter`(撮影ボタンが押された時点で未解決だった)の
  3種類です。解消条件は `docs/instructions.js` の `isInstructionAchieved` にまとめています
  (例: ブレはスコア50以上、傾きは2°未満、`main_problem`系はその値が選ばれなくなったとき)
- サムネイル画像は `judge` イベントにのみ含まれ、`instruction_*`/`shutter`/`shot_rating` には含めません
- `localStorage` の容量上限に達すると保存に失敗するため、`saveLog`(v2)は保存に失敗した場合、まず
  古い `judge` イベントのサムネイルから間引き、それでも入らなければ古いイベントそのものを間引きます
  (仕様どおり、画像を優先的に消してからイベント自体を消す2段構え)
- APIキー同様、ログの中身(サムネイル含む)はこの端末のブラウザ内にのみ残り、リポジトリ・サーバーには
  送られません

## 撮影ボタン

カメラ映像の下に「撮影する」ボタンを新設しました(以前のバージョンには無かった機能です)。押すと
`video` のフレームを `videoWidth`×`videoHeight` のJPEG(品質0.92)にし、`navigator.share({ files })`が
使えればOS標準の共有シートを、使えなければファイルダウンロードにフォールバックします。画像そのものは
アプリの状態にもログにも一切保存しません(この撮影ボタンで保存する写真と、判定用にAPIへ送るフレームは
完全に別物です)。撮影時点で主指示が未解決だった場合は、その指示に `instruction_resolved`
(`result: "shutter"`)を記録したうえで、`shutter` イベント自体も記録します。

撮影の3秒後まで「この写真に満足?👍/👎」という帯を表示し、押すとその撮影(`shutterId`)に紐付けて
`shot_rating` イベントを記録します(押さなくてもよく、3秒で自動的に消えます)。

Playwrightのフェイクカメラ上で撮影ボタンのクリック・満足度バンドの表示・ログ記録までは確認できました
(共有シートは実機のOS機能のためこの環境では呼び出されず未確認です)。**iOS Safariでの
`navigator.share`/共有シートの実際の挙動、およびダウンロードへのフォールバックが実際に機能するかは
未確認です**。

## 集計スクリプト(scripts/summarize_log.mjs)

書き出したログJSON(`{ events, legacyV1 }` 形式、または合成ログのようなイベント配列そのもの)を渡すと、
質問セット×表示モードごとに以下をテキスト表で標準出力に出します。

```
node scripts/summarize_log.mjs hae-app-log-XXXXXXXXXX.json
```

- 指示の表示回数(kind別)・伝わった率(伝わった/(伝わった+分かりにくい)、回答数併記)
- 解消率(achieved/表示)と解消までの時間の中央値
- 撮影数、primaryState別の満足率、achievedの撮影とそうでない撮影の満足率の差
- `main_problem` の値の分布と、その指示の解消率
- 各質問の「不明」の割合、判定の応答時間の中央値とp95
- 件数(n)い30未満の集計には「※参考値」と表示します

**注意(近似であることの明記)**: `instruction_resolved`/`instruction_feedback`/`judge` イベント自体は
仕様どおり `questionSet`/`uiMode` を持たないため、直近の `instruction_shown` イベントから推定して
グルーピングしています(通常はセッション中に質問セット・表示モードを頻繁には変えない前提の近似値です)。
「各質問の不明割合」は、ログに載っている主要フィールド(`scene`/`subject_pos`/`main_problem`/
`skill_level`/`template_match`)のみが対象です。

`tests/fixtures/synthetic_log.json` に、動作確認用の**合成ログ(実データではありません)**を用意して
おり、`tests/summarize_log.test.js` でこのスクリプトの集計ロジックを検証しています。

## 旅行テスト手順

1. 出発前に、設定ダイアログでAPIキー・エンドポイント(Cloudflare Workers中継のURL)を入力して保存する
2. 試したい組み合わせをURLで開く(例: `https://<...>/?qs=B&ui=single`)か、設定ダイアログで
   「質問セット」「表示モード」を切り替える。画面上部に常に今の組み合わせが小さく表示されるので、
   記録を見返すときの取り違えを防げる
3. **人物が写る場面では、自動送信(画面上部のトグル、または設定ダイアログ内のトグル)をOFFにする**。
   意図せず人物の顔がAPIへ繰り返し送信されるのを避けるため、周囲に人がいる/写り込む場面では手動の
   「今すぐ判定」に切り替える
4. 表示された主指示が実際に伝わったかどうかを、「伝わった」「分かりにくい」ボタンでその都度記録する
5. シャッターチャンスでは「撮影する」ボタンで撮影する(共有シートまたはダウンロードで端末に保存される)。
   撮影直後に出る👍/👎で、その写真の満足度も記録する
6. 質問セットB/Cで判定が繰り返し失敗する場合、実APIが新設項目を受け付けていない可能性があります。
   自動的に質問セットAへ切り替わり、画面に通知が出るのでそのまま使い続けて問題ありません
7. 帰宅後(または移動中の空き時間)、「ログをJSONで書き出す」でファイルを保存する
8. パソコン等で `node scripts/summarize_log.mjs <書き出したファイル>` を実行し、質問セット×表示モード
   ごとの「伝わった率」「解消率」「満足率」「main_problemの分布」「不明割合」「応答時間」を見比べ、
   しきい値(`docs/instruction_rules.json`)やどの質問セットを既定にするかを見直す材料にする

## テスト

```
npm test
```

(内部的には `node --test` を実行します。)

- `tests/guide.test.js`: `parseAnswers`(実フィクスチャ・新設項目・型違い/欠落応答のケース含む)・
  `cellToRC`・`selectTemplate`・`buildTemplateMatchQuestion`・`resolveTemplate`(手動選択/自動選択/
  サーバー判定の新しい優先順位)・`buildInstruction`・`buildActiveQuestions`・`collectProbabilities`・
  `expectedCell`・`pickCurrentCell`(境界・ヒステリシス)を検証
- `tests/instructions.test.js`: `evaluateInstruction`の優先順位・しきい値・重複排除、
  `isInstructionAchieved`の各kindの解消判定、`createInstructionSwitcher`のデバウンス・done即時切替を検証
- `tests/summarize_log.test.js`: `scripts/summarize_log.mjs` の集計ロジックを、
  `tests/fixtures/synthetic_log.json`(合成ログ、実データではない)に対して検証

これらすべて含めて **78件のテストがすべてパスすることを確認済みです**(`npm test` / `node --test`)。

`docs/analyze.js`(ブレ・明るさ・水平・静止判定・ピンチ)と `docs/app.js`(カメラ・UI結線・API通信)は、
Node環境では動かせない(カメラ・センサー・DOM・ネットワーク前提の)コードのため、`node --test` による
自動テストは用意していません。`analyze.js` の主要な数式については、Node上で個別に手動実行して
期待どおりの値が返ることを確認しました(例: `blurScore(1000)` → 100、`brightnessScore(125, 0)` → 100)。

`docs/app.js` については、Playwright(Chromiumのフェイクカメラ機能、`--use-fake-device-for-media-stream`)
を使い、このクラウド環境でも次の3点を実際のブラウザで確認しました(このセッションで作成した一時的な
確認用スクリプトによるもので、リポジトリには含めていません)。

1. `?mock=1` で質問セットA/B/C×表示モードsingle/multiの塆6通りが、コンソールエラー無く
   カメラ開始→判定→指示表示→撮影→ログ記録まで一通り動くこと
   (single時に`#metrics`等が非表示になり`#instructionText`が22.4px相当になることも確認)
2. 質問セットB/Cでモックサーバーが400を返すと、実際に質問セットAへ自動フォールバックし、
   画面上部の表示が「(自動切替中)」になり、通知バナーが一度表示されること
3. 上記いずれもJavaScriptの例外・コンソールエラーが発生しないこと

ただし、これは合成カメラ映像(フェイクデバイス)・モックまたは疑似サーバーでの確認であり、
実機のカメラ・実際の判定APIでの確認ではありません。

## 仮定(指示に明記が無かった点)

- `scene`/`subject_pos` の「確率」は `probabilities[choice]` とし、`confidence` フィールドとは区別した
  (hae_photoでの確認結果を踏襲)
- テンプレートの `instruction` 文言は明示されていなかったため、独自に作成した
- 静止判定・EMA・各種しきい値は指示の数式・値をそのまま実装した(ブレ: log10、明るさ: 平均輝度+
  黒つぶれ/白飛び合算、水平: 90°ごとの偏差、静止: 平均絶対差<3が6フレーム連続)
- サイズ判定の「近づく/離れる」は `size < min-0.5` / `size > max+0.5` とした(指示の式をそのまま使用)
- グレースケール化はITU-R BT.601の輝度係数(0.299/0.587/0.114)を用いた
- APIリクエストのタイムアウトは15秒、ネットワークエラー・タイムアウト時のみ最大1回まで再送する
  こととした(HTTPエラー応答、例えば認証エラーは再送しても解決しないため対象外とした)。この方針は
  hae_photoには実装が無かったため、本リポジトリで新たに設計した
  (仕様側もこの点を明記していなかったため仮定として扱う)
- 位置ガイドの矢印・枠はCanvas 2Dに自前で描画し、外部の図形・アイコンライブラリは使っていない
- 画面の並び順は、カメラ映像のすぐ下に画角ガイド(`#guidancePanel`)と判定結果(`#resultPanel`)を置き、
  その次にズーム・撮影ボタン・センサー許可ボタン・「自動送信/今すぐ判定」の操作パネル(`#controls`)・
  指標という構成にした(実機での旅行テストで「判定結果がカメラ映像の真下にない」との指摘を受けて
  修正。判定結果を確認する頻度が最も高いため、スクロールなしで見える位置を優先した)
- Cloudflare Workers中継の `ALLOWED_ORIGIN` は既定で `*`(プロトタイプ用途。本番ではPagesのオリジンに
  絞る想定)とした
- ログはAPIレスポンスの数値に加え、判定結果とどの写真が対応するか分かるよう縮小サムネイル
  (長辺160px・JPEG quality 0.5)も保存する。サムネイルは端末のブラウザ内にのみ残り、
  リポジトリ・サーバーには送らない
- 自動送信のON/OFFは、メイン画面のトグルと設定ダイアログ内のトグルの両方に置き、常に同じ値に
  同期するようにした(機能2「自動送信のON/OFFと手動の判定ボタン」と、機能4「設定パネルに自動送信の
  ON/OFF」の両方を満たすため)
- favicon未指定による404を避けるため `<link rel="icon" href="data:,">` を追加した(見た目に影響しない
  最小限の変更)
- ズームUIはスライダー(数値操作)とピンチ操作の両方を用意した。ピンチ操作だけだと微調整しづらく、
  スライダーだけだと直感的なズーム操作ができないため、両方使えるようにした
- オートフォーカスは明示的なUI操作(ボタン等)を設けず、対応端末では常に連続オートフォーカスへ
  自動的に切り替える方針とした(指示が「自動で合わせる」だったため、手動オンオフの選択肢は設けていない)
- `resolveTemplate` の優先順位を「手動 > サーバー判定 > 自動」から「手動 > 自動 > サーバー判定」に
  変更した(仕様の「手動テンプレート > 決定的選択 > サーバーのtemplate_match」に対応する意図的な変更。
  template_matchも既定OFFにしたため、既定動作では従来と体感上の差は無い)
- `server:noul` の重複排除(「main_problemと同じ内容は重複させない」)は、main_problem自体が
  しきい値(0.4)未満で不採用の場合でも、その**生の選択肢**(`mainProblemRaw`)が同じカテゴリなら
  noul側もスキップする、という解釈で実装した(優先順位上は main_problem が先に評価されるため、
  main_problemが採用された場合はそもそもnoul側の評価に到達しない)
- `instruction_resolved` の `achieved` 判定は、device系は仕様の達成しきい値(ブレ50以上・傾き2°未満・
  明るさ55以上)、`server:main_problem:*`はその値が次の判定で選ばれなくなったとき、`server:noul:*`は
  対応する値が0.5未満になったとき、`composition`は`buildInstruction`のachievedフラグ、とした
  (仕様が「次のサーバー判定で該当条件が解消したとき」とだけ述べていたため、具体的な判定方法は
  各質問の意味から妥当と考えられる形で補った)
- `shutter` イベントの `lastJudge`(「lastJudgeの要約」)は、`time`/`scene`/`haeScore`/`snsWorthy`/
  `mainProblem`/`templateId` の6項目とした(仕様が「要約」とだけ述べ具体的な項目を指定していなかったため)
- `judge` イベントは、実際に問い合わせた質問セットに含まれる項目のキーだけを載せる(含まれない項目は
  キーごと省略する)方針とした。載せない理由は「質問ごとの不明割合」等の集計が、質問していない項目まで
  不明として数えてしまい誤解を招くため
- `scripts/summarize_log.mjs` で `instruction_resolved`/`instruction_feedback`/`judge` を質問セット×
  表示モードごとに集計する際、これらのイベント自体は(仕様どおり)questionSet/uiModeを持たないため、
  直近の `instruction_shown` イベントから推定してグルーピングする近似方式にした(セッション中に頻繁には
  切り替えない前提の近似であり、厳密な値ではないことをスクリプトの出力・本 READMEの両方に明記した)

## 未確認事項(このクラウド環境では確認できなかった項目)

- 実機のカメラプレビュー・オートフォーカス・露光の見え方
- 実機の `devicemotion`(`accelerationIncludingGravity`)の値の妥当性、および実際の傾き検出の精度
- iOSでの `DeviceMotionEvent.requestPermission()` の実際の許可ダイアログ挙動
- 実際のスマホ縦持ち画面での操作しやすさ・文字サイズ・タップ領域の妥当性
- Cloudflare Workers中継の実デプロイ・実際の疎通(手順は書いたが未デプロイ)
- GitHub Pages公開後の実URLでの動作(このセッションでは `main`/`docs` へのマージとPages有効化は行っていない)
- 長時間の自動送信運用でのAPIレート制限・コストの実際の挙動
- 追加したリトライ・タイムアウトの方針が、実際のapi.codiv.aiの挙動(レート制限やタイムアウト特性)に
  対して適切かどうか
- 新設した `template_match` 質問(テンプレート一覧からの構図マッチング)に対して、APIが
  `scene`/`subject_pos` と同じ `choice` 形式で答えてくれるかどうか(hae_photoでは未確認の項目のため)
- 新設した `skill_level`/`lighting_quality`/`color_harmony`/`background_clutter` の各質問に対して、
  APIが期待どおりの構造・妥当な分布(SNS映え確率のように極端な値に偏らないか)で答えてくれるかどうか
  (hae_photoでは未確認の項目のため)
- 実機での `MediaStreamTrack.getCapabilities()`/`applyConstraints()` によるズーム・オートフォーカス
  制御の対応状況(特にiOS Safariでの動作)、およびピンチ操作でのズームの実際の操作感
- 実機のブラウザでの実際の `localStorage` 容量上限、およびサムネイル付きログがその上限に達するまでの
  実際の記録件数・運用時間(このクラウド環境では実ブラウザでの長時間の蓄積を確認できないため)
- 新設した `main_problem`/`subject_cut`/`distraction`/`backlight` の各質問に対して、実APIが期待どおりの
  構造・妥当な分布で答えてくれるかどうか(hae_photoでは未確認の項目のため)。質問セットB/Cが実際に
  4xxを返すかどうか自体も未確認(4xxが返った場合の自動フォールバック処理自体はモックサーバーで確認済み)
- `docs/instruction_rules.json` のしきい値・文言(ブレ35/50、傾き4°/2°、明るさ40/55、noul確率0.5等)が
  実際の端末・実際の判定APIの分布に対して適切かどうか。すべて仮置きで、旅行のログを見てから見直す前提
- `server:main_problem`/`server:noul` の解消判定が「次のサーバー判定」を待つ設計であるため、判定の
  間隔(自動送信は最短3秒間隔)より短い時間で実際に問題が解消しても、次に判定が来るまでは指示が
  表示され続ける(=ログ上の解消までの時間が、実際の解消よりも判定間隔ぶん長く出る可能性がある)
- 実機のiOS Safariでの `navigator.share`(共有シート)の実際の挙動、および共有非対応時の
  ダウンロードへのフォールバックが実際に機能するか(Playwrightのフェイクカメラでは、撮影ボタンの
  クリック・ログ記録までは確認できたが、OSの共有シート自体は呼び出されないため未確認)
- 実機のスマホ縦持ち画面での、single表示モードの大きな主指示テキストの実際の見やすさ・行数
- 単一指示に絞ったことで、実際に「何を直せばよいか」が複数指示併記時より伝わりやすくなっているか
  (これ自体が今回の旅行テストで検証したい主目的であり、根拠となる実測データはまだ無い)
