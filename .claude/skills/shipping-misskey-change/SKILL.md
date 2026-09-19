---
name: shipping-misskey-change
description: Use at every finish moment of a Misskey change, before committing, opening a PR, merging, or handing work back. Selects proportional validation, runs changed-file lint and repository safety checks, and records PASS/FAIL/BASELINE/SKIPPED without chasing unrelated failures.
---

# shipping-misskey-change

Misskey の変更を commit / PR / merge する直前、または未commitでユーザーへ返す直前の出口。
規範は [AGENTS.md](../../../AGENTS.md)、ここでは実行方法だけを定める。

## 1. 検証レベル

| 段 | 条件 | 実行 |
| --- | --- | --- |
| 1 (必須) | package の ESLint 対象ファイルを変更 | 存在する変更ファイルへ `eslint --quiet` を最後に 1 回 |
| 2 | 実装・挙動を変更 | 最も近い unit test を実行。型・生成物・DB に関係するときは対応する専用検証も実行 |
| 3 | コード変更を出す前 | 全体 `mise exec -- pnpm lint`。build / 広域 test は変更範囲に応じて実行 |

段 1 は docs-only など対象が空なら `SKIPPED`。
段 3 の既存失敗は成功扱いせず `BASELINE` として、今回の変更との関係だけを報告する。

### 自動検査

repo root で次を 1 回実行する。

```bash
mise exec -- node scripts/check-shipping.mjs --base master
```

統合先を明示する場合は `--base <ref>`、または `MISSKEY_BASE_REF` を使う。
upstream 取り込みでは `--upstream-ref <取り込んだ完全SHA>` を追加する。他言語の変更を一括許可せず、指定 snapshot の祖先関係と index / worktree の内容一致を検査する。

script は次を行い、独立した検査を最後まで続けて exit 0 (合格) / 1 (違反) / 2 (検査不能) に集約する。

- commit 済み・未commit・untracked の変更集合を NUL-safe に列挙し、変更ファイルだけへ package root から `eslint --quiet` を実行
- SPDX 違反時はローカル変更の欠落だけ `check-spdx.mjs --fix` で補い、通常検査を再実行
- SPDX の結果にかかわらず、`locales/ja-JP.yml` / `locales/en-US.yml` 以外の locale YAML 変更を検査

`SPDX: OK` 後は追加確認しない。
その他の常設方針は AGENTS.md に従う。

## 2. 変更別チェック

- backend API の `meta` / `paramDef` / `res`: `pnpm build-misskey-js-with-types`。
  手順は [regenerate-misskey-js.md](references/tasks/regenerate-misskey-js.md)
- entity / migration: `pnpm --filter backend check-migrations`。
  新規 migration は `up()` / `down()`、既存のマージ済 migration は差分なし
- backend API endpoint: [misskey-api-reviewer](../../agents/misskey-api-reviewer.md) を実行
- frontend `.vue`: [vue-component-reviewer](../../agents/vue-component-reviewer.md) を実行

- ユーザー影響のある変更は `CHANGELOG.md` の Unreleased に追記する。
- fork の JXL / wasm-vips external / mise + setup-libvips と master PR の CI を維持する。
- テスト DB は `compose.test.yml`、設定は `.config/test.yml`。migration 検査の前に `MISSKEY_CONFIG_YML=test.yml pnpm --filter backend migrate` を実行する。
- frontend-builder の旧 OXC 型重複は 2026.9.0 取り込み時点で再現しない。失敗時は改めて原因を確認し、過去の注記だけで除外しない。

## 3. 引き継ぎ

実行項目を `PASS / FAIL / BASELINE / SKIPPED` で短く列挙する。
失敗時は今回の変更との関係、未実行時は理由を書く。
ユーザーが依頼していない commit / PR / 外部送信は行わない。
