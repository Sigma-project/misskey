# 映像エンコーディング機能の実装

> このドキュメントは PR #13 「server-side video transcoding (AV1 + VVC) with HLS/DASH delivery」の設計ドキュメント (実装計画) である。実装中に若干調整が入った箇所があるが、設計意図と全体像を保存するためそのまま残してある。実装で確定したスキーマ等の最新仕様は本ファイル末尾の「実装上の差分」を参照。

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
| アーカイブ/将来用 | **VVC** (`libvvenc`) — DASH manifest にのみ含める（HLSは未対応） |
| FFmpegバイナリ | 実行時に `ffmpeg -codecs` で `libsvtav1` / `libvvenc` の有無を検出し、利用可能なものだけ処理 |
| ABR レンダリング | **なし**。元解像度を保ったままコーデック変換のみ |
| 処理タイミング | **バックグラウンドジョブで非同期** |
| オリジナル動画 | 管理者設定 `keepOriginalAfterTranscoding`（デフォルト `true`）で制御。`false` の場合はトランスコード成功後にオリジナルを削除しストレージ節約 |

## Architecture

```
[Upload] → DriveService.addFile()
            ├─ FileInfoService（既存）
            ├─ generateAlts()（既存：サムネイル）
            ├─ DB保存（DriveFile）
            └─ ★QueueService.createVideoTranscodingJob(fileId) （新規）
                    │
                    ▼
            [videoTranscoding queue] VideoTranscodingProcessorService （新規）
                    ├─ originalをtemp DLに取得
                    ├─ FFmpegCapabilityService で対応コーデック確認
                    ├─ AV1 fMP4 セグメント生成（CMAF）
                    ├─ VVC fMP4 セグメント生成（CMAFに準拠したコンテナ、利用可能時）
                    ├─ HLS master.m3u8 / playlist.m3u8 生成（AV1のみ）
                    ├─ DASH manifest.mpd 生成（AV1 + VVC）
                    ├─ ObjectStorage / 内部ストレージへ一括upload
                    └─ DriveFile を hlsManifestUrl / dashManifestUrl / transcodingStatus で更新
```

## ストレージレイアウト

ObjectStorage 上に `{prefix}stream-{fileId}-{rand}/` を新設し、CMAF 形式のセグメントを格納：

```
stream-{fileId}-{rand}/
  master.m3u8                # HLS マスター
  manifest.mpd               # DASH マニフェスト
  av1/
    init.mp4
    seg-001.m4s ... seg-NNN.m4s
    playlist.m3u8            # HLS media playlist (AV1)
  vvc/                       # libvvenc利用可能時のみ
    init.mp4
    seg-001.m4s ...
```

HLS と DASH は同じ fMP4 セグメントを参照する（**CMAF**）ことでストレージを節約。

## 変更ファイル

### バックエンド

#### 新規
| ファイル | 役割 |
|---------|------|
| `packages/backend/src/core/FFmpegCapabilityService.ts` | 起動時に `fluent-ffmpeg` の `getAvailableEncoders()` を解析し `libsvtav1` / `libvvenc` / `libopus` の有無をキャッシュ |
| `packages/backend/src/core/VideoTranscodingService.ts` | AV1/VVC エンコード + HLS/DASH manifest 生成のコアロジック。`fluent-ffmpeg` をラップし、`createTempDir()` を利用 |
| `packages/backend/src/core/VideoTranscodingProgressService.ts` | 進捗イベントを Redis Pub/Sub に publish + ハッシュにスナップショット |
| `packages/backend/src/queue/processors/VideoTranscodingProcessorService.ts` | キュージョブの実行本体。失敗時は3回までリトライ、`transcodingStatus` を `failed` に更新 |
| `packages/backend/src/server/api/stream/channels/video-transcoding.ts` | 進捗の WebSocket チャンネル |
| `packages/backend/src/server/api/endpoints/admin/video-transcoding/{list-jobs,cancel-job,retry-job}.ts` | 管理用 REST API |
| `packages/backend/migration/{timestamp}-videoTranscoding.js` | DriveFile / Meta スキーマ拡張 |

