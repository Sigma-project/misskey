# 映像エンコーディング機能の実装

> このドキュメントは PR #13「server-side video transcoding (AV1 + VVC) with HLS/DASH delivery」の設計ドキュメント (実装計画) である。
> 初稿に対し codex によるレビューを実施し、フェデレーション安全性・成果物の配信/クリーンアップ・VVC の CMAF/DASH 整合性・リソース制御・キュー統合などの指摘を反映済み (反映履歴は本ファイル末尾)。実装で確定したスキーマ等の最新仕様は本ファイル末尾の「実装上の差分」を参照。

## Context

Misskey の現状では、サーバー側でのトランスコーディングは行われていない。`fluent-ffmpeg` は導入済みだが、用途はサムネイル生成と NSFW 判定用フレーム抽出のみ。

一方フロントエンド側には既に **`mediabunny`（WebCodecs ベース）** によるアップロード前変換処理が `packages/frontend/src/composables/use-uploader.ts` の `preprocessForVideo()` (L772-848) に存在し、`video/mp4`, `video/quicktime`, `video/x-matroska` を MP4 (AV1 / HEVC / AVC 自動選択) にリエンコードしている。ただしこれはあくまで **ブラウザ依存・端末性能依存・任意適用** であり、HLS/DASH のセグメンテーションは行われない。

本タスクでは、サーバー側でアップロード済み動画をバックグラウンドで **AV1** と **VVC (H.266)** に並列トランスコードし、**HLS** および **DASH** マニフェストを生成して配信できるようにする。これにより、(1) AV1 によるモダンブラウザでの効率的ストリーミング再生、(2) VVC による高圧縮アーカイブ・将来のブラウザ対応への布石、を実現する。

### フロント圧縮との関係（重複処理の回避）

- フロント側 `preprocessForVideo()` は **アップロード前のサイズ削減**が目的で、出力は単一の MP4 (progressive)。サーバー側の HLS/DASH 化とは目的が異なるため両方を併存させる。
- サーバー側 ProcessorService では ffprobe で **すでに AV1 ストリームの場合**は再エンコードをスキップし、`-c:v copy` でセグメンテーションのみ行う（ロスレス・高速）。
- VVC エンコードはコーデックを問わず常に元から再エンコード（フロントは VVC を出力できないため）。
- フロント圧縮を有効/無効にするかは既存のユーザー設定に従い、本計画は変更しない。

## Decisions

| 項目 | 決定 |
|------|------|
| メインコーデック | **AV1** (`libsvtav1`) — HLS + DASH の両方に含める |
| アーカイブ/将来用 | **VVC** (`libvvenc`) — DASH manifest にのみ含める（HLSは未対応）。Capability で muxer/encoder が揃わない環境では自動 gate |
| FFmpegバイナリ | 実行時に `ffmpeg -codecs` / `-muxers` で `libsvtav1` / `libvvenc` / `libopus` および HLS(fMP4)/DASH muxer の有無を検出し、利用可能なものだけ処理 |
| ABR レンダリング | **なし**。元解像度を保ったままコーデック変換のみ |
| 処理タイミング | **バックグラウンドジョブで非同期**。並行数は `videoTranscodingJobConcurrency`（デフォルト **1**） |
| オリジナル動画 | **常に保持する**（削除オプションは設けない）。`DriveFile.url` / `type` / `size` は不変のままとし、HLS/DASH manifest は派生フィールドとして追加する。これによりフェデレーション済み添付 URL が壊れない |
| 成果物の配信 | `/files/:key` とは別系統の **専用ルート**（プレフィックス配下のネストした `.m3u8` / `.m4s` を配信）。S3/内部いずれも **プレフィックス一括削除**に対応 |

## Architecture

