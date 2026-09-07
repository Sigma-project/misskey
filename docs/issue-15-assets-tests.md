# Issue #15: 判定回帰テスト・チュートリアル画像の実装記録

対象計画: [issue-15-plan.md](issue-15-plan.md)。実装許可は同計画の「実装許可の記録」に従う。

## 採用方針

- 判定サービス本体は変更せず、`FileInfoService.getFileInfo` と実際の画像コーデックを通して AI 境界を検証する。
- JPEG / PNG / 透過あり・なし WebP / 透過あり・なし JXL を使い、送信バッファの PNG シグネチャ、299×299、3 channels、alpha なし、raw デコード成功を確認する。
- WebP と JXL それぞれで Sexy / Hentai / Porn の閾値前後・同値、Porn 専用閾値、分類結果なし・Neutral・Drawing、skip オプションを検証する。
- PNG のヘッダーを残してデータを切り詰めた一時ファイルを使い、実デコード失敗の warning と AI 未呼び出しを確認する。テストのために変換処理をモックしない。
- 既存 WebP からチュートリアル用 JXL をロスレス生成し、画像の内容・寸法を維持する。3 Vue の既存参照・MIME を利用する。

## 検証状態

対象テストファイルの ESLint は成功。JXL 対応 libvips 8.18.3 / sharp 0.35.3 の Docker 環境で下記生成と画素一致検証に成功。内部ワークスペース（i18n / misskey-js / misskey-reversi）と build-pre / backend build:unit をビルドし、`tsc -p test --noEmit` は成功。FileInfoService の既存15件＋追加29件、全44件が成功した。初回は開発用コンテナの ffprobe 不在で既存音声テスト2件が失敗したが、ffmpeg を入れた同環境で全件再実行して成功し、コード変更は不要だった。ブラウザ検証・全体 lint は統合検証側で継続する。

API、DB entity / migration、locale、Vue の変更はないため、それらの生成・migration 検証・専門 Vue レビューは非該当。CHANGELOG、全体 lint と統合検証は #15 の Docker 改修と合わせて実施する。


## チュートリアル JXL 生成（2026-09-07）

一回の Node コマンドで2枚を生成した。生成物コミット: `3b70ee9d3f`。JXL 対応 sharp を利用できるリポジトリルートでの生成処理は次のとおり（Node 26.4.0、sharp 0.35.3、libvips 8.18.3）。

```js
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const sharp = createRequire(resolve('packages/backend/package.json'))('sharp');
for (const name of ['ai', 'natto_failed']) {
  await sharp(`packages/frontend/assets/tutorial/${name}.webp`)
    .jxl({ lossless: true, effort: 9 })
    .toFile(`packages/frontend/assets/tutorial/${name}.jxl`);
}
```

実行時は検証用 `misskey-issue15-vips:dev` コンテナに作業ツリーを `/misskey` としてマウントし、上記生成処理とデコード後の raw 画素・寸法・channels 完全一致検証を含む Node スクリプトを一回実行した。ai は 320×320 / RGB、natto_failed は 256×256 / RGBA。両画像とも元 WebP のデコード結果と全画素一致し、JXL metadata/decode に成功した。既存の Note / PostNote の ai.jxl、Sensitive の natto_failed.jxl と image/jxl 指定に整合する。

| 出力 | SHA-256 |
| --- | --- |
| `packages/frontend/assets/tutorial/ai.jxl` | `83a3c5768b7e3d8b2c0d115551a8203623f19ddc4a4c5d7ef1c63e66e734557f` |
| `packages/frontend/assets/tutorial/natto_failed.jxl` | `d1c086b12c5b8d2156ee0990d39dfcc2fcd5fe9c332a7133de0f359bac1f2af6` |


検証コマンド（上記 Docker 環境の `packages/backend` 内）:

```sh
pnpm exec eslint test/unit/FileInfoService.ts
pnpm exec tsc -p test --noEmit
pnpm exec vitest --config vitest.config.unit.ts --run test/unit/FileInfoService.ts
```

`.config/test.yml` は既存 CI テンプレートからコピーしている。最終 Vitest 実行は 44 passed / 1 file passed、4.45秒。生成・ビルドで追跡対象のコード生成差分はなく、JXL 2枚だけを専用生成物コミットへ保存した。

## 全体 lint・実アプリでの確認（2026-09-07）

`pnpm lint` を JXL 対応コンテナで実行した。最初の実行は15 workspace中13成功、frontend と frontend-builder が失敗。frontend は未ビルドの内部 `misskey-bubble-game` を参照していたため同 package をビルドし、frontend の `vue-tsc --noEmit` と ESLint を再実行して成功した。frontend-builder の失敗は `@oxc-project/types` 0.139.0 / 0.127.0 の二重バージョンによる既知の upstream 型不一致で、AGENTS.md の明示された例外に一致する。frontend-builder の ESLint は別途実行して成功した。backend は本節の MIME 修正後にも3種の型検査と ESLint を再実行して成功。全体 lint の `&&` 後段で未実行だった `node scripts/check-dts.mjs` は別途実行して18ファイル成功した。型例外を除く workspace の検証が成功したことと、全体コマンド自体の終了コードが1だったことを区別する。

### 実画面と静的配信 MIME の修正

最終 runtime イメージ `misskey-issue15:verify` を専用 Postgres / Redis とともに `http://127.0.0.1:61815` へ起動した。既存DBは共有せず、検証用管理者アカウントを作成し、単一ユーザー・連合無効のローカル環境で確認した。静的HTMLの代替ページではなく実アプリの「More → About → Start Tutorial」を操作した。

