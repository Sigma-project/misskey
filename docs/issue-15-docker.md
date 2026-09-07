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
