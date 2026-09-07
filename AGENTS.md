# Misskey (Sigma-project fork) – AI Agent Guide

このリポジトリは [misskey-dev/misskey](https://github.com/misskey-dev/misskey) の **fork ([Sigma-project/misskey](https://github.com/Sigma-project/misskey))**。fork 独自機能を維持しながら upstream を定期的に取り込んで運用する。

- **メインブランチは `master`** (upstream の `develop` 相当の開発は行わず、`master` ベースで運用)。PR の base も `master`
- **upstream 取り込み**は `merge/upstream-master-YYYY-MM-DD` 形式の作業ブランチで conflict を解消してから PR で `master` に入れる。解消方針は「**upstream の構造変更を採用し、その上に fork 独自機能 (後述) を再適用**」
- fork 独自機能の全体像と upstream との差分は「[Fork 固有の不変条件](#fork-固有の不変条件)」を参照

このファイルは Misskey リポジトリで動く AI コーディングエージェント (Claude Code / OpenAI Codex / GitHub Copilot 等) が共通で参照する **絶対禁止事項と最低限のチェック** を集めた索引。次の 3 経路から参照・読み込みされる:

- **Claude Code**: ルート `CLAUDE.md` から `@AGENTS.md` で取り込まれる。詳細手順・規約は `.claude/skills/` (description で自動索引)
- **OpenAI Codex**: ルート `AGENTS.md` を直接読み込む (skill エントリは `.agents/skills/`、実体は `.claude/skills/` を指す)
- **GitHub Copilot**: `.github/copilot-instructions.md` (本ファイルの規約を Copilot code review 向けに再掲) 経由で参照する

人間 contributor 向けの一般規約 (Issue / PR の出し方、ActivityPub 拡張など) は [CONTRIBUTING.md](CONTRIBUTING.md) を参照。本ファイルは AI が **コードを書く・直す・出す** 際に踏み外してはいけない事項に絞る。

---

## 絶対にやってはいけない事

違反すると CI 失敗 / 本番事故 / 共有環境破壊 になる。順守すること。

### コード・データ関連

1. **SPDX ヘッダー欠落のまま AGPL 管轄ディレクトリへ新規ファイルを追加しない**
   - 対象: 新規 `.ts` / `.js` / `.cjs` / `.mjs` / `.vue` / `.scss` / `.html` ファイル
   - CI の対象判定は [.github/workflows/check-spdx-license-id.yml](.github/workflows/check-spdx-license-id.yml) の `directories` 配列を参照 (`*.config.{ts,js,cjs,mjs}` と `*eslint*` は除外)
   - 欠落すると CI (`spdx` ジョブ) が失敗する
   - `packages/misskey-js` は MIT ライセンスのサブパッケージなので、この AGPL ヘッダーを一律に付けない (サブパッケージ固有の `package.json` / `LICENSE` / 既存ファイルのヘッダーに従う)

   `.ts` / `.js` / `.cjs` / `.mjs` / `.scss`:

   ```text
   /*
    * SPDX-FileCopyrightText: syuilo and misskey-project
    * SPDX-License-Identifier: AGPL-3.0-only
    */
   ```

   `.vue` / `.html` (HTML コメント形式):

   ```text
   <!--
   SPDX-FileCopyrightText: syuilo and misskey-project
   SPDX-License-Identifier: AGPL-3.0-only
   -->
   ```

2. **`locales/ja-JP.yml` / `locales/en-US.yml` 以外の locale YAML を手動編集しない**
   - fork 独自キーを追加する場合は `ja-JP.yml` (必須) と `en-US.yml` (推奨) の両方に追加する (fork の既存運用。例: `highest` / `_compression._quality.highest`)
   - それ以外の言語ファイルは upstream の Crowdin 配信物であり、fork では upstream マージ経由でのみ更新される。手動編集すると次回マージで conflict / 喪失する
   - 根拠: [locales/README.md](locales/README.md) と [crowdin.yml](crowdin.yml) (`ja-JP.yml` → `locales/%locale%.yml` の同期設定)

3. **マージ済 migration ファイルを編集しない**
   - 対象: `packages/backend/migration/{unixMs}-{name}.js` のうち、既に `develop` / `master` にマージされたもの
   - 本番環境で履歴改変が起きると深刻なデータ不整合を引き起こす
   - スキーマ変更が必要な場合は **新しいタイムスタンプで新規ファイル** を作成する (`node -e "console.log(Date.now())"` でタイムスタンプ取得)
   - 新規 migration は `up()` と `down()` の両方を実装し、`pnpm --filter backend check-migrations` を通すこと (TypeORM schema builder で pending DDL を検出)

### Git / リポジトリ操作

4. **`git push --force` / `--force-with-lease` を `main` / `develop` / `master` にしない** (他人の作業を消す可能性)
5. **`git commit --no-verify` で hook をスキップしない** (lint / format / SPDX チェックを潰す)
6. **マージ済 / プッシュ済コミットを `git commit --amend` で書き換えない** (履歴の整合性が壊れる)
7. **他人のブランチを `git reset --hard` / `git branch -D` で破壊しない**
8. **`git config` をユーザーに無断で書き換えない** (特に `user.name` / `user.email` / `commit.gpgsign`)

### Issue / PR / 外部送信

9. **ユーザーの明示指示なしに PR を merge / close / force-push しない**
10. **ユーザーの明示指示なしに external service (GitHub comments / Slack / メール 等) へ送信しない**
11. **secrets / 認証情報をリポジトリにコミットしない** (`.config/*.yml` の本番値、`.env` ファイル、API token、private key 等)
12. **脆弱性報告を通常の Issue / PR 経由で行わない** (脆弱性報告を行う場合のルールは `creating-issues-and-prs` スキルを参照すること)

### スキル呼び出し

上流スキルの実行・事前知識・memory の内容に関わらず免除されない。

13. **`working-on-backend` スキルを参照せずに `packages/backend/` 配下のファイルを編集・追加しない**
14. **`working-on-frontend` スキルを参照せずに `packages/frontend/` 配下のファイルを編集・追加しない**
15. **`shipping-misskey-change` スキルを参照せずに commit / PR 作成 / 作業をユーザーに返さない**
16. **`creating-issues-and-prs` スキルを参照せずに Issue / PR を起票しない** (脆弱性報告のルールも含む)

---

## Fork 固有の不変条件

この fork が upstream から意図的に乖離している箇所。upstream マージや refactor で**うっかり upstream の挙動に戻さない**こと。

### 画像パイプライン (WebP → JXL 化)

- **サーバー側の画像変換はすべて JXL**。webpublic (`DriveService.generateAlts`、ロスレス・上限 11648px)、サムネイル、media proxy (`static.jxl` / `svg.jxl` / `emoji.jxl`)、`/emoji/*.jxl` ルート。upstream の WebP (`convertSharpToWebp` 系 / `webpDefault`) に戻さない・復活させない
- **アニメ画像 (GIF / APNG / アニメ WebP 等) の JXL 変換は [WasmVipsService](packages/backend/src/core/WasmVipsService.ts)** (wasm-vips) が担う。sharp はアニメ JXL 出力に使えない
- **`packages/backend/rolldown.config.ts` の `external` から `wasm-vips` を外さない**。バンドルされると `vips.wasm` 等の WASM アセットが `built/` に出力されず、実行時 ENOENT でアニメ JXL 変換が全滅する
- **sharp は JXL 有効のグローバル libvips に対するソースビルド前提**。ローカルは [mise.toml](mise.toml) の `SHARP_FORCE_GLOBAL_LIBVIPS=1` / `npm_config_build_from_source=true`、CI は [.github/actions/setup-libvips](.github/actions/setup-libvips) (libvips を `-Djpeg-xl=enabled` でビルド)。prebuilt sharp は JXL エンコード不可 (`jxlsave_buffer` が無い) なので、ローカルで JXL 系テストが 500/失敗するときはまず環境を疑う
- **クライアント圧縮は JXL 多段パイプライン** ([use-uploader.ts](packages/frontend/src/composables/use-uploader.ts)): Canvas JXL → WASM JXL (`@jsquash/jxl`) → AVIF/WebP フォールバック。圧縮レベルは 0–4 の 5 段階
- **フロントは常に元のファイル名でアップロードする** (`item.suffix` に変換後拡張子を入れない)。拡張子の補正は backend の [correctFilename](packages/backend/src/misc/correct-filename.ts) が実際の Content-Type に基づいて行う (二重拡張子防止。根拠: コミット `03a456bd7b`)
- upstream に JXL 非対応の型定義・定数リストが増えたら fork 側で `image/jxl` を追加する (`FILE_TYPE_BROWSERSAFE`、`is-mime-image.ts`、`THUMBNAIL_SUPPORTED_TYPES` 等が既存例)

### ツールチェイン / CI

- **Node・ツールは mise 管理** ([mise.toml](mise.toml))。ローカル検証は `mise exec -- pnpm ...` または mise タスク (`mise run build`、`mise run ci:lint` 等) で行う
- **CI workflow は `actions/setup-node` ではなく `jdx/mise-action` + `./.github/actions/setup-libvips`** を使う。upstream マージで workflow が conflict したら「upstream のバージョン更新を採用し、setup-node ブロックを libvips+mise に置換し直す」
- **テスト用 DB / Redis はルートの [compose.test.yml](compose.test.yml)** (`docker compose -f compose.test.yml up -d --wait`、port 54312 / 56312)

---

## 変更を出す前の最低チェック

各エージェントは [shipping-misskey-change スキル](.claude/skills/shipping-misskey-change/SKILL.md) を参照すること。スキルが利用できない環境でも、以下のチェックは必ず実施すること:

1. **lint**: `pnpm lint` が通る (typecheck + eslint, 全パッケージ)
2. **backend API 変更時**: `pnpm build-misskey-js-with-types` を実行し `packages/misskey-js/src/autogen/` の差分も commit に含めた
3. **entity / migration 変更時**: `pnpm --filter backend check-migrations` が pending DDL 0 件で通る / 新規 migration は `up()` と `down()` 両方実装済
4. **新規ファイル**: SPDX ヘッダーを付けた (`.vue` / `.html` は HTML コメント形式、それ以外は TS コメント形式)
5. **ユーザー影響のある変更**: `CHANGELOG.md` の `## Unreleased` 配下の該当サブセクション (`### General` / `### Client` / `### Server`) に `- <Feat|Enhance|Fix>: <概要>` を 1 行追記
6. **locale safety**: `locales/` を編集した場合、`git diff --name-only master -- 'locales/*.yml' | grep -vE '^locales/(ja-JP|en-US)\.yml$'` が空 (ja-JP.yml / en-US.yml 以外に差分が無い) ことを確認

### Validation commands

各チェックで使う pnpm コマンド一覧。状況に応じて最も近いコマンドから検証する。

fork では Node / pnpm を mise が管理しているため、シェルに mise が通っていない環境では各コマンドを `mise exec -- <コマンド>` で実行する。

| 用途 | コマンド |
| --- | --- |
| 全体 lint (typecheck + eslint) | `pnpm lint` |
| Backend unit test | `pnpm --filter backend test` |
| Backend e2e test | `pnpm --filter backend test:e2e` |
| Backend federation test | `pnpm --filter backend test:fed` |
| Frontend unit test | `pnpm --filter frontend test` |
| Migration 差分検査 (pending DDL) | `pnpm --filter backend check-migrations` (先に `pnpm --filter backend migrate` で適用) |
| `misskey-js` 再生成 (API 変更後必須) | `pnpm build-misskey-js-with-types` |
| 全体ビルド | `pnpm build` (依存インストール込みなら `mise run build`) |
| 開発サーバー (backend + frontend watch) | `pnpm dev` |
| CI 相当をローカルで一括実行 | `mise run ci` (個別は `mise run ci:lint` / `ci:typecheck` / `ci:test:backend` 等) |

**注意:**

- backend テスト (`test` / `test:e2e` / `test:fed`) と `check-migrations` の実行前に、`.config/test.yml` (`cp .github/misskey/test.yml .config/test.yml`) と テスト用 DB (`docker compose -f compose.test.yml up -d --wait`) が必要
- `pnpm lint` のうち frontend-builder の typecheck は `@oxc-project/types` の二重バージョンにより **upstream 由来で失敗する** (upstream CI は frontend-builder を typecheck しない)。この失敗は fork の変更起因ではないので、他の workspace が通っていれば lint 通過とみなしてよい
- ローカル sharp が JXL 非対応 (prebuilt) の場合、JXL 変換を伴うテストが失敗する。コード起因かを切り分けてから対応すること (「Fork 固有の不変条件」参照)