```
[Upload] → DriveService.addFile()
            ├─ FileInfoService（既存 + duration/videoCodec/audioCodec を取得するよう拡張）
            ├─ generateAlts()（既存：サムネイル）
            ├─ DB保存（DriveFile）
            └─ ★QueueService.createVideoTranscodingJob(fileId) （新規）
                    │  ※ Meta.enableVideoTranscoding / Capability / size / duration / codec で
                    │     エンキュー前に skip 判定（probe 結果は FileInfo を再利用）
                    ▼
            [videoTranscoding queue] VideoTranscodingProcessorService （新規, concurrency=1）
                    ├─ originalをtemp DLに取得
                    ├─ FFmpegCapabilityService で対応 encoder/muxer 確認
                    ├─ AV1 fMP4 セグメント生成（CMAF）
                    ├─ VVC fMP4 セグメント生成（CMAF準拠コンテナ、Capability 揃う場合のみ）
                    ├─ HLS master.m3u8 / playlist.m3u8 生成（AV1のみ）
                    ├─ DASH manifest.mpd 生成（parse済みメタから整合生成。AV1 + VVC）
                    ├─ ObjectStorage / 内部ストレージへ一括upload（成果物キーを全件記録）
                    └─ DriveFile を hlsManifestUrl / dashManifestUrl / transcodingStatus /
                       transcodingPrefix / transcodingStoredInternal / transcodingVariants で更新
                       （url/type/size は変更しない）

[再生] フロント MkMediaVideo.vue → 専用ルート /transcoded/{prefix}/... で manifest/segment を取得
[削除] DriveService.deleteFile → original 3キー + transcodingPrefix 配下を一括削除
```

## ストレージレイアウト

ObjectStorage / 内部ストレージ上に `{prefix}stream-{fileId}-{rand}/` を新設し、CMAF 形式のセグメントを格納：

```
stream-{fileId}-{rand}/
  master.m3u8                # HLS マスター
  manifest.mpd               # DASH マニフェスト
  av1/
    init.mp4
    seg-001.m4s ... seg-NNN.m4s
    playlist.m3u8            # HLS media playlist (AV1)
  vvc/                       # libvvenc + muxer 利用可能時のみ
    init.mp4
    seg-001.m4s ...
```

HLS と DASH は同じ fMP4 セグメントを参照する（**CMAF**）ことでストレージを節約。`transcodingPrefix` には `stream-{fileId}-{rand}` を保存し、配信ルートと削除処理の両方がこのプレフィックスを基準に動作する。

## 成果物の配信とクリーンアップ（重要 / 初稿の欠落）

初稿の最大の欠陥は **ネストした成果物を既存ファイルサーバーモデルでは配信もクリーンアップもできない** 点だった。実コードで確認した制約：

- `FileServerService.ts:100` — `/files/:key/*` は `/files/:key` に **301 リダイレクト**してしまう（ネストパスを配信できない）
- `FileServerFileResolver.ts` — 解決は **完全一致キー**のみ
- `DriveService.ts:755` / `S3Service.ts:66` / `InternalStorageService.del` — 削除は **完全一致キー単体**のみ（プレフィックス削除なし）

### 配信ルート（新規）

`/transcoded/:prefix/*`（仮）を新設し、`stream-{fileId}-{rand}/...` 配下の `.m3u8` / `.m4s` / `init.mp4` を配信する。

- **パス検証**: `prefix` は `^stream-[0-9a-z]+-[0-9a-z]+$` に限定。`*` 部分は `..` やバックスラッシュを拒否し、許可拡張子（`.m3u8` / `.mpd` / `.m4s` / `.mp4`）のみ通す。`Path.resolve` 後にベースディレクトリ配下か再検証（path traversal 対策）。
- **Content-Type**: `.m3u8`→`application/vnd.apple.mpegurl`, `.mpd`→`application/dash+xml`, `.m4s`/`.mp4`→`video/mp4`/`video/iso.segment`。
- **キャッシュ/Range**: セグメントは `Cache-Control: max-age=31536000, immutable`、manifest は短め。`Range` リクエストに対応（内部ストレージは `fs.createReadStream` の `start/end`、S3 は `Range` をパススルー）。
- 内部ストレージ配信時も CSP は既存 `media-src 'self'` の範囲で問題なし。
- S3 利用時はトランスコード成果物 URL を `config.url` 経由（プロキシ）にするか、ObjectStorage の公開 baseUrl を使うかを `transcodingStoredInternal` に応じて切替える。

### プレフィックス削除（新規）

- `InternalStorageService`: ネストキー保存のため `saveFromPath`/`saveFromBuffer` で親ディレクトリを `mkdirSync(recursive)`。`delPrefix(prefix)` で `fs.rm(dir, { recursive: true })`。
- `S3Service`: `ListObjectsV2`（プレフィックス）→ `DeleteObjects`（最大1000件バッチ、continuation token ループ）で `deletePrefix(meta, prefix)` を実装。
- `DriveService.deleteFile` / `deleteFileSync`: 既存 3 キー削除に加え、`transcodingPrefix` があれば `transcodingStoredInternal` に応じて内部/ S3 のプレフィックス削除を呼ぶ。

