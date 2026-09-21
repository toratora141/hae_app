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
3. 「カメラを開始」を押し、背面カメラでプレビューを表示する
4. iOSの場合は「センサーの利用を許可」ボタンで水平センサーの利用を許可する
5. 画面が静止すると自動で1枚だけAPIに送信され、判定結果と画角ガイド(矢印・枠)が表示される
   - 自動送信はオフにでき、その場合は「今すぐ判定」ボタンで手動送信する
6. 判定結果の👍/👎でフィードバックを記録できる。「ログをJSONで書き出す」でこれまでの記録を保存できる
7. テンプレート(構図)は自動選択されるが、チップから手動で選ぶと自動選択より優先される

動作確認だけしたい場合は、URLに `?mock=1` を付けて開くとAPIを呼ばずに疑似応答で一通り動作します
(設定ダイアログの「モックモード」トグルからも切り替え可能です)。

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
  "questions": { ... docs/questions.json ... }
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

## テスト

```
npm test
```

(内部的には `node --test` を実行します。)

`tests/guide.test.js` で `parseAnswers`(実フィクスチャ使用)・`cellToRC`・`selectTemplate`・
`buildInstruction`(左右上下・サイズ・不明・達成の各ケース)を検証しています。19件すべてパスすることを
確認済みです。

`docs/analyze.js`(ブレ・明るさ・水平・静止判定)と `docs/app.js`(カメラ・UI結線・API通信)は、
Node環境では動かせない(カメラ・センサー・DOM・ネットワーク前提の)コードのため自動テストは
用意していません。`analyze.js` の主要な数式については、Node上で個別に手動実行して期待どおりの
値が返ることを確認しました(例: `blurScore(1000)` → 100、`brightnessScore(125, 0)` → 100)。

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
- Cloudflare Workers中継の `ALLOWED_ORIGIN` は既定で `*`(プロトタイプ用途。本番ではPagesのオリジンに
  絞る想定)とした
- ログはAPIレスポンスの数値のみを保存し、画像やタイムスタンプ以外の生データは保持しない
- 自動送信のON/OFFは、メイン画面のトグルと設定ダイアログ内のトグルの両方に置き、常に同じ値に
  同期するようにした(機能2「自動送信のON/OFFと手動の判定ボタン」と、機能4「設定パネルに自動送信の
  ON/OFF」の両方を満たすため)
- favicon未指定による404を避けるため `<link rel="icon" href="data:,">` を追加した(見た目に影響しない
  最小限の変更)

## 未確認事項(このクラウド環境では確認できなかった項目)

- 実機のカメラプレビュー・オートフォーカス・露出の見え方
- 実機の `devicemotion`(`accelerationIncludingGravity`)の値の妥当性、および実際の傾き検出の精度
- iOSでの `DeviceMotionEvent.requestPermission()` の実際の許可ダイアログ挙動
- 実際のスマホ縦持ち画面での操作しやすさ・文字サイズ・タップ領域の妥当性
- Cloudflare Workers中継の実デプロイ・実際の疎通(手順は書いたが未デプロイ)
- GitHub Pages公開後の実URLでの動作(このセッションでは `main`/`docs` へのマージとPages有効化は行っていない)
- 長時間の自動送信運用でのAPIレート制限・コストの実際の挙動
- 追加したリトライ・タイムアウトの方針が、実際のapi.codiv.aiの挙動(レート制限やタイムアウト特性)に
  対して適切かどうか
