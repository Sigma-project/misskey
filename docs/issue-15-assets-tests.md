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