## 変更ファイル

### バックエンド

#### 新規
| ファイル | 役割 |
|---------|------|
| `packages/backend/src/core/FFmpegCapabilityService.ts` | 起動時に `fluent-ffmpeg` の `getAvailableEncoders()` / `getAvailableFormats()` を解析し `libsvtav1` / `libvvenc` / `libopus` エンコーダと HLS(fMP4)/DASH muxer の有無をキャッシュ |
| `packages/backend/src/core/VideoTranscodingService.ts` | AV1/VVC エンコード + HLS/DASH manifest 生成のコアロジック。`fluent-ffmpeg` をラップし、`createTempDir()` を利用。タイムアウト・出力サイズ上限・`finally` クリーンアップを内包 |
| `packages/backend/src/core/VideoTranscodingProgressService.ts` | 進捗イベントを `GlobalEventService` 経由で publish + Redis に per-job key（TTL付き）でスナップショット + index set 管理 |
| `packages/backend/src/queue/processors/VideoTranscodingProcessorService.ts` | キュージョブの実行本体。失敗時は3回までリトライ、`transcodingStatus` を `failed` に更新。キャンセル対応 |
| `packages/backend/src/server/api/stream/channels/video-transcoding.ts` | 進捗の WebSocket チャンネル（`kind: 'read:admin:queue'`） |
| `packages/backend/src/server/api/endpoints/admin/video-transcoding/{list-jobs,cancel-job,retry-job}.ts` | 管理用 REST API |
| `packages/backend/migration/{timestamp}-videoTranscoding.js` | DriveFile / Meta スキーマ拡張（`up()`/`down()` 両対応） |

#### 既存ファイルの修正
| ファイル | 修正内容 |
|---------|---------|
| `packages/backend/src/models/DriveFile.ts` | `hlsManifestUrl`, `dashManifestUrl`, `transcodingStatus`, `transcodingPrefix`, `transcodingStoredInternal`, `transcodingVariants`(jsonb) を追加。`properties` 型に `duration?`, `videoCodec?`, `audioCodec?` を追加 |
| `packages/backend/src/models/Meta.ts` | `enableVideoTranscoding: boolean`, `videoTranscodeMaxFileSize: number`, `videoTranscodeMaxDuration: number`（0で無制限）を追加。**`keepOriginalAfterTranscoding` は設けない** |
| `packages/backend/src/core/FileInfoService.ts` | `FileInfo` に `duration` / `videoCodec` / `audioCodec` を追加し、動画の ffprobe 時に取得（既存 probe 箇所 L361 付近を再利用し、ProcessorService での二重 probe を避ける） |
| `packages/backend/src/core/DriveService.ts` | 動画アップロード成功後、Meta設定とCapability結果と FileInfo に応じて `QueueService.createVideoTranscodingJob(fileId)` を呼ぶ。削除時に `transcodingPrefix` 配下も掃除 |
| `packages/backend/src/core/InternalStorageService.ts` | 親ディレクトリを自動 `mkdirSync(recursive)`（ネストキー対応）+ `delPrefix()` |
| `packages/backend/src/core/S3Service.ts` | `deletePrefix()`（ListObjectsV2 + DeleteObjects バッチ） |
| `packages/backend/src/server/FileServerService.ts`（or 新規 file ハンドラ） | `/transcoded/:prefix/*` 配信ルート |
| `packages/backend/src/core/QueueService.ts` / `QueueModule.ts` | 新キュー `videoTranscoding` の追加と `createVideoTranscodingJob()` メソッド |
| `packages/backend/src/queue/QueueProcessorService.ts` / `QueueProcessorModule.ts` | `VideoTranscodingProcessorService` の登録 + worker の start/stop + stats |
| `packages/backend/src/queue/const.ts` / `types.ts` | 新キュー名定数 / `VideoTranscodingJobData` 型 / `QUEUE_TYPES` |
| `packages/backend/src/core/GlobalEventService.ts` | `publishVideoTranscodingStream()` メソッド追加（型付きイベント） |
| `packages/backend/src/core/entities/DriveFileEntityService.ts` | API レスポンスに新フィールドを含める |
| `packages/backend/src/models/json-schema/drive-file.ts` | DriveFile スキーマに新フィールド追加 |
| `packages/backend/src/server/api/endpoints/admin/meta.ts` / `update-meta.ts` | 新Meta項目の読み書き、Capability 検出結果の公開 |
| `packages/backend/src/server/api/stream/ChannelsService.ts` / `server/ServerModule.ts` | 新チャンネルの登録 |
| `packages/backend/src/server/api/endpoint-list.ts` | 新管理 API の export |
| `packages/backend/src/config.ts` | `videoTranscodingJobConcurrency` 追加（デフォルト 1） |

