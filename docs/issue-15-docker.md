# Issue #15 Docker 実装記録

## 実装

`Dockerfile` の BUILDPLATFORM / TARGETPLATFORM それぞれで共通スクリプトから libvips 8.18.3 を JXL 有効で構築する。公式リリースの SHA-256 を検証し、`/opt/vips` に配置する。既存 backend postinstall を `SHARP_FORCE_GLOBAL_LIBVIPS=1` で実行する。

最終 runner へは libvips のライブラリと、実際のリンク先から取得した Debian runtime パッケージを配置する。インストールしただけで合格にせず、最終ユーザーで PNG→lossless JXL→PNG の寸法・RGB画素一致と JPEG/WebP/PNG の読書きを確認する。

最新 master は submodule がなく `.gitmodules` も空のため、Docker 内の不要な git submodule 初期化を除去した。Git履歴をビルドコンテキストへ入れず、worktree からもビルドできるようにした。

PR の Docker 検証は amd64 / arm64 各ネイティブ runner で非公開ビルドし、最終イメージから smoke test を再実行する。イメージの公開はしない。

## 根拠

- [libvips の公式ビルド手順](https://www.libvips.org/install.html)
- [sharp の公式インストール手順](https://sharp.pixelplumbing.com/install/)
- [libvips 8.18.3 の公式リリース](https://github.com/libvips/libvips/releases/tag/v8.18.3): 配布物 digest `f41285b61bfb495605494f074ca341f7791a1d406e2f157dcea606ef1ae1b146` を GitHub release API で確認。

## 検証状況

- libvips 構築段（amd64）: 成功。
- 構築段内の sharp 0.35.3 / libvips 8.18.3 実JXL往復変換: 成功。
- shell / Node スクリプト構文検査、diff whitespace: 成功。
- 最終 runner build（amd64）と実行ユーザーでの JXL 再検証: 成功。
- キャッシュを利用した再ビルドとビルド内 smoke: 成功。
- arm64: PR のネイティブ runner で確認予定。

## Opus 5 レビュー第1回への対応（2026-09-07）

- AVIF退行の仮説は最終runnerで透過あり・なしAVIF→JXLを実行し否定した。Debian trixieのlibheif1依存によりdav1d/libde265デコーダプラグインが実際にインストールされている。将来の依存変化を検出するためAVIF/SVG入力、TIFF往復をsmokeへ追加した。アプリで使わないAVIF/GIF出力は要求せず、GIF入力はWASMによる複数フレームJXLの再デコードまで検証する。
- actionタグは既存公開workflowと同一のcheckout v7.0.0 / buildx v4 / build-push v7であり、古いモデル知識を理由にダウングレードしない。公開workflowもplatform別jobだがrunnerがamd64固定だったため、arm64はネイティブrunnerへ変更した。公開実行自体は行わない。
- origin/masterの.gitmodulesは空blob e69de29...、gitlinkなし。新規workflowの不要なsubmodules指定を削除した。Docker contextではpackages/*/builtとbuilt-testも除外し、ローカル成果物がcontainer内ビルドを上書きする経路を閉じた。
- setup-libvips actionの変更でもDocker検証を起動する。sharpの実libvips版をbuild scriptの固定版と照合する。pnpmのside-effects cacheを両builderで無効化し、取得済みpackageのキャッシュだけを共有する。既存backend postinstallのソースビルドを維持する。
- Debian packageを特定できないリンク先は対象パスを明示して失敗させる。
- apt二段構成はUID/GID変更がlibvips runtime層へ波及しないため維持。/opt/vips/libには必要なmodulesを含むため全体を配置する。固定4並列は小規模runnerのメモリ上限に配慮した実装上の選択で、機能不具合として扱わない。
- ビルド内smokeに加えdocker runでLD_PRELOAD=jemalloc適用後も確認する。閾値テストは既存の厳密不等号を実codec経由で境界検証しており変更不要。

第1回の独立subagentレビューでは必須修正なし。追加したMIME修正と上記対応を両者に再レビューする。

### 追加修正と最終runner検証

独立subagent再レビューで、`while ... | sort` の左側でのexitが親shellへ伝わらないと判明した。ループ出力を一時fileへ直接保存し、正常終了後に別コマンドでsortするよう修正。実scriptのloopを抽出し、1件目成功・2件目のpackage解決失敗を注入したshell実行でexit 1、対象pathのstderr、後段未実行を確認した。修正後の独立再レビューは必須指摘なしで収束した。

最終版のamd64 Docker buildは成功（`/tmp/issue15-docker-final.log`）。runner内smokeでlibvips 8.18.3 / sharp 0.35.3、RGB lossless JXL往復、JPEG/WebP/PNG/TIFF往復、AVIF2種/SVG入力、WASM複数フレームGIF→JXL再デコードの全assert成功。ビルド後も`docker run --rm --entrypoint node misskey-issue15:verify scripts/check-docker-jxl.mjs`を実行し、実行ユーザー・jemalloc設定下で同じ検証に成功した。以前のキャッシュなし構築とキャッシュあり再構築も成功済み。

Opus第2回は第1回の前提誤りを撤回し、コード上の未解決不具合なしと回答した。第3回でshell修正が正しいと確認され、Opusのコードに対する必須指摘も収束した。アプリupload/e2eとPRのarm64 CIは別途結果を追記する。
