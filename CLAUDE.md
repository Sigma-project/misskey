# Misskey (Sigma-project fork) – Claude Code Guide

このリポジトリは misskey-dev/misskey の fork (Sigma-project/misskey)。メインブランチは `master`。fork 独自の JXL 画像パイプライン等の不変条件は AGENTS.md の「Fork 固有の不変条件」を参照。

ルール本体は [AGENTS.md](AGENTS.md) (Codex / Copilot と共有する単一ソース)。本ファイルは Claude Code 用の薄いラッパーで、`@AGENTS.md` 構文で本体規約をセッション開始時にコンテキストへ展開する。

Claude Code 固有の補助 (skills / agents / slash commands / docs) は `.claude/` 配下にコミット済。個人ローカル設定は `.claude/settings.local.json` に、MCP 認証情報は `.claude/.credentials.json` に置く (いずれも `.gitignore` 済)。

@AGENTS.md
