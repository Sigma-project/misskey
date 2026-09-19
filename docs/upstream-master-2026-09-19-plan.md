# upstream/master 2026.9.0 取り込み計画

作成日: 2026-09-19。対象: Sigma-project/misskey、PR base: `master`。
状態: 実装・ローカル検証・実装レビュー完了。本 Docs は PR 作成前の検証記録。PR と CI の最終状態は GitHub の当該 PR を参照。

## 要件・制約

- upstream/master の変更を fork の master に取り込む PR を作成する。
- `merge/upstream-master-2026-09-19` の専用 worktree で作業する。
- upstream の構造変更を採用し、その上に fork 独自機能を再適用する。
- 元の作業ツリーにある未追跡の `docs/ci-ubuntu-jxl-plan.md`、`docs/memory-investigation-2026-09-18.md`、`fluent-emojis/` を取り込みに含めない。
- JXL 変換、wasm-vips 子プロセスの自動解放、動画変換・再生・成果物回収、リモートファイル回収、誕生日ウィジェットを保持する。
- mise、JXL 対応 global libvips、sharp ソースビルド、CI の mise + setup-libvips 構成を維持する。
- 既存 migration を変更しない。ja-JP/en-US 以外の locale は upstream 配信物のみ取り込む。
- 手書き変更は機能単位、コード生成の成果物はコマンド実行ごとに別コミットとする。

## 調査結果と対象

| 対象 | 固定するコミット |
| --- | --- |
| fork master / origin/master | `01a30913207536310f598cc772400bb24fce2ce1` |
| upstream/master (2026.9.0) | `c7b8cdca97fcac6cae3bb2047483797888d32f0d` |
| merge-base | `00f66349766dc61298c66129ded5fdeb29e93f41` |

- fetch 後の upstream 未取り込みは 71 コミット、185 ファイル、7,761 行追加・4,958 行削除。fork 側独自履歴は 319 コミット。
- 調査時点で fork の open PR はない。
- `git merge-tree --write-tree --name-only --messages master upstream/master` による競合予測は 16 ファイル。作業ツリーと index は変更していない。
- API 定義と依存パッケージの更新がある。upstream 差分には entity / migration の変更はない。
- merge-base 以後に双方が変更したファイルは 43 件。16 件のテキスト競合に加え、この共通集合と upstream 新規の共有 helper / workflow を意味上の競合の監査対象とする。
- fork 独自依存は backend の `image-size@2.0.2` / `wasm-vips@0.0.16`、frontend の `@jsquash/jxl@1.3.0` / `hls.js@1.5.20`。upstream にない依存として保持する。

## 競合と解消案

| 対象 | 解消方針 |
| --- | --- |
| `FileInfoService.ts` と同 unit test | `AiService` → `SensitiveMediaDetectionService` の名称変更を採用。fork の JXL、ffprobe ラッパー、動画メタ情報を維持。他の fork テストの旧名参照も検索する |
| `MkLightbox.item.vue` / `MkMediaList.vue` | upstream の音声統合・controls・ピクセルアート表示・ぼかし解除引継ぎを採用。HLS manifest と動画 source の attach/cleanup、現在スライドの active 管理を維持 |
| `MkCustomEmoji.vue` / `EmCustomEmoji.vue` | upstream の共有 `emoji-name.ts` を使い、共有 helper の出力を `.jxl` にする。重複した旧 URL 組立を残さない |
| federation `move.test.ts` | upstream の条件待機 helper と fork の修正の目的を比較し、時間待機や重複待機を残さず必要な期待値を維持 |
| `.github/workflows/test-federation.yml` | upstream の安定化修正と fork の mise/libvips を両立 |
| `pnpm-lock.yaml` | 統合済み manifests と upstream の pnpm 11.25.0 から確定。fork 依存と source sharp 設定を保持 |
| misskey-js `autogen/types.ts` | fork endpoint・schema を維持し、統合後 backend から再生成して最終確定 |
| `CHANGELOG.md` | upstream 2026.9.0 の履歴と fork の既存 Unreleased を併存させ、取り込みに必要な利用者向け差分を記録 |
| `AGENTS.md` / `.github/copilot-instructions.md` / shipping・frontend skills / harness-audit | upstream の自動検査の構造を採用し、fork の base master・ja/en・CHANGELOG・全体 lint・JXL 規則と一致させる |