初回HTTP検証では2枚とも200だが Content-Type が `application/octet-stream` だった。`@fastify/static` の既定 MIME データベースが `.jxl` を認識しないため、`ClientServerService` の `/client-assets/` 登録へ `setHeaders` を追加し、JXL のみ `image/jxl` にする。別形式のヘッダーは変更しない。修正済み backend をビルドし、同じ runtime イメージへ backend build 出力を読み取り専用マウントして実応答を再検証した。

| 実リクエスト | HTTP | Content-Type | bytes |
| --- | --- | --- | --- |
| `/client-assets/tutorial/ai.jxl` | 200 | `image/jxl` | 77993 |
| `/client-assets/tutorial/natto_failed.jxl` | 200 | `image/jxl` | 11210 |
| `/client-assets/tutorial/timeline_tab.png` | 200 | `image/png` | 2860 |

ブラウザは agent-browser 0.35.1 / HeadlessChrome 152.0.0.0 を利用した。このブラウザでは JXL が既定無効で、正しい `image/jxl` Blob にしても画像デコードに失敗した。Chromium の [JXL 実装・feature flag](https://chromium.googlesource.com/chromium/src/tools/+/bdbf9c9cab1e1e14f37692c207165af1942ce422)を確認し、`--args '--enable-features=JXLImageFormat'` 付きで再起動した。以降は2枚ともブラウザで実デコードに成功した。JXL対応ブラウザでの検証であり、既定でJXL非対応のブラウザへ表示保証を拡張しない。これはユーザーが確定したJXL追加方針を変更する判断ではない。

- Note 画面: ai.jxl を表示し、`naturalWidth=320` / `naturalHeight=320` を確認。スクリーンショットを目視確認。
- PostNote 画面: サンプルノートの ai.jxl が320×320としてロード。画面表示とコンテンツ警告のサンプルを確認。
- Sensitive 画面: 添付 natto_failed.jxl の256×256デコード、メニューから「Mark as sensitive」、センシティブアイコン、Continue の有効化、「Show preview」の隠された状態、「Click to show」操作後の画像表示を確認。実プレビューの画像を目視確認し、ブラウザ例外一覧は空だった。

ローカル証跡は `/tmp/issue15-tutorial-note-jxl.png`、`/tmp/issue15-tutorial-postnote-jxl.png`、`/tmp/issue15-tutorial-sensitive-preview-visible.png`。MIME修正を含む最終Docker再ビルド・そのイメージでの再確認と、Opus / subagent の再レビューは統合側で継続する。

## 既存アップロード E2E と最終 runtime の画像パイプライン（2026-09-07）

既存 `test/e2e/endpoints.ts` の `drive/files/create` グループを `vitest --config vitest.config.e2e.ts --run test/e2e/endpoints.ts -t drive/files/create` で実行し、15件すべて成功した（同ファイルの残り79件は指定フィルタによる除外）。所要17.43秒。透過あり・なし WebP / AVIF / JXL のアップロード、ノート作成、ActivityPub 添付の `mediaType === image/jxl` を検証する既存6ケースを含む。独立した compose project `issue15-e2e` の Postgres / Redis を使用し、既存テストDB・#18のDB・browser用DBには触れていない。内部のアプリportは61816、ホストポート公開なし。初回は `--ignore-scripts` で導入したホスト依存の re2 バイナリが欠落して起動に失敗し、re2 の既存 install スクリプトで配布バイナリを配置後に再実行して成功した。テストやアプリコードをこの環境調整のために変更していない。

MIME修正を含む最終イメージ `misskey-issue15:verify`（`sha256:bd36d2374308b716388130a1ef01b28e09e73cf8df2b21d358611cfbdd8d16c0`）で browser 用アプリを再作成し、再確認した。`docker inspect` で mount は `/misskey/.config/default.yml` のみで、backendビルドやnode_modulesのホストマウントがないことを確認した。

最終アプリへ WebP / JXL / JPEG の実fixtureを multipart アップロードし、ノートAPIから公開添付URLを取得した。webpublic、thumbnailUrl、`/proxy/static.jxl?url=...&static=1` の全応答について HTTP200、`Content-Type: image/jxl`、sharp metadataのformat=jxl、rawデコードと正の寸法を検証して成功した。ブラウザ環境は連合無効なのでActivityPub GETは設定通り403となり、ここではノートAPI公開添付URLを使用した。ActivityPubのmediaTypeは前段の既存E2Eで検証済み。

| アップロード入力 | upload | webpublic | thumbnail | media proxy |
| --- | --- | --- | --- | --- |
| `with-alpha.webp` | 200 | 200 / JXL / 256×256 | 200 / JXL / 256×256 | 200 / JXL / 256×256 |
| `with-alpha.jxl` | 200 | 200 / JXL / 256×256 | 200 / JXL / 256×256 | 200 / JXL / 256×256 |
| `192.jpg` | 200 | 200 / JXL / 192×192 | 200 / JXL / 192×192 | 200 / JXL / 192×192 |

最終イメージからの tutorial2枚もHTTP200/image-jxlと実デコードに成功。JXLImageFormat有効のChromium152でアプリ画面のロードを再確認し、ai=320×320 / natto_failed=256×256のブラウザデコードを再確認した。ログは `/tmp/issue15-upload-e2e.log`、`/tmp/issue15-runtime-pipeline.log`。本節で前節の「最終Docker再ビルド・そのイメージでの再確認」の残作業は完了した。