### フロントエンド

| ファイル | 修正内容 |
|---------|---------|
| `packages/frontend/package.json` | `hls.js` 依存追加 |
| `packages/frontend/src/components/MkMediaVideo.vue` | `video.hlsManifestUrl` が存在し、ブラウザがネイティブHLS非対応の場合 `hls.js` を動的import してアタッチ。Safariはネイティブで `<video src="manifest.m3u8">` を渡す。`hls.js` 自体が unsupported を返した場合は `video.url` にフォールバック |
| `packages/frontend/src/pages/admin/video-transcoding.vue` (新規) | 管理ページ: 設定フォーム / Capability 表示 / ライブ進捗 / Cancel / Retry / 失敗ジョブ一覧 |
| `packages/frontend/src/pages/admin/index.vue` | サイドバーに「Video Transcoding」項目追加 |
| `packages/frontend/src/router.definition.ts` | `/admin/video-transcoding` ルート追加 |
| `packages/misskey-js/src/streaming.types.ts` / `consts.ts` | 新ストリーミングチャンネル定義 / queue type 追加 |

## FFmpeg 呼び出し仕様

### AV1 (libsvtav1) — HLS用にCMAF fMP4出力
```
ffmpeg -i input.mp4 \
  -c:v libsvtav1 -preset 8 -crf 32 -pix_fmt yuv420p -g 120 \
  -c:a libopus -b:a 128k \
  -f hls -hls_time 6 -hls_playlist_type vod \
  -hls_segment_type fmp4 \
  -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename av1/seg-%03d.m4s \
  -hls_flags independent_segments \
  av1/playlist.m3u8
```

入力動画が既に AV1 の場合は `-c:v copy` で再エンコードを回避（FileInfo.videoCodec で判定）。

オーディオエンコーダは `FFmpegCapabilityService` の検出結果に基づき、`libopus` 利用可能なら opus / 不可なら `aac` を選択する（ffmpeg ビルドの差を吸収）。

### VVC (libvvenc) — DASH用にfMP4セグメント出力
```
ffmpeg -i input.mp4 \
  -c:v libvvenc -preset medium -qp 32 -pix_fmt yuv420p -g 120 \
  -c:a libopus -b:a 128k \
  -f hls -hls_time 6 -hls_playlist_type vod \
  -hls_segment_type fmp4 \
  -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename vvc/seg-%03d.m4s \
  vvc/playlist.m3u8
```

## VVC の CMAF/DASH 整合性（初稿の技術的未確立点）

> codex 指摘: HLS muxer が吐く fMP4 が、そのまま正当な「共有 CMAF/DASH 表現」になる保証はない。MPD は実際の init box / codec string / timescale / セグメント長 / RAP / VVC sample entry と整合している必要がある。

本実装での担保方針：

1. **MPD は文字列固定テンプレートで生成しない**。エンコード後に各 representation の `init.mp4` / 1セグメントを `ffprobe -show_streams -show_format`（および可能なら `MP4Box`/`mp4dump` 相当）で読み、`codecs`（AV1: `av01.*`, VVC: `vvc1.*`/`vvi1.*`）、`timescale`、`duration`、`bandwidth`、`width/height` を抽出して MPD に埋める。
2. **SegmentTemplate は実セグメント数・実セグメント長**に基づき生成（`hls_time` は目安であり実長と一致しない場合があるため、playlist.m3u8 の `#EXTINF` を一次情報として使う）。
3. **VVC sample entry / codec string が ffprobe で取得できない**（古い ffmpeg ビルド等）場合は、VVC representation を MPD から外し AV1 のみで DASH を構成する（壊れた MPD を出すより安全）。
4. 受け入れ確認として `dash.js` 系プレイヤーでのロードと、可能なら DASH-IF conformance に類するチェックを Verification に含める。
5. VVC は **Capability（encoder + 必要 muxer）が揃わない環境では完全に gate** し、AV1+HLS のみで完結させる。