## 自動マージ後も必要な調整

1. upstream が複数 workflow に追加した `pull_request.branches-ignore: [master]` は、fork の master 向け PR の CI を停止するため適用しない。全 workflow の trigger を確認する。
2. `getCustomEmojiImagePath` は upstream では `.webp` を返す。component の競合だけを解いて終わらず、共有 helper と全呼出元を確認する。
3. Lightbox の `onActive` で active 設定と音声再生を両立する。動画には既存 HLS helper が再生開始を管理するため、audio/video の寿命を分けて確認する。
4. `use-uploader.ts` の音声プレビュー追加で、JXL 圧縮段階・アニメ判定・元ファイル名が失われていないことを確認する。
5. upstream の shipping script は ja-JP 以外を拒否する。fork の ja/en と、upstream から内容を変更せず取り込む他 locale を区別する。
6. dependencies の major 更新と pnpm 11.25.0 を採用する。Node は mise の 26.4.0 を維持し、互換性をビルドで検証する。
7. rename された service の DI・mock・test を、fork 独自ファイルも含めて検査する。

## 設計案の比較と協議

Fable 5.1 継続セッション: `6ccdab98-599a-4fe0-9376-d699738a08d1`。
モデル指定の成功応答を確認。ツールなしの plan モードに調査事実・制約・暫定案を提示している。Claude が直接リポジトリを調査した、実装をレビューしたとは扱わない。

| 案 | 利点 | 欠点・採否 |
| --- | --- | --- |
| 通常の merge + upstream 構造へ fork 機能を再適用 | upstream 履歴を保持し、次回取り込みの基点が明確 | 競合と意味上の衝突の両方を検証する必要がある。推奨 |
| 全体を ours/theirs で解消 | 操作は単純 | upstream 修正または fork 機能を失うため不採用 |
| 必要コミットだけ cherry-pick | 個別の取り込み範囲を限定できる | 全体取り込みの依頼を満たさず、履歴が分岐し続けるため不採用 |

第1回協議の論点:

- lockfile / autogen の競合解消と、生成物を別コミットにする順序。
- locale を upstream 由来と判定する方法と、検査の抜け道を作らない条件。
- master を除外する CI filter と fork ハーネス規則の再適用。
- 広域の依存更新を含むため必要となる検証範囲。

### 第1回の比較と第2回への提示

- 一致点: 通常 merge、固定 snapshot、競合外の共通変更の監査、upstream 構造への fork 再適用、master PR の CI 維持、履歴を保持する PR 統合方式。
- Fable 案: merge は16競合ファイルに限定し、Lightbox・emoji・ハーネス・autogen は upstream を採用、後続で fork を復旧する。lock は pnpm の自動解消を merge 内で実行し、別生成コミットを作らない。
- Codex の反論: 生成コマンドの成果物を別コミットにする規則と矛盾する。また意図的な JXL/HLS/API 型の欠落を作る必要はない。意味上の競合解消は、非競合ファイルにも及ぶ。remerge-diff と両親からの差分でレビューできるため、16ファイル限定は採らない。
- 追加の実測: lock の競合は cron-parser の旧版/新版 entry と sharp の旧版/新版 snapshot の2箇所だけ。autogen の競合は queue の `videoTranscoding` 追加と state の `paused` 削除が交差する1箇所だけ。既存 blob の内容を手動統合して baseline を作り、その後の生成差分を独立させる方式を提案した。
- Fable 案: 他 locale が PR 内の任意の merge commit の第2親と一致すれば許可する。独立した provenance script と CI job を追加する。
- Codex の反論: 第2親だけでは upstream 由来と判定できず、fork の任意の merge も通る。元の shipping script の ja 限定検査は依然として失敗する。変更集合には未commit・untrackedも含める必要がある。
- 代替案: 既存 shipping script に ja/en 許可と、取り込み時だけ使う明示 `--upstream-ref <固定SHA>` を追加する。通常は他 locale を拒否し、指定時は対象 snapshot の統合関係と最終ファイルの byte 一致を検査する。任意の merge 親を自動で信頼しない。今回は fetch で確認した upstream/master の SHA を指定する。
- 訂正事項: mise は Node だけを pin しているので pnpm pin の事前コミットは不要。Docs 保存先は確定済み。コミット粒度は機能単位であり関数単位・指摘件数単位ではない。CI は paths 条件があるため、すべての workflow の発火を要件にせず必要な job の欠落を調べる。既存テスト用サービスを無条件に停止しない。
- 検証案への追加: entity 差分がなくても依存更新後の整合性のため check-migrations を実行する。生成の二度実行は差分・不整合など検証上の必要が生じた場合に限定する。