#### 既存ファイルの修正
| ファイル | 修正内容 |
|---------|---------|
| `packages/backend/src/models/DriveFile.ts` | `hlsManifestUrl`, `dashManifestUrl`, `transcodingStatus`, `transcodingPrefix`, `transcodingStoredInternal`, `transcodingVariants`(jsonb), `properties.duration`, `properties.videoCodec`, `properties.audioCodec` を追加 |
| `packages/backend/src/models/Meta.ts` | `enableVideoTranscoding: boolean`, `videoTranscodeMaxFileSize: number`, `videoTranscodeMaxDuration: number`（0で無制限）, `keepOriginalAfterTranscoding: boolean` を追加 |
| `packages/backend/src/core/DriveService.ts` | 動画アップロード成功後、Meta設定とCapability結果に応じて `QueueService.createVideoTranscodingJob(fileId)` を呼ぶ。削除時に `transcodingPrefix` 配下も掃除 |
| `packages/backend/src/core/QueueService.ts` / `QueueModule.ts` | 新キュー `videoTranscoding` の追加と `createVideoTranscodingJob()` メソッド |
| `packages/backend/src/queue/QueueProcessorService.ts` / `QueueProcessorModule.ts` | `VideoTranscodingProcessorService` を登録 |
| `packages/backend/src/queue/const.ts` / `types.ts` | 新キュー名定数 / `VideoTranscodingJobData` 型 |
| `packages/backend/src/core/InternalStorageService.ts` | 親ディレクトリを自動 `mkdirSync` する（ネストキー対応） |
| `packages/backend/src/core/GlobalEventService.ts` | `publishVideoTranscodingStream()` メソッド追加 |
| `packages/backend/src/core/entities/DriveFileEntityService.ts` | API レスポンスに新フィールドを含める |
| `packages/backend/src/models/json-schema/drive-file.ts` | DriveFile スキーマに新フィールド追加 |
| `packages/backend/src/server/api/endpoints/admin/meta.ts` / `update-meta.ts` | 新Meta項目の読み書き、Capability 検出結果の公開 |
| `packages/backend/src/server/api/stream/ChannelsService.ts` / `server/ServerModule.ts` | 新チャンネルの登録 |
| `packages/backend/src/server/api/endpoint-list.ts` | 新管理 API の export |
| `packages/backend/src/config.ts` | `videoTranscodingJobConcurrency` 追加 |

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

入力動画が既に AV1 の場合は `-c:v copy` で再エンコードを回避。

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

VVC エンコーダは多くのビルドで DASH muxer に未対応のため、HLS muxer 経由で fMP4 セグメントを出力し、DASH manifest はサーバー側で文字列テンプレートとして生成して両方から同じセグメントを参照させる（CMAF）。

## 起動時 Capability 検出

`FFmpegCapabilityService` で `fluent-ffmpeg` の `getAvailableEncoders()` を非同期呼出し、結果をキャッシュ。

ログ出力例：
```
[ffmpeg-capability] AV1 encoder (libsvtav1): available
[ffmpeg-capability] VVC encoder (libvvenc): not available
[ffmpeg-capability] Opus encoder (libopus): available
```

## DriveFile / Meta スキーマ詳細

```sql
ALTER TABLE "drive_file"
  ADD "hlsManifestUrl"            varchar(512),
  ADD "dashManifestUrl"           varchar(512),
  ADD "transcodingStatus"         varchar(16),
  ADD "transcodingPrefix"         varchar(256),
  ADD "transcodingStoredInternal" boolean,
  ADD "transcodingVariants"       jsonb DEFAULT '[]'::jsonb;

ALTER TABLE "meta"
  ADD "enableVideoTranscoding"       boolean NOT NULL DEFAULT false,
  ADD "videoTranscodeMaxFileSize"    bigint  NOT NULL DEFAULT 0,
  ADD "videoTranscodeMaxDuration"    integer NOT NULL DEFAULT 0,
  ADD "keepOriginalAfterTranscoding" boolean NOT NULL DEFAULT true;
```

`transcodingStatus`: `'pending' | 'processing' | 'completed' | 'failed' | 'skipped'`

`transcodingStoredInternal` は **トランスコード成果物のストレージバックエンド**を記録する（オリジナルファイルの `storedInternal` とは別）。`meta.useObjectStorage` を後で切り替えても、削除パスが正しいバックエンドに対して動作するよう保証する。

## オリジナル動画の取り扱い

トランスコード成功後の処理は管理者設定 `keepOriginalAfterTranscoding` に従う。

### `keepOriginalAfterTranscoding = true`（デフォルト）
- オリジナルファイル（S3上の `{prefix}{accessKey}`）はそのまま残る
- `DriveFile.url` はオリジナルを指し続ける
- `hlsManifestUrl` / `dashManifestUrl` が追加で利用可能
- フロントの `<video>` タグは manifest を優先使用（後述）。ダウンロード/ActivityPub 連合配信は `url`（オリジナル）を使う

### `keepOriginalAfterTranscoding = false`
- トランスコード成功直後、`s3Service.delete(originalAccessKey)` でオリジナル削除
- `DriveFile.url` を `hlsManifestUrl`（master.m3u8）の値に書き換える
- 同様に `webpublicUrl` も置き換え。`thumbnailUrl` は既存サムネ画像を維持
- `DriveFile.type` は `'application/vnd.apple.mpegurl'` に更新
- `DriveFile.size` は HLS+DASH 全セグメント合計サイズを保存
- `storedInternal` は実際にストリームを書き込んだバックエンドに合わせて更新
- **トランスコード失敗時はオリジナル削除しない**（安全側に倒す）

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

ダウンロードボタン (`MkMediaList.vue` 等) は `file.url` を常に使う想定。`keepOriginalAfterTranscoding = false` の場合、ダウンロードは master.m3u8 になりブラウザでは直接視聴可能だが「単一ファイル」のダウンロードはできなくなる — この挙動は管理画面の設定説明文で明示する。

## エラー処理 / スキップ条件