## リソース / DoS 制御（初稿の不足点）

- `videoTranscodeMaxFileSize`（0=無制限だが、運用上は推奨値を管理画面の説明文で案内）と `videoTranscodeMaxDuration` でエンキュー前に弾く。
- 並行数 `videoTranscodingJobConcurrency` の **デフォルトは 1**（CPU を食う処理のため）。
- ffmpeg / ffprobe の **wall-clock タイムアウト**（例: duration × 係数 + 上限）を設け、超過時は子プロセスを kill して失敗扱い。
- 出力の **総バイト数 / セグメント数の上限**を設け、超過したらジョブを中断（暴走・ストレージ枯渇対策）。
- temp ディレクトリは `createTempDir()` で確保し、成功/失敗/キャンセルいずれも `finally` で確実に削除。
- 入力は **ローカル/自ホストのアップロードのみ**（`userHost != null` のリモートは対象外）。

## 起動時 Capability 検出

`FFmpegCapabilityService` で `fluent-ffmpeg` の `getAvailableEncoders()` と `getAvailableFormats()` を非同期呼出し、エンコーダ（`libsvtav1`/`libvvenc`/`libopus`）と muxer（`hls`/`dash`、fMP4 セグメント対応）を **別々に** 検出して結果をキャッシュ。

ログ出力例：
```
[ffmpeg-capability] AV1 encoder (libsvtav1): available
[ffmpeg-capability] VVC encoder (libvvenc): not available
[ffmpeg-capability] Opus encoder (libopus): available
[ffmpeg-capability] HLS fMP4 muxer: available
[ffmpeg-capability] DASH muxer: available
```

## DriveFile / Meta スキーマ詳細

```sql
ALTER TABLE "drive_file"
  ADD "hlsManifestUrl"            varchar(512),
  ADD "dashManifestUrl"           varchar(512),
  ADD "transcodingStatus"         varchar(16),
  ADD "transcodingPrefix"         varchar(256),
  ADD "transcodingStoredInternal" boolean,
  ADD "transcodingVariants"       jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "meta"
  ADD "enableVideoTranscoding"       boolean NOT NULL DEFAULT false,
  ADD "videoTranscodeMaxFileSize"    bigint  NOT NULL DEFAULT 0,
  ADD "videoTranscodeMaxDuration"    integer NOT NULL DEFAULT 0;
```

migration は **`down()` で上記カラムをすべて `DROP COLUMN`** する。`migrate` / `revert` / `check-migrations` が clean になることを確認する。

`transcodingStatus`: `'pending' | 'processing' | 'completed' | 'failed' | 'skipped'`

`transcodingStoredInternal` は **トランスコード成果物のストレージバックエンド**を記録する（オリジナルファイルの `storedInternal` とは別）。`meta.useObjectStorage` を後で切り替えても、削除・配信パスが正しいバックエンドに対して動作するよう保証する。

### `transcodingVariants` の契約

各要素は 1 つの出力 representation を表す discriminated record：

```typescript
type TranscodingVariant = {
  codec: 'av1' | 'vvc';
  container: 'cmaf';
  manifestType: 'hls' | 'dash' | 'both';
  playlistPath: string;     // prefix からの相対 (例: 'av1/playlist.m3u8')
  initPath: string;         // 'av1/init.mp4'
  width: number;
  height: number;
  bitrate: number;          // bps
  durationSec: number;
  byteSize: number;
  codecString: string;      // 'av01.0.05M.08' 等
};
```

v1 で UI から細かく使わない場合でも、削除・再配信・将来の ABR 拡張のため最低限このスキーマで保存する。

## オリジナル動画の取り扱い

**オリジナルは常に保持する**（初稿の `keepOriginalAfterTranscoding=false`／オリジナル削除・URL 書き換えは、フェデレーション済み添付 URL を 404 にしうるため撤回）。

- オリジナルファイル（S3 上の `{prefix}{accessKey}` / 内部の `accessKey`）はそのまま残る
- `DriveFile.url` / `type` / `size` は **不変**。ダウンロード / ActivityPub 連合配信は従来どおり `url`（オリジナル）を使う
- `hlsManifestUrl` / `dashManifestUrl` が **追加で**利用可能になる（派生フィールド）
- フロントの `<video>` タグは manifest を優先使用（後述）。manifest が無ければ従来どおり `url` を使う