### 第2回の合意と確認結果

- Fable は手動統合 baseline と生成差分の別コミット方式（案A）に合意し、意図的な機能欠落を作る初回案を撤回した。
- Fable は明示 upstream SHA による locale 検査に合意し、任意の merge 第2親を許可する案を撤回した。
- Fable から、locale の比較は Git の改行正規化を反映した blob OID で行う提案があった。`.gitattributes` は `* text=auto eol=lf` と確認できたため採用する。YAML を parse して意味だけ比較する方式にはしない。
- locale の処理は小さな `scripts/lib/locale-provenance.mjs` に分離し、既存 shipping script から呼ぶ。別の独立 CLI / CI job は追加しない。
- CI・package scripts に `check-shipping` の直接呼出しは見つからない（upstream 固定 snapshot を Git 検索）。したがって自動的に merge trailer を探索して許可対象を増やす fallback は不要。取り込み時のローカル検査に固定の完全 SHA を渡す。
- 現行 CI は `pnpm/action-setup@v6.0.9` と `jdx/mise-action@v2` を併用している。Node pin を維持し、実装時には使用された pnpm が 11.25.0 であることを実測・記録する。
- fork コードの cron-parser 直接利用は見つからない。依存先経由の利用はビルド・テストで検証する。
- 生成差分が空なら空コミットを作らず、実行コマンド・版・差分なしを記録する。
- 「生成 diff で手動統合ミスが必ず分かる」とは前提しない。生成結果に加え、backend の API 定義・fork endpoint と実行テストで確認する。
- 合否を保証する対象は生成コミットを含む最終 PR head とする。merge 単体の lock の整合性も確認し、生成コミットが必要だった場合はその境界と結果を記録する。未検証の中間コミットを検証済みと表示しない。
- 第2回の初回実行は API の DNS エラーで失敗。同一モデル・同一セッションで再送して成功応答を得た。時間だけを理由とする中断はしていない。

主要な相違点は上記の再協議で解消した。Fable の指摘した残る確認事項は、実ファイルの確認と上記の採用方針で解決した。

## 採用方針

- 固定 upstream snapshot を通常 merge し、テキスト競合だけでなく自動マージ箇所の意味的整合を含めて fork の挙動を保持する。
- AGENTS / skills / copilot の構造更新は取り込み、fork の全体 lint・CHANGELOG・ja/en・JXL・master PR CI 方針を保持する。
- 手動の競合解消 baseline を path 指定で index に保存する。必要な生成コマンドで生じる worktree 差分を混ぜず、コマンドごとに別コミットにする。包括的な `git add -A` / `commit -a` は使わない。
- `pnpm-lock.yaml` には upstream の依存更新と fork の4依存を共存させる。JXL 対応 sharp の実ビルドを検証する。Node は 26.4.0、pnpm は upstream の 11.25.0 とする。
- locale 検査の通常動作は ja/en 以外の変更を拒否する。取り込み時だけ `--upstream-ref c7b8cdca97fcac6cae3bb2047483797888d32f0d` を明示する。
- 指定 commit が HEAD または進行中の MERGE_HEAD に取り込まれていることを確認する。他 locale は commit・index・worktree・untracked の変更を漏らさず列挙し、最終内容を指定 snapshot の Git 正規化後 blob と比較する。削除・残存・読取失敗・非祖先・未解消競合を正常一致と混同しない。index と worktree が異なる状態も検査で見落とさない。
- upstream-ref は取り込み元の明示宣言であり、任意の commit を自動的に upstream と認証する機能ではない。今回の SHA は fetch した upstream/master と確認済み。

