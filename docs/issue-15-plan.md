# Issue #15: JXL 移行回帰の解消計画

- 対象: https://github.com/Sigma-project/misskey/issues/15
- 調査日: 2026-09-07
- 基準: `origin/master` = `2b006ee066e6360957a0c37c42569a23273c35ff`。作業ツリーは古いので、最新ファイルは `git show origin/master:<path>` で確認した。
- 現在の状態: 2026-09-07の明示的な実装許可に基づき実装済み。Opus 5 / 独立subagentのコードレビューは収束。PR [#20](https://github.com/Sigma-project/misskey/pull/20) は最新コミットの全39 CI成功を確認しマージ済み。以降の調査・計画節は実装前の履歴であり、実行結果は [Docker実装記録](issue-15-docker.md) / [画像・テスト実装記録](issue-15-assets-tests.md) を参照。
- 共通手順: [issue 計画一覧](issue-plans.md)。画像形式と実行方式のユーザー判断は後述。

## 要件・制約

1. WebP/JXL のセンシティブ判定が画像形式によって迂回されないこと。
2. Docker の最終実行イメージで JXL 読み書きが動作すること。
3. チュートリアル画像の参照先が実在し、表示・センシティブ切替が動作すること。
4. 最新 `AGENTS.md` の不変条件に従い、サーバーの画像出力は JXL、sharp はグローバル JXL 対応 libvips にリンクする。WASM による既存アニメーション処理は維持する。
5. Node / pnpm は mise 管理。コード・生成物は機能単位、生成コマンドの出力は実行ごとに別コミット。実装時は backend/frontend の該当スキル、出荷時は shipping-misskey-change を参照する。
6. 計画作成時点では実装・テスト・CIは未実行だった。計画時のコード確認と、後続の実環境検証結果を区別して記録する。

## 最新コードの根拠と残存範囲

| 項目 | 最新 master の事実 | 必要な作業 |
| --- | --- | --- |
| センシティブ判定 | `packages/backend/src/core/FileInfoService.ts` の静止画は全て PNG 正規化後に `detectSensitive(Buffer)` へ渡る。`AiService.ts` は外部 sensitive-detector への HTTP に移行し、古い TensorFlow の直渡し分岐はない | 既存修正を再実装せず、WebP/JXL 回帰テストを追加して確認 |
| テスト | `packages/backend/test/unit/FileInfoService.ts` は既存ケースが `skipSensitiveDetection: true`。warnings/sensitive/porn を strip する。現在は Vitest | AI 境界に送る PNG と予測結果の反映を検証 |
| Docker | `Dockerfile` は Node `26.4.0-trixie`。builder は build-essential のみで libvips の構築・runner への配置がない | BUILDPLATFORM と TARGETPLATFORM ごとの libvips、sharp ソースビルド、runner の動的依存を整備 |
| sharp | `packages/backend/package.json` は `sharp: 0.35.3`、postinstall に `scripts/build-sharp.mjs`。このスクリプトは force-global/build-from-source 環境変数が有効な場合だけビルドする。Docker は変数を指定しない | 既存 postinstall を活用し、依存インストール前に環境を設定 |
| libvips | `.github/actions/setup-libvips/action.yml` は `8.18.3`、JXL を有効化して構築。`pnpm-workspace.yaml` には node-addon-api/node-gyp の補足依存がある | CI とバージョン・機能を合わせる。OS別依存名は実装時に確認 |
| tutorial | `MkTutorialDialog.Note.vue:52`、`MkTutorialDialog.PostNote.vue:56` は ai.jxl、`MkTutorialDialog.Sensitive.vue:68` 以降は natto_failed.jxl/image/jxl。`packages/frontend/assets/tutorial/` は WebP 版のみ | 既存 WebP から ai.jxl / natto_failed.jxl を生成して追加 |

Issue 本文と初回ローカル調査は sharp 0.33.5 / TensorFlow / Node 22 時点の情報だった。最新基準へ訂正し、古い修正案をそのまま適用しない。

## Codex の独立案・比較

| 論点 | 第一候補 | 代替と評価 |
| --- | --- | --- |
| 判定 | 本体変更なし、実画像を使った正規化境界・閾値の回帰テスト | AiService の再変更は解決済問題を重複修正し、外部サービス契約への影響を増やす |
| Docker | JXL 有効 libvips を明示ビルドし既存 sharp postinstall を使う | WebP/AVIF fallback は最新不変条件に反する。prebuilt 更新待ちは解決時期・機能を保証できない。全面 WASM 移行は範囲過大 |
| tutorial | 当初は実在 WebP への参照復元を推奨 | JXL 追加は生成管理・ブラウザ表示検証が必要。比較後のユーザー判断により JXL 生成・追加を採用 |

## Fable 5.1 との設計比較・議論

指定モデル `claude-fable-5-1`、`--permission-mode plan` を全起動と resume で明示した。同じセッション `9f9024f1-321a-4404-b149-8319cde02df6` で初回独立設計と差分議論を行う。出力の実行記録は `/tmp/issue15-fable-initial.json`、`/tmp/issue15-fable-discussion1.json`、`/tmp/issue15-fable-discussion2.json`。永続的な判断根拠は本節へ要約する。

初回入力は旧checkoutに基づいており、Fable は WebP/JXL を既存 PNG 経路に移す本体修正・Docker libvips 自前ビルド・tutorial の WebP 復元を提案した。Codex の初回案もこの3方針は一致した。その後、最新 master に判定外部化があると確認し、旧版に基づく本体修正を双方の案から除去した。

### 議論1: 最新基準への訂正と根拠確認

| 差異 | Codex の指摘・代替 | Fable の応答と扱い |
| --- | --- | --- |
| Fable は PNG のファイル拡張子をテストする案 | 実際の境界は Buffer。PNG シグネチャと実デコードで検証する | 誤りを認め、Buffer 検証へ変更 |
| Fable は Docker各段・tutorial各Vueを別コミット | 同一機能をファイルで分割せず、Docker一式+smoke、tutorial3Vueを各1コミット | 同意。生成物だけコマンド毎別コミットを維持 |
| Fable は target-builder のみ libvips を用意 | native-builder でも postinstall が実行される。BUILD/TARGET 両方に各architectureのlibvipsを供給 | 同意。ネイティブ段で別architectureの共有ライブラリを再利用しない |
| Fable は loader を多数無効化 | 既存対応画像の退行リスクがある。現行CIの機能を基準にする | 一律削減を撤回。runner依存は増えるが互換性を優先 |
| Codex はビルド用環境変数を広く検討 | Fable は force-global のみを推奨。全native dependencyのソースビルドを避けられる | Codexも採用。既存 `build-sharp.mjs` の条件で動く根拠あり |
| Fable は fallback を任意案に残す | 最新 AGENTS の JXL 出力不変条件に反し、設定不足を隠す | fallback/prebuilt更新待ち/全面WASM移行を本件から除外 |

Fable は判定本体が修正済なので回帰テストのみ、Node 26.4.0-trixie / sharp 0.35.3 / libvips 8.18.3、依存追加不要、WebP アセット参照復元の推奨に更新した。

### 議論2: 検証精度と範囲の再調整

Fable は追加提起を検討し、次の方針へ収束した。

- 299角・alphaなし・3channelsの PNG を検証する。「長辺299以下」の弱い確認を修正した。
- runner 内に小さな RGB グラデーションを生成し、lossless JXL の metadata、再変換 PNG の metadata、寸法と RGB 一致を別々に検証する。単色だけより画素破損を捉えやすい。現行 `ImageProcessingService.ts` の `jxlDefault` は既に lossless=true であり、アプリ既定が非可逆になったとは扱わない。
- 共通 libvips ビルドスクリプトを BUILDPLATFORM / TARGETPLATFORM 専用段からそれぞれ呼ぶ。版・ハッシュ・meson方針を一元化する。CI action は全面変更せず版と機能方針を合わせる。
- 起動時guardは非Docker配備を新たに起動不能にするため除外。別ベース公開・@img削除・CI全面共通化も対象外。実行イメージのビルド内smokeで検証する。
- Fable は副作用キャッシュの一律無効化を撤回。現行 postinstall と pnpm の実挙動を確認し、platform / sharp / libvips を区別するキャッシュキーと必要な局所対応を実装時に確定する。キャッシュなし/ありの両buildを確認する。
- 既存 JXL fixture を再利用するので、判定テストのためだけの生成物コミットは不要。tutorial WebP復元は実在アセットを使う小変更である点を根拠とし、未確認のブラウザ対応状況は根拠から外した。

以上は当時のエージェント同士の議論履歴であり、ユーザーによる実装許可ではない。その後のユーザー判断により tutorial は JXL 生成・追加に確定し、当初の WebP 復元推奨に優先する。検証を実行する場所は本書の検証計画に従い、既存の公開workflowを画像publish目的で起動することは含めない。


## 実装手順案

1. 最新 master 基準を再確認し、確定した計画と明示的実装許可を本書に記録する。
2. FileInfoService の WebP/JXL PNG 正規化に回帰テストを追加する。AiService をモックし、実際の sharp 変換を通す。
3. Docker にプラットフォーム別 libvips 構築・sharp ビルド設定・runner 共有ライブラリ配置を追加する。共通ビルドスクリプトを各platform専用段から呼ぶ。pnpm install 前に `SHARP_FORCE_GLOBAL_LIBVIPS=1` を設定して既存 postinstall を動かす。広範な native dependency に影響する `npm_config_build_from_source` の追加は避ける。libvips のバージョン・配布物ハッシュを固定し、JXL 機能をビルド時に必須化する。
4. 既存 ai.webp / natto_failed.webp から ai.jxl / natto_failed.jxl を生成し、`packages/frontend/assets/tutorial/` に追加する。3 Vue の既存 JXL URL・MIME と整合を確認する。生成コマンドと入力・オプションを記録し、生成物はコマンド実行ごとに別コミットする。
5. Docker の最終 runner とアプリ経路を検証し、CHANGELOG にユーザー影響のある修正を記録する。
6. Docker検証はローカル buildx でまず実施し、PRに amd64/arm64 の非公開build・runner smokeを実行する検証ジョブを用意する。既存の画像公開workflowを手動実行して代用しない。検証ジョブはDocker機能のコミットに含める。
7. Opus 5 と subagent の両方でレビュー、指摘の根拠確認・修正・再検証・再レビューを繰り返す。コミット・PR・CI・マージは共通手順とユーザー指示に従う。

## 検証計画・合格条件

- 既存 `test/resources/with-alpha.jxl` / `without-alpha.jxl` と WebP の fixture を `getFileInfo(skipSensitiveDetection:false)` に渡し、AI モックが受信する値が PNG Buffer・299×299・alphaなしであることを実デコードして確認。Porn/Sexy/Hentai の閾値、skip時未呼び出し、変換例外の warnings を検証する。JPEG/PNG の既存判定も退行しない。
- テストは現行 Vitest とビルド前提に従い、`mise exec -- pnpm --filter backend test --run` を基本とし、対象ファイルを絞って先に実行する。外部推論サービスのモデル精度や実画像分類はこの単体回帰テストでは扱わない。
- Docker は linux/amd64 と linux/arm64 の最終 runner 内で、PNG→JXL→PNG の実変換、既存 JXL の metadata/decode、WebP/JPEG/PNG の decodeを実行する。JXL Buffer の metadata は jxl、再変換した PNG は png として読み取れ、寸法と lossless テスト画像の RGB ピクセルが保たれることを確認する。`sharp.versions` / `sharp.format.jxl` と動的リンク先を記録するが、フラグの存在だけでは合格にしない。キャッシュあり/なし両方で実変換を確認する。
- backend e2e の `test/e2e/endpoints.ts` にあるアップロード→webpublic JXL 検証を再利用し、サムネイル・media proxy の実応答も確認する。DB/Redis と `.config/test.yml` を用意して実行する。
- 生成した2枚がJXLとしてデコードでき、元画像の寸法・外観を保つことを確認する。tutorial の3画面で画像表示、HTTP 200/image/jxl、センシティブ指定とプレビューをブラウザ確認する。
- `mise exec -- pnpm lint` と変更に該当するスキルの検証を行う。今回のAPI・DBスキーマ変更は想定しないためAPI生成/migrationは原則非該当。

## 未決事項・ユーザー判断

**ユーザー判断（2026-09-07）**: Claude 設計・議論に60秒等の実行時間上限を設けない。ユーザーが示した理由は「60秒は無理だと思う」。以後は時間経過だけで中断せず、短い間隔で完了を確認する。

**ユーザー判断（2026-09-07）**: 「.jxl ファイルを生成して追加する 方針で」と指定されたため、tutorial の ai.jxl / natto_failed.jxl を生成・追加する。理由の提示なし。この方針決定を実装許可とは扱わない。

- 画像形式を含む利用者向け方針の未決事項は解消した。
- Docker の具体的な依存パッケージ名、ソース取得ハッシュ、キャッシュキー、最終 runner のライブラリ集合は実装時検証で確定する通常技術判断。
- 実装許可: 未取得。対象計画・許可日・許可内容を追記するまで実装しない。

## 今回の計画文書の検証

Docs のみ。実装テスト・lint・画像生成・Docker build は未実施。API/entity/migration/locale/コードファイルを変更していないため、その生成・SPDX・migration検査は非該当。最新 shipping-misskey-change を読み、実装時の必要チェックを上記に取り込んだ。

## 実装許可の記録

**ユーザー判断（2026-09-07）**: 「それぞれ、実装を開始して」と明示された。対象は本書の確定方針（計画コミット `838335d0c7` 時点）であり、issue #15 の実装・検証・修正を開始する。理由の提示なし。過去の「実装未許可」は計画段階の履歴で、この許可により更新する。