### フロントエンドの再生優先順位

`MkMediaVideo.vue` での `<video>` ソース選択ロジック：
```typescript
if (file.hlsManifestUrl && supportsNativeHls) {
  // Safari など: ネイティブ HLS
  src = file.hlsManifestUrl;
} else if (file.hlsManifestUrl) {
  // それ以外: hls.js を動的import してアタッチ
  // hls.js.isSupported() が false の場合は file.url にフォールバック
} else {
  // フォールバック
  src = file.url;
}
```

ダウンロードボタン (`MkMediaList.vue` 等) は `file.url`（オリジナル）を常に使う。オリジナルは常に保持されるため、単一ファイルのダウンロードは従来どおり可能。

## FileInfoService 拡張（duration / codec の集約）

初稿は ProcessorService 内で別途 ffprobe する想定だったが、`FileInfoService` が既に ffprobe を所有している（`FileInfoService.ts:361` 付近）。ここを拡張して `FileInfo` に `duration` / `videoCodec` / `audioCodec` を持たせ、アップロード時に取得・保存する。これにより：

- skip 判定（duration 上限 / 既 AV1 判定）を **エンキュー前**に行える
- ProcessorService での二重 probe を避けられる
- DriveFile.properties に `duration` 等を保存し API でも露出できる

## エラー処理 / スキップ条件

- アップロード時 `Meta.enableVideoTranscoding === false` → ジョブ投入しない（`transcodingStatus = null`）
- `Meta.videoTranscodeMaxFileSize > 0 && file.size > limit` → ジョブ投入しない
- `Meta.videoTranscodeMaxDuration > 0 && FileInfo.duration > limit` → ジョブ投入しない（または `skipped`）
- リモートファイル (`userHost != null`) → スキップ（オリジナルサーバが配信）
- libsvtav1 が無い環境 → スキップ
- ジョブ失敗3回 → `transcodingStatus = 'failed'`、元動画は引き続き `url` から配信可能

## 管理画面でのリアルタイム進捗監視

### バックエンド: 進捗イベントの発行

`fluent-ffmpeg` の `progress` イベントから `timemark` を読み取り、duration と突き合わせてパーセントを算出。**スロットリング（最短1秒間隔）**で配信する。

`VideoTranscodingProgressService` が以下の payload を `GlobalEventService.publishVideoTranscodingStream()` 経由で流す：

```typescript
type VideoTranscodingProgressEvent = {
  fileId: string;
  userId: string | null;
  fileName: string;
  phase: 'queued' | 'downloading' | 'probing' | 'encoding-av1' | 'encoding-vvc' | 'uploading' | 'done' | 'skipped' | 'failed';
  percent: number;            // 0..100（phase内）
  overallPercent: number;     // 0..100（全フェーズ加重平均）
  codec?: 'av1' | 'vvc';
  fps?: number;
  speed?: string;
  message?: string;
  startedAt: number;
  updatedAt: number;
};
```

### バックエンド: 配信チャンネル

Misskey の既存 WebSocket ストリーミング基盤を使い、**新規チャンネル** `videoTranscoding` を追加。`kind: 'read:admin:queue'` でモデレーター以上に閲覧を制限。

### バックエンド: Redis スナップショット

ProcessorService が `videoTranscoding:active:{fileId}` に **per-job key**（`SET ... EX 86400`）で JSON payload を保存し、完了/失敗で `DEL`。一覧取得のため `videoTranscoding:index`（set）に fileId を add/remove。単一ハッシュにまとめず per-key TTL で自然失効させる。

### バックエンド: 状態のスナップショット取得API / 操作API

| エンドポイント | 内容 |
|---|---|
| `admin/video-transcoding/list-jobs` | 進行中ジョブ一覧 (Redis index + per-job key) + 直近の失敗ジョブ (DB から) |
| `admin/video-transcoding/cancel-job` | キューから削除し、Redis スナップショットと DB の `transcodingStatus` を更新 |
| `admin/video-transcoding/retry-job` | 失敗ジョブの再投入 |

### フロントエンド: 管理画面

`/admin/video-transcoding`:

- 初期ロードで `admin/video-transcoding/list-jobs` を叩いて現状取得
- `useStream().useChannel('videoTranscoding')` で WebSocket 接続し、`progress` イベントを購読
- Vue の `ref<Map<fileId, JobState>>` に蓄積、`phase === 'done' | 'failed' | 'skipped'` 受信から30秒後に自動でリストから除外
- Cancel / Retry ボタン
- Capability 表示 (AV1/VVC/Opus/muxer)
- 設定フォーム (有効化 / 最大サイズ / 最大長さ)

### フェーズ別の overallPercent 重み付け

| phase | weight |
|-------|--------|
| downloading | 5% |
| probing | 2% |
| encoding-av1 | 50% (VVC利用可能時) / 85% (利用不可時) |
| encoding-vvc | 35%（利用可能時。利用不可なら 0） |
| uploading | 8% |

## API / 型 / レポート再生成

- backend JSON schema (`models/json-schema/drive-file.ts`) と packer (`DriveFileEntityService.ts`) の両方に新フィールドを追加（片方だけだと型と実体がずれる）。
- `pnpm --filter misskey-js api` を実行し `packages/misskey-js/etc/misskey-js.api.md` を更新コミット。
- `misskey-js` の `autogen/types.ts` 等が生成物なら、生成コマンドを実行してコミット。
- streaming チャンネル型 (`streaming.types.ts`) と queue type (`consts.ts`) を追加。

## Verification

1. **ユニット / 静的検証**
   - `pnpm --filter backend typecheck` / `pnpm --filter frontend lint`
   - `pnpm --filter misskey-js api` で API report が clean
   - postgres を立てて migration `up` → `down` → 再 `up`、`check-migrations` が clean

2. **エンドツーエンド（手動）**
   - 開発環境で AV1 対応 ffmpeg を確認: `ffmpeg -codecs | grep -E "(libsvtav1|libvvenc)"` と `ffmpeg -muxers | grep -E "(hls|dash)"`
   - Admin → `/admin/video-transcoding` で「動画トランスコーディング」を有効化
   - 短い `.mp4` ファイル（10-30秒程度）をアップロード
   - 管理ページに進捗が 0%→100% で流れることを確認
   - ObjectStorage / 内部ストレージに `stream-{fileId}-{rand}/master.m3u8` 等が生成されているか確認
   - 専用ルート `/transcoded/stream-.../av1/playlist.m3u8` / `seg-001.m4s` が 200 で配信され Range が効くこと
   - `MkMediaVideo.vue` で動画再生時、ネットワークタブに `.m3u8` / `.m4s` リクエストが流れることを確認
   - Chrome (hls.js経由) / Safari (ネイティブHLS) 両方で再生確認
   - VVC が利用可能なビルドなら DASH manifest を `dash.js` の demo player などで読み込み VVC ストリームが含まれること（取得できない環境では AV1 のみで MPD が valid なこと）
   - **DriveFile.url / type / size がトランスコード後も不変**であること（federation 安全性）
   - DriveFile を削除した際に `stream-*/` 配下が（内部/ S3 とも）プレフィックスごと削除されること

3. **回帰確認**
   - 既存の画像アップロード・サムネイル生成に影響しないこと
   - `enableVideoTranscoding = false` のとき従来通り動画が `url` から直接配信されること
   - リモート (federated) 動画には新フィールドが付かないこと
   - 既存の `/files/:key` 配信・削除が従来どおり動くこと

## Out of Scope

- ABR（複数解像度）対応
- ライブストリーミング
- HEVC/H.264 等の旧コーデック
- 一般ユーザー向けのトランスコード進捗表示（投稿者本人にも見せるかは将来検討。現状は管理者のみ）
- オリジナル動画の自動削除（フェデレーション安全性のため v1 では行わない）

## レビュー反映履歴（初稿 → 改訂）

codex レビューを受けて以下を変更：