## 実装手順

1. 固定 refs と元 worktree の変更状態を再確認し、専用 worktree とブランチを作る。
2. upstream 固定コミットを通常 merge し、上表の競合と自動マージ後の意味上の衝突を解消する。
3. 手動 baseline と生成差分を分離して、統合 manifests の lockfile、locale 型、misskey-js 型・API report を必要な生成コマンドで確定する。最終候補を検証した上で merge baseline、lock 生成、各 API / locale 生成の順に実行単位でコミットする。差分なしなら実行結果のみ記録する。
4. ローカル検証を実施し、今回起因の問題を修正する。既存失敗は基点との比較で切り分ける。
5. Opus 5 と subagent に計画・差分・検証結果を共有してレビューを依頼する。API / Vue の専門チェックも行う。指摘の妥当性を検証し、双方の再レビューが収束するまで修正する。
6. 残る変更を規定の粒度でコミット・push し、fork の PR テンプレートに従って base master の PR を作る。
7. 最新コミットの必要 CI と PR レビューを確認し、失敗・指摘があれば検証・修正・再レビューへ戻る。
8. PR の統合には履歴を保持する merge 方式を使う。squash / rebase で upstream の祖先関係を失わない。

## 検証方法

- インストール: mise の環境で frozen lockfile インストール。sharp が global libvips / JXL を使うことを確認。
- ビルド・静的検査: `mise exec -- pnpm build`、`mise exec -- pnpm lint`、upstream の SPDX / shipping script を fork 規則に適合させて実行。
- backend: `.config/test.yml` と `compose.test.yml` のテスト DB / Redis を用意し、unit、影響する API / streaming / file の e2e、federation の変更箇所を検証。
- frontend: unit、HLS source attach/fallback/cleanup、音声を含む Lightbox と emoji JXL URL を検証。実ブラウザが必要な項目は実施方法と結果を記録。
- fork 回帰: WasmVipsService / WasmVipsProcess、FileInfo / Ffprobe、動画変換・cleanup、remote file cleanup の既存テスト。
- API: `mise exec -- pnpm build-misskey-js-with-types`。upstream API 修正と fork endpoint・生成型の両方を確認。
- DB: 既存 migration を変更していないことを確認。依存更新後の整合性も検証するため、テスト DB で migrate と check-migrations を実行し pending DDL 0 件を確認。
- locale: ja/en 以外の取り込み差分が固定 upstream の内容と一致し、手動変更がないことを確認。flag なしの拒否、一致、不一致、削除済みファイルの tracked/untracked 残存、非祖先、読取失敗、ja/en の許可を検証する。
- CI: workflow の master PR trigger と mise/libvips を確認。必要ジョブの欠落を成功扱いしない。
- 結果を PASS / FAIL / BASELINE / SKIPPED と理由付きで記録する。frontend-builder の既知 OXC 型重複は今回の依存更新後も同じ原因か確認する。

## 未決事項

設計上の未決事項はない。実装時の検証結果とレビュー指摘に応じて本 Docs を更新する。

## 実装結果・追加判断