- アップロード時 `Meta.enableVideoTranscoding === false` → ジョブ投入しない（`transcodingStatus = null`）
- `Meta.videoTranscodeMaxFileSize > 0 && file.size > limit` → ジョブ投入しない
- ffprobe で動画長を取得 → `Meta.videoTranscodeMaxDuration > 0 && duration > limit` → スキップ（progress phase = `skipped`）
- リモートファイル (`userHost != null`) → スキップ（オリジナルサーバが配信）
- libsvtav1 が無い環境 → スキップ
- ジョブ失敗3回 → `transcodingStatus = 'failed'`、元動画は引き続き `url` から配信可能

## 管理画面でのリアルタイム進捗監視

### バックエンド: 進捗イベントの発行

`fluent-ffmpeg` の `progress` イベントから `timemark` を読み取り、duration と突き合わせてパーセントを算出。**スロットリング（最短1秒間隔）**で Redis Pub/Sub に publish する。

`VideoTranscodingProgressService` が以下の payload を流す：

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

### バックエンド: 状態のスナップショット取得API / 操作API

| エンドポイント | 内容 |
|---|---|
| `admin/video-transcoding/list-jobs` | 進行中ジョブ一覧 (Redis ハッシュから) + 直近の失敗ジョブ (DB から) |
| `admin/video-transcoding/cancel-job` | キューから削除し、Redis スナップショットと DB の `transcodingStatus` を更新 |
| `admin/video-transcoding/retry-job` | 失敗ジョブの再投入 |

Redis スナップショットは ProcessorService が `HSET videoTranscoding:active {fileId} {jsonPayload}` し、完了/失敗で `HDEL`。TTL は 24h。

### フロントエンド: 管理画面

`/admin/video-transcoding`:

- 初期ロードで `admin/video-transcoding/list-jobs` を叩いて現状取得
- `useStream().useChannel('videoTranscoding')` で WebSocket 接続し、`progress` イベントを購読
- Vue の `ref<Map<fileId, JobState>>` に蓄積、`phase === 'done' | 'failed' | 'skipped'` 受信から30秒後に自動でリストから除外
- Cancel / Retry ボタン
- Capability 表示 (AV1/VVC/Opus)
- 設定フォーム (有効化 / オリジナル保持 / 最大サイズ / 最大長さ)

### フェーズ別の overallPercent 重み付け

| phase | weight |
|-------|--------|
| downloading | 5% |
| probing | 2% |
| encoding-av1 | 50% (VVC利用可能時) / 85% (利用不可時) |
| encoding-vvc | 35%（利用可能時。利用不可なら 0） |
| uploading | 8% |

## Verification

1. **ユニット / 静的検証**
   - `pnpm --filter backend typecheck` / `pnpm --filter frontend lint`
   - `pnpm --filter misskey-js api` で API report が clean
   - postgres を立てて migration → `check-migrations` が clean

2. **エンドツーエンド（手動）**
   - 開発環境で AV1 対応 ffmpeg を確認: `ffmpeg -codecs | grep -E "(libsvtav1|libvvenc)"`
   - Admin → `/admin/video-transcoding` で「動画トランスコーディング」を有効化
   - 短い `.mp4` ファイル（10-30秒程度）をアップロード
   - 管理ページに進捗が 0%→100% で流れることを確認
   - ObjectStorage / 内部ストレージに `stream-{fileId}-{rand}/master.m3u8` 等が生成されているか確認
   - `MkMediaVideo.vue` で動画再生時、ネットワークタブに `.m3u8` / `.m4s` リクエストが流れることを確認
   - Chrome (hls.js経由) / Safari (ネイティブHLS) 両方で再生確認
   - VVC が利用可能なビルドなら DASH manifest を `dash.js` の demo player などで読み込み VVC ストリームが含まれることを確認
   - `keepOriginalAfterTranscoding = false` でオリジナルが削除され `DriveFile.url` が HLS master を指すこと
   - DriveFile を削除した際に `stream-*/` 配下も削除されること

3. **回帰確認**
   - 既存の画像アップロード・サムネイル生成に影響しないこと
   - `enableVideoTranscoding = false` のとき従来通り動画が `url` から直接配信されること
   - リモート (federated) 動画には新フィールドが付かないこと

## Out of Scope

- ABR（複数解像度）対応
- ライブストリーミング
- HEVC/H.264 等の旧コーデック
- 一般ユーザー向けのトランスコード進捗表示（投稿者本人にも見せるかは将来検討。現状は管理者のみ）

## 実装上の差分（計画→実装）

- `transcodingStoredInternal` カラムを追加（計画になし）。トランスコード成果物のストレージバックエンドを記録するため。これで `meta.useObjectStorage` を後から切替えてもクリーンアップが破綻しない。
- `progress` フェーズに `skipped` を追加（計画では `failed`/`done` のみ）。policy-based skip を UI 上で失敗扱いにしないため。
- オーディオエンコーダは libopus 固定ではなく、Capability に基づき `opus`/`aac` を切り替え。
- 管理画面の進捗チャンネルは `admin` 配下ではなく独立した `videoTranscoding` チャンネルにした（`kind: read:admin:queue` で権限制御）。