1. **オリジナル削除オプションを撤回**。`keepOriginalAfterTranscoding=false` による `DriveFile.url`/`type`/`size` 書き換えはフェデレーション済み URL を壊すため。常にオリジナルを保持し、manifest は派生フィールドとして追加する。Meta から該当カラムを削除。
2. **成果物の専用配信ルートとプレフィックス削除を追加**。`/files/:key/*` が `/files/:key` に 301 リダイレクトする・削除が完全一致キーのみ、という既存制約により、ネストした HLS/DASH 成果物は配信もクリーンアップも不可能だった。`/transcoded/:prefix/*` 配信ルート + `delPrefix`/`deletePrefix` を新設。
3. **VVC の CMAF/DASH 整合性を担保する手順を明文化**。MPD は固定テンプレートではなく parse 済みメタから生成し、取得できない環境では VVC を gate。
4. **リソース/DoS 制御を追加**。concurrency デフォルト 1、wall-clock タイムアウト、出力サイズ上限、`finally` での temp 掃除、duration/size 上限。
5. **キュー統合を first-class 化**。定数/型/provider/worker/start-stop/stats を全箇所登録。
6. **進捗 Redis を per-job key + TTL + index** に変更し、`GlobalEventService` 経由の型付きイベントにする。
7. **duration/codec 抽出を `FileInfoService` に集約**し、エンキュー前に skip 判定。二重 probe を回避。
8. **`transcodingVariants` の契約を定義**（discriminated schema）。
9. **API schema / misskey-js 型 / API report の再生成手順を明記**。
10. **migration の `down()` を必須化**。
11. **Capability 検出を encoder と muxer に分離**。

## 実装上の差分（計画→実装）

### 確定した設計・実装

- **ストレージプレフィックス**: `transcodingPrefix` は論理プレフィックス `stream-{fileId}-{rand}`（rand は 16 桁 hex）。内部ストレージは `{filesDir}/{prefix}/...`、S3 は `{objectStoragePrefix}/{prefix}/...`。配信ルートの prefix 検証は `^stream-[0-9a-z]+-[0-9a-z]+$`。
- **成果物の配信**: 内部ストレージ保存時は `/transcoded/:prefix/*`（Range/Content-Type/Cache 対応）。ObjectStorage 保存時は成果物 URL が S3 を直接指すため専用ルートは不要。`transcodingStoredInternal` で保存先を記録し、削除時に正しいバックエンドを選ぶ。
- **manifest 内のセグメント参照は相対パス**（`av1/seg-001.m4s` 等）にし、HLS/DASH で同一 CMAF セグメントを共有。HLS muxer に絶対パスで出力後、media playlist の URI を basename へ正規化している。
- **DASH MPD**: 固定テンプレートではなく、実セグメント（playlist の `#EXTINF`）と init を ffprobe して SegmentList 形式で生成。VVC の codec string が取れない等で representation を構成できない場合は AV1 のみに縮退、それも無理なら DASH 自体を出さず HLS のみ。
- **codec string は best-effort**（特に VVC）。HLS master の CODECS 属性は誤判定回避のため付与せず、プレイヤーのメディア判定に委ねている。
- **enqueue 前 skip 判定**は `FileInfoService` の duration/codec（DriveFile.properties に保存）で行い、Processor 側でも二重に判定。
- **進捗 Redis** は `videoTranscoding:active:{fileId}`（per-job key, 進行中 24h / 終端 60s TTL）+ `videoTranscoding:index`（set）。`GlobalEventService.publishVideoTranscodingStream` 経由で `videoTranscodingStream` チャンネルに型付き配信。スロットリングは最短 1 秒（終端は常に配信）。
- **キャンセル**は主に待機中ジョブ対象（`videoTranscodingQueue.getJob(fileId).remove()`、jobId=fileId）。実行中（ロック中）ジョブの即時停止は best-effort。

### この環境で実行できなかったコード生成 / 検証ステップ

ローカルに `tsgo`（TypeScript ネイティブコンパイラ）が未インストールで、フルビルド成果物（frontend の vite manifest 等）も無いため、以下は CI / 開発フルビルドで実施が必要：

- `pnpm --filter backend generate-api-json` → `pnpm --filter misskey-js/generator generate` → `update-autogen-code`：misskey-js autogen（`endpoint.ts`/`types.ts` の operations 等）の再生成。本実装では DriveFile エンティティの新フィールドのみ autogen `types.ts` に手動反映済み。新 admin エンドポイント 3 種とストリーミングチャンネルの型は再生成で確定する（フロントエンドは暫定的に型キャストで呼び出している）。
- `pnpm --filter misskey-js api`：API report（`etc/misskey-js.api.md`）の更新。
- フロントエンドの typecheck / lint（tsgo 依存）。
- postgres を用いた migration `up`/`down`/`check-migrations`（マイグレーションは ADD/DROP COLUMN の対称な up/down を実装済み）。

バックエンドは `tsc --noEmit` で型チェック済みで、本実装が追加・変更したファイルに型エラーは無い（既存の Reversi/Signin 関連エラーは develop 由来で本実装と無関係）。