- 16 件のテキスト競合を解消した。fork の ffprobe/JXL 処理に SensitiveMediaDetectionService の改名を反映し、fork 専用 FileInfoFfprobe テストの参照も更新した。
- Lightbox は upstream の音声・共通 controls を採用し、fork の HLS source attach/dispose を維持した。初回 subagent レビューで削除済み initiallyOpened prop の参照を検出し、親の immediate watcher → nextTick → onActive に合わせて active=false で初期化した。非active化後に遅れて audio DOM が現れても再生しないよう待機 watcher を解除する。
- 実コンポーネントの追加テストで active/deactive/close/unmount、sensitive 内容の reveal と URL 変更、遅延 audio の再生防止を検証する。
- 共通 emoji URL helper を JXL に変更し、Web と embed の双方で使用する。
- master 向け PR を除外する upstream の workflow filter を取り除いた。mise と source sharp の設定は維持した。
- sharp 0.35.4 の source build は libvips 8.18.6 以上が必要で、8.18.3 ではコンパイルエラーになることを実測した。CI action と Docker ビルドスクリプトを 8.18.6 に合わせ、GitHub の公式 release asset digest と照合した SHA-256 を固定した。これは依存更新に必要な互換性調整として採用した。
- pnpm の sharp packageExtensions を 0.35.4 に合わせた。lockfile の手動 baseline は node-gyp 13.0.0 の entry がなく frozen install で失敗したため、pnpm 11.25.0 の lockfile-only 生成差分で補った。merge baseline 単体を検証済みとは扱わない。
- mediabunny 1.55.4 の Quality コンストラクタは number を公開型で受け取るため、fork の Quality(8) にあった不要な ts-expect-error を削除した。全体 lint の TS2578 とインストール済み型定義で根拠を確認した。圧縮品質は変更しない。

## 共通変更ファイルの監査

双方が変更した 43 ファイルを監査した。backend の DI / queue / config / global stream cleanup、frontend uploader の JXL 多段圧縮と元ファイル名、preferences の fork キー、Docker の source sharp 設定は保持されている。API 型再生成は差分なしで一致した。ハーネス文書は master・ja/en・upstream snapshot 検査へ整合させた。ja/en の fork キーを維持し、他 locale は指定 upstream snapshot と一致することを機械検査する。既存 migration に変更はない。

```text
.claude/agents/vue-component-reviewer.md
.claude/commands/harness-audit.md
.claude/skills/shipping-misskey-change/SKILL.md
.claude/skills/working-on-backend/SKILL.md
.claude/skills/working-on-frontend/SKILL.md
.claude/skills/working-on-frontend/references/knowledge/i18n-usage.md
.github/copilot-instructions.md
.github/workflows/api-misskey-js.yml
.github/workflows/lint.yml
.github/workflows/locale.yml
.github/workflows/packages-private.yml
.github/workflows/test-backend.yml
.github/workflows/test-federation.yml
.github/workflows/test-frontend.yml
.github/workflows/test-production.yml
.github/workflows/validate-api-json.yml
AGENTS.md
CHANGELOG.md
Dockerfile
locales/en-US.yml
locales/ja-JP.yml
packages-private/diagnostics-frontend/test/report.test.ts
packages/backend/package.json
packages/backend/src/config.ts
packages/backend/src/core/CoreModule.ts
packages/backend/src/core/FileInfoService.ts
packages/backend/src/core/GlobalEventService.ts
packages/backend/src/core/QueueService.ts
packages/backend/test-federation/test/move.test.ts
packages/backend/test/unit/FileInfoService.ts
packages/backend/test/unit/server/FileServerService.ts
packages/frontend-embed/src/components/EmCustomEmoji.vue
packages/frontend/package.json
packages/frontend/src/components/MkLightbox.item.vue
packages/frontend/src/components/MkMediaList.vue
packages/frontend/src/components/global/MkCustomEmoji.vue
packages/frontend/src/composables/use-uploader.ts
packages/frontend/src/preferences/def.ts
packages/i18n/src/autogen/locale.ts
packages/misskey-js/src/autogen/apiClientJSDoc.ts
packages/misskey-js/src/autogen/types.ts
pnpm-lock.yaml
pnpm-workspace.yaml
```

## 生成コマンドの記録

- `pnpm install --lockfile-only` 初回: 差分なし。sharp packageExtensions 調整後の再実行: pnpm-lock.yaml の checksum、node-gyp 13.0.0、optional 属性を更新。この差分のみ独立コミットにする。
- `pnpm build`: 成功。追跡対象の locale 型を含め生成差分なし。
- `pnpm build-misskey-js-with-types` 初回: default.yml 未配置で API 出力前に停止、追跡差分なし。`MISSKEY_CONFIG_YML=test.yml` を明示した再実行: 成功、API 型・API report とも追跡差分なし。空コミットは作らない。

## PR 作成前の検証結果

ホストには global libvips がないため、ホストへパッケージを追加せず、Node 26.4.0 / pnpm 11.25.0 / libvips 8.18.6 の検証用 Docker コンテナを使用した。Node/pnpm は mise と packageManager の指定と一致する。テスト DB / Redis は compose.test.yml、Meilisearch は CI と同じ v1.49.0、設定は .config/test.yml を使用する。

- PASS: frozen lockfile install、sharp の JXL buffer 出力（実エンコード）、全体 build、API 型再生成（差分なし）。
- PASS: frontend 20 files / 168 tests（追加 Lightbox 3 tests を含む）、locale provenance 11 tests。
- PASS: 全体 lint の 13 workspace 成功後、frontend の不要な ts-expect-error を修正して frontend typecheck / ESLint も成功。check-dts は 18 declaration files 成功。frontend-builder の既知 OXC 型重複は今回再現せず成功した。
- PASS: backend unit は初回 59 files 成功。残る 21 files は環境補正後の再実行で 224 tests 成功、2 tests は既存 skip。初回の 940 成功・2 失敗・16 skip と重複するためテスト件数を単純加算しない。
- PASS: misskey-js 14 tests と tsd、shipping checks（変更ファイル lint / SPDX / locale）。
- PASS: migration は専用空 DB に全件適用し、check-migrations の pending DDL 0 件。既存 migration の変更なし。
- PASS: backend e2e 30 files / 1,349 tests（2 skip / 20 todo、exit 0）。終了時に close timeout 警告が出たが全テスト成功と正常終了を確認。
- PASS: federation 9 files / 92 tests（13 skip）。move の待機修正を含む。
- PASS: CI action/workflow の YAML parse と 33 workflow の master PR 除外なし検査。
- PASS: Opus 5 と frontend / backend subagent の実装レビュー収束、妥当な未解決指摘なし。
- SKIPPED: 実ブラウザによる手動視覚確認。Lightbox の寿命・再生切替は実 Vue コンポーネントを happy-dom 上で検証し、HLS helper の全分岐は既存 unit test で検証した。
- 未実行: PR 上の CI / review。

## レビュー記録

- frontend subagent: initiallyOpened の参照は妥当な指摘として修正。修正後の静的レビューと追加回帰テストの静的レビューは未解決指摘なし。実テスト結果と Quality の型変更を共有した再レビューで承認、未解決指摘なし。
- backend subagent: rename の全参照、DI、fork JXL/worker/video/cleanup、BullMQ API、変更 endpoint の登録とエラー UUID、federation の待機・assertion を確認し、静的な未解決指摘なし。unit / e2e / migration / API 再生成と最終差分の再レビューで承認、未解決指摘なし。
- Opus 5: plan モード・ツールなしで、計画・差分・主要実ファイル・その時点の検証結果を渡し、3回の比較・再レビューを実施。外部モデルがリポジトリを直接実行検証したとは扱わない。

### 検証環境の補正

- backend unit の初回では、並行した federation 準備で作った空の built/._config_.json が優先され、設定読込に失敗した。unit 用設定を正しく保存し、federation はコンテナ内の別 bind mount で各サーバー設定を使用する。リポジトリコードの障害ではない。
- 同じ初回で FileInfoService の M4A / WebM audio が FFmpeg 不足により失敗、SearchService が Meilisearch 起動前で接続拒否になった。検証イメージへ FFmpeg を追加し、Meilisearch の起動後に失敗した 21 files を再実行して成功した。
- unit test の synchronize 済み DB に初期 migration を適用すると既存 table と衝突するため、専用の空 DB で migration を検証した。
- federation は既存 Docker ネットワークと固定 subnet が重なったため、ローカルだけの override で subnet と対応する tester IP / daemon / 許可 network を変更した。明示 -f 指定時の compose.override.yaml 読込漏れは backend subagent が特定し、起動引数を補正した。CI の既定 Compose 読込と repository の compose files は変更していない。

### Opus 5 第1回の検証と再協議

継続セッション: deb43d85-c9bc-4939-a561-e9846905b1d0。初回は sandbox の DNS 制限で API 接続失敗し、保存セッションも存在しなかったため、同一 Opus 5 を接続可能な環境で起動した。時間だけによる中断はしていない。

- BullMQ fork API、変更コミットと fork 経路の交差、Node/Compose 構成、生成型の整合について追加証拠を要求された。対象コード、upstream パッチ、型検査・再生成結果を共有して再レビュー中。
- autogen の paused が残るとの指摘は別 endpoint の混同。admin/queue/jobs の state は paused なし、admin/queue/clear はありで、backend からの再生成も差分なし。
- closeThis の即時 cleanup、隣接動画を未attachとする挙動、寸法の metadata fallback は fork/master の既存挙動。幅・高さは content メタデータ優先である。新たな再現根拠なしに既存の回収動作を変更しないと回答した。
- HLS helper のテストがないとの指摘には、既存 attach-video-source.test.ts の 7 tests と成功結果を提示した。event callback 中の destroy を非同期化する提案は、今回の回帰・具体的な再現根拠が示されておらず、既存挙動を変更しない理由を返した。
- JXL 寸法処理の定数化・unknown logging 変更は既存コードの独立 refactor であり、backend lint / FileInfo fixture tests 成功を根拠に今回の範囲に加えない。
- CI の libvips ダウンロードに --fail / --retry と SHA-256 検証を追加し、sharp packageExtensions の版追従を AGENTS に明記した。

### Opus 5 第2回の収束確認

- 初回で「upstream にない既存 fork の行」を新規実装と誤認した点、未提示のテストを存在しないと断定した点は、Opus が明示的に撤回した。BullMQ、Node ABI / Compose、HLS destroy 再入の懸念、API enum の整合は証拠を確認して解決済みと回答した。
- 第2回の A: MkMediaList の audio ref 欠落は MkMediaAudio と共に upstream blob と一致し、audio が isRevealed を expose しない upstream 既存挙動であるため、この取り込みで新規修正しない。
- 第2回の B: frontend / embed / sw / shared を検索し、notes/reactions の呼出しは misskeyApi 2箇所と Paginator 1箇所。Paginator 内部も misskeyApi であり、GET 呼出しと _cacheKey_ の残存はない。
- 第2回の C: QueryService / NoteEntityService / GetterService はファイル全体の blob が upstream と一致する。可視性 helper の fork 改変による取り込み漏れはない。
- 第2回の D: 古い frontend-builder OXC 失敗を例外扱いする文言を AGENTS / shipping skill から除去し、今回解消したことと今後は改めて原因確認する方針に更新した。
- 上記の根拠と backend unit/e2e 完了結果を渡して第3回の最終判定を依頼した。
- federation の初回 TLS エラーは、テスト用証明書の鍵を nginx worker が読めない権限によるものだった。CI と同じ chmod 644 を a.test/b.test のテスト鍵に実施し、再実行で全9ファイル成功した。鍵は ignored のテスト用生成物で、コミットに含めない。

### 最終レビュー判定

Opus 5 第3回は「実装レビューとして残る妥当な未解決指摘はありません。ブロッカーはゼロ」と回答した。frontend / backend subagent も最終差分と検証結果を確認して承認した。第3回応答の時点で進行中だった federation も、その後 9 files / 92 tests で成功した。

e2e の終了時 close timeout 警告は exit 0 で完了した観測として残す。取り込み起因か既存かは、この段階では未分類であり、成功結果と分けて記載する。PR の CI がハング・失敗する場合は、その根拠に基づいて再検証・修正・再レビューする。

PR 作成後は最新 head の CI とレビューを確認する。失敗や妥当な指摘があれば、その修正を同じレビューサイクルに戻す。
