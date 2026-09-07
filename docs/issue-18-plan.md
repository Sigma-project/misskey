# Issue #18: 既存90日リモート投稿清掃への添付ファイル回収追加

- 対象: [Sigma-project/misskey #18](https://github.com/Sigma-project/misskey/issues/18)
- 作成日: 2026-09-07
- 計画基準: `origin/master` `2b006ee066e6360957a0c37c42569a23273c35ff`。作業ツリーの旧 HEAD からの関連差分も確認した。
- 状態: Codex と Fable 5.1 の独立設計・5往復の差異議論を完了。ユーザーによる対象変更を反映した計画案。実装は未許可。コード変更・migration 実行・データ削除は行っていない。
- [計画一覧](issue-plans.md)

## 要件・制約

既存のリモート投稿 DB 清掃に、削除した投稿が使っていた不要な添付ファイルの回収を追加する。既定90日の期限・現在の設定値・有効化状態・既存の削除条件と保護条件を維持する。清掃で実際に削除された投稿の添付だけを候補にし、他の投稿や用途で参照されるファイルは残す。

当初の1ヶ月化と新しいフォロー保護は、2026-09-07 のユーザー判断で対象外となった。投稿の受信時刻列追加、フォロー処理のロック追加、既存データの90日への一律上書き、自動有効化は実施しない。一般の孤立ファイル全体の清掃や検索 index の既存問題の修正も本件に広げない。

グローバルの `~/.codex/rules/git.md` と `tools.md` を読了。最新 `AGENTS.md` / `CLAUDE.md` を確認した。設計には Claude Fable 5.1 を `plan` モードで使用し、実装は計画確定後の明示許可を待つ。実装後は Opus 5 と subagent の検証・修正・再レビューを収束まで反復する。実装時には backend / frontend の該当スキルを読む。既存 migration は変更せず、API 生成物は生成コマンドごとに独立したコミットにする。

## 現状とコード根拠

行番号は上記計画基準のコードを参照する。旧作業ツリーとの行番号差があるため、記号名も併記する。

| 対象 | 現状と計画上の意味 |
| --- | --- |
| `packages/backend/src/queue/processors/CleanRemoteNotesProcessorService.ts` の `getConfig` / `removalCriteria` | ID の時刻を日数境界と比較する。フォロー条件はない。clip/page/pin/favorite/ローカル reaction と保持すべき子孫がある返信・renote 木を保護する。削除は `notesRepository.delete` のみで、添付は回収しない。 |
| `packages/backend/src/core/QueueService.ts:85` | `cleanRemoteNotes` を日次 cron `0 4 * * *` で実行する。期限を迎えた瞬間の削除ではなく、実行間隔・時間上限・再試行による遅れがある。 |
| `packages/backend/src/models/Meta.ts:733` | 清掃は既定で無効、期限90日、最大処理60分。単にクラスの default を変えても既存行の値は移行されない。 |
| `packages/frontend/src/pages/admin/performance.vue` / `server/api/endpoints/admin/{meta,update-meta}.ts` | 清掃の有効化、日数、処理時間を既存管理画面・API で管理する。 |
| `packages/backend/src/queue/processors/CleanRemoteFilesProcessorService.ts` | 全リモートキャッシュを対象に `deleteFileSync(file, true)` を呼ぶ。対象者・期限を絞らず、DB 行も残るため要件に直接流用できない。 |
| `packages/backend/src/core/DriveService.ts:854` / `:887` | `deleteFileSync` は原本・thumbnail・webpublic を回収する。`isExpired=true` はリモートファイルの DB 行をリンクに変換し、false は行を削除する。 |
| 同 `cleanupTranscodingArtifacts` (`:808`) | 最新 master では HLS/DASH 成果物も扱う。ただし失敗をログにして握りつぶす。削除完了保証をこの戻り値だけで判定できない。現行の動画投入はリモートを除外するが、既存属性があるファイルも扱える設計にする。 |
| `packages/backend/src/core/InternalStorageService.ts` の `del` / `delPrefix` | callback による削除は完了待ちとエラー伝播をしない。`deleteFileSync` という名前だけで内部保存の物理削除完了を保証できない。GC 用の await 可能な削除経路を設け、存在しない場合のみ成功扱いとする。 |
| `packages/backend/src/models/{Note,NoteDraft,GalleryPost}.ts` | `fileIds` は配列。FK による共有添付の削除防止を期待できない。 |
| `packages/backend/src/models/{User,Channel,ChatMessage,Page}.ts` | avatar/banner、チャネル banner、chat file、Page eyeCatchingImage、Page JSON の参照もある。無参照判定は Note だけで済ませない。URL を任意文字列に埋め込んだ用途をどこまで保証するかも区別する。 |
| `packages/backend/src/core/NoteDeleteService.ts` | 通常削除は検索 index 更新等も行うが既存清掃は通らない。本件で通常削除全体を transaction 化せず、既存清掃内の投稿削除と添付候補記録へ範囲を絞る。 |

最新 master の清掃には statement timeout 時のカーソル前進クエリから重い NOT EXISTS を外す修正がある。添付候補の記録を加える際もこの軽量 fallback を重くしない。

## 設計案の比較と議論履歴

### 当初要件の比較（ユーザー判断により投稿ポリシー変更は対象外）

Codex の独立案は既存清掃を拡張し、削除候補の添付を永続記録して別処理で回収する方式。既存の投稿木・保存操作の保護を維持する案を推奨候補とするが、ユーザーが厳格 TTL を選んだ場合は参照切断の表示・整合性まで設計を変更する。

| 案 | 利点 | 欠点・適用条件 |
| --- | --- | --- |
| A: 既存清掃にフォロー保護と添付回収を追加 | 木・保存操作保護、時間上限、既存テストを利用できる | 保護例外により1ヶ月を超えて残る。例外へのユーザー同意が必要 |
| B: 独立した厳格 TTL 清掃 | 未フォロー投稿を期限で削除する要件に直接対応 | お気に入り・ローカル返信先まで削除し得る。参照切断・表示・カウントの設計範囲が広い |
| C: キャッシュだけ期限切れにする | 既存 Drive の期限切れ機能を使える | DB 行が残るため「DB とファイル」の要件を満たさず、不採用候補 |

### Fable 5.1 への依頼と議論状況

2026-09-07、同じ要件・制約と現状根拠を渡し、`claude --permission-mode plan --model claude-fable-5-1 --print` で独立設計を依頼した。ネットワーク制限を避けるため承認済みの昇格実行を利用した。初回は約4分間設計回答がなく、中断後の出力は `Execution error` のみだった（`/tmp/issue18-fable-design.txt`）。

短い入力に要約し、`--tools '' --no-session-persistence` を追加して、同じ指定モデルと `plan` モードで再試行した。最新 master の差分、共有参照、未決事項も入力に含めた。こちらも約1分以上設計回答がなく、中断後の出力は `Execution error` のみだった（`/tmp/issue18-fable-design-v2.txt`）。接続確認への応答と、実際の設計回答の取得成功を同一視しない。

その後、並行する Issue #15 の依頼が約10分後に指定 Fable 5.1 から設計回答を返したことを確認した。上の中断は推論の遅延を切り上げた可能性があり、モデル利用不可の証拠とは扱わない。第3回を同じ指定モデル・`plan`・ツール無効・セッション永続化無効で実行し、約107秒で独立設計を取得した。結果の `modelUsage` は `claude-fable-5-1`、`is_error=false` を確認した（`/tmp/issue18-fable-design-v3.json`）。

Fable は既存清掃へのフォロー保護追加と、投稿削除から独立した参照ベースのファイル GC を推奨した。これは Codex の大枠と一致する。一方、投稿ごとの遅延ジョブはキュー量・既存データ移行が大きく過剰としている。

| 論点 | Codex 独立案 | Fable 独立案 | 第1往復で検証を求めた根拠 |
| --- | --- | --- | --- |
| フォロー競合 | follow insert と清掃の共通 author lock | DELETE 内 NOT EXISTS、フォロー後に outbox 先頭再取得 | 文の snapshot 後にもフォロー成立の窓がある。先頭取得では過去の全投稿・添付を復元できない |
| 参照追加競合 | 参照作成と共有する file lock / 削除状態 | 無参照の初回マークと猶予後再判定 | 最後の再判定直後にも参照が追加され得る。猶予のみで安全性を証明できない |
| ファイル対象 | isLink 行も DB 削除対象、実体は存在する鍵を回収 | 実体を持つファイルのみ GC | リンク行だけ残ると DB の期限削除を満たさない |
| 設定 | 既存期限設定を優先し移行方式を決定 | 既存90日と別の TTL 設定 | 旧清掃がフォロー済みを削除する併存方式は無期限保持を壊す。全清掃への共通ポリシーが必要 |
| 削除回復 | 投稿削除と同 transaction の永続回収候補 | storage を先に削除、全成功後に DB 行削除 | 状態と再試行対象を失わないことは一致。内部保存と transcoding の失敗伝播を明確にする必要がある |

**第1往復**: 上の反例を提示し、共通ロックの変更範囲が大きい欠点も示して再検討を依頼した。約286秒で回答を取得し、指定モデル・成功を確認した（`/tmp/issue18-fable-discussion1.json`）。Fable は DELETE snapshot の競合、outbox 先頭再取得の限界、リンク行の回収、設定共通化、内部保存の await 削除を認めた。file 行の FOR UPDATE と削除中状態、参照作成側の FOR SHARE、フォロー挿入の transaction と followee 行共有ロック、永続候補と補助スキャンへ案を修正した。

その回答には「Page JSON はローカルファイル限定」「Note.fileIds index は btree」「author lock が閉じる窓は小さく優先度が低い」との反論が残った。Codex は最新コードで検証した。`migration/1705222772858-optimize-note-index-for-array-column.js` は既に `USING gin ("fileIds")` を作るため、新規 GIN を重複追加しない。`PageService.create` は `body.content` / `variables` をそのまま保存し、`pages/create` の所有者チェックは eyeCatchingImage に対するものなので、JSON 全体をローカル限定と断定できない。`UserFollowingService` の following insert と followersCount increment は別の await であり、後者のロックだけでは清掃との競合を閉じない。

**第2往復**: 上の検証根拠を Fable に返し、約191秒で回答を取得した（`/tmp/issue18-fable-discussion2.json`、指定モデル・成功を確認）。Fable は GIN と Page JSON と following transaction の誤りを訂正し、既存 clean processor 内の削除・候補記録 transaction、file 共有ロック、await 回収、一般孤児と通常削除全体の transaction 化の範囲外化へ合意した。TTL 起点等を数行で変更できると約束しない点も合意した。一方、Page JSON を file 所有者一致だけ保護する提案とロック昇格 deadlock の指摘が残った。

**第3往復（最終要件への変更）**: 更新された Issue 本文とユーザー判断を Fable に共有し、90日既存清掃への添付回収だけに変更。author lock とフォロー要件を除外した。Page 所有制約を新設すると、既存の他者ファイル参照を保持する要件に反するため Codex は不採用とし、既知 JSON file ID を所有者にかかわらず保護する理由を返した。Fable の回答を `/tmp/issue18-fable-discussion3.json` で取得し、指定モデル・成功を確認した。所有者不問の保護、ID順ロック、transaction外の物理回収には同意したが、「参照側ロックの網羅は不要」と「参照あり候補を消す」という提案が残った。前者は保持側のファイル破損、後者は参照解消後の回収漏れにつながるため、そのまま採用しない。

**第4往復**: 2026-09-07 の更新ルールに従う保存セッション `50afb165-05be-4527-938d-e6c9383a7659` へ、これまでの要件・比較・根拠を引き継いだ。回答は `/tmp/issue18-fable-discussion4.json`、指定モデル・成功を確認。Fable はロック漏れの許容を撤回し、参照中候補の保留、専用の await 削除、chart/event を既存同等の best-effort とする方針へ同意した。代替として `drive_file` に候補状態を置く案を提示したが、他の削除経路で行を失っても未回収キーを保持する必要があるため、Codex は独立候補表を採用する。Page の他者 file ID を想定外利用として除外する再提案は、実際に保存可能な参照を壊すため不採用とした。

**第5往復**: 同じ保存セッションを指定形式で再開し、上記の採否とコード根拠を共有。チャート保存周期は Fable の記憶による20秒ではなく、最新コードの20分に訂正した。新たな生成物が削除確定後に書かれる競合も、参照・再利用・生成経路の状態確認の検証へ含める。回答 `/tmp/issue18-fable-discussion5.json` の指定モデル・成功を確認し、Fable は要件上の矛盾がないとして合意した。他経路で Drive 行が消えた場合は、pending/retry なら欠損完了、deleting なら保存 descriptor で物理回収してから完了し、自前の行削除件数が0なら chart/event を呼ばない。残るのは Page の抽出・保存を同じ transaction に含めること、生成物の書戻し側が削除予定状態を尊重することなど、実装時の検証である。

この後、ユーザーが既存90日清掃への添付回収追加へ対象を変更したため、フォロー・期限変更についての旧議論は採用しない。ファイル回収について得た知見を最終要件へ引き継ぐ。

## 最終要件の採用方針と実装手順

既存投稿削除と同じ DB transaction で添付候補を永続記録し、参照がなくなった候補だけを専用 worker で回収する方式を採用する。Codex と Fable の設計上の合意であり、実装許可ではない。理由は、既存投稿の保護条件を変えず、停止・部分失敗・共有参照へ対処できるため。

| 方式 | 利点 | 欠点・判断 |
| --- | --- | --- |
| 既存清掃内で即時同期削除 | 変更箇所が少ない | 投稿削除後の停止で添付 ID を失い得る。共有参照の競合とストレージ待ちで清掃の時間予算を圧迫するため不採用 |
| 削除と同一 transaction の永続候補 + 独立 worker | 投稿削除後の停止でも再開でき、共有参照を再判定しやすい | 候補テーブルと競合規約が必要。確実な回収に必要な範囲として推奨 |
| 全リモートファイルの無参照 GC | 過去の孤児も拾える | 本件の投稿削除由来を超える。対象を広げず別課題にする |

1. **既存清掃の回帰基準**: 現在の `getConfig` / `removalCriteria` / 木探索をそのまま基準とし、有効化・期限・保存操作保護の既存テストを維持する。変更前後で削除される投稿集合が一致することを確認する。新しいフォロー保護は追加しない。
2. **添付候補の永続化**: 実際の投稿削除バッチに transaction を追加し、削除対象の fileIds と投稿削除を同じ transaction に置く。失敗時は両方 rollback する。専用回収テーブルは file ID を一意にし、状態・試行回数・次回実行時刻・最終エラーを保持する。DB 削除後にメモリから初めて queue 投入する方式は採らない。一般 `NoteDeleteService` 全体を transaction 化しない。
3. **共有参照の確認**: 外部由来の添付候補について残存 Note、NoteDraft、GalleryPost、User、Channel、ChatMessage、Page の構造化 ID と既知 JSON 要素を確認する。参照があれば候補を保持し、上限付き backoff で再確認する。候補を消して参照解消後の回収を失わない。ローカル所有ファイルは削除対象から外す。任意文字列の URL は構造化参照と区別する。Note.fileIds の既存 GIN index を再利用し、重複 index を作らない。
4. **参照追加と削除の競合**: file 単位の行ロックと削除予定状態を参照作成側と共有する。GC は排他ロック後の新しい snapshot で無参照を確認して削除を確定する。削除予定状態は候補テーブルに持ち、Drive 行ロック下で参照側も読む案とする。参照書き込み側は共有ロック下で削除予定でないことを確認し、そのまま参照追加を commit する。file ID 順にロックし deadlock を避ける。所有者制約をコードで確認して、本当に remote file ID を受け付ける経路だけに参加箇所を絞る。Page JSON を根拠なくローカル専用扱いせず、既知 file ID を所有者にかかわらず保護する。削除確定済みの file は再利用・md5 一致返却でも新規参照に渡さず再解決する。
5. **物理削除と回復**: 削除確定時に storage key と派生物情報を永続保持し、新規参照を遮断してから原本・thumbnail・webpublic・存在する transcoding prefix を回収する。内部保存は await 可能な削除経路を用意し、ENOENT のみ成功扱いとする。object storage は NoSuchKey を成功扱いとし、他の失敗は再試行する。transcoding のエラー握りつぶしを GC の完了判定に使わない。部分成功・二重実行でも残りの key を失わず、全回収後に Drive 行と候補を完了処理する。isLink 行も無参照なら DB から除去する。
6. **既存 Drive 後処理との統合**: 物理回収後の Drive 行削除と候補完了を同じ DB transaction で確定し、実際に行を削除して commit した実行だけが chart/event 後処理を一度試す。既存後処理からDB削除を分離する小さな helper を検討する。完了済み候補・既にない行から再実行せず、後処理失敗で物理回収を再試行しない。通常のGC再試行で重複呼出しを防ぐが、障害時の統計・通知は既存同等の best-effort とし、欠落なし・厳密な一度限りの配送を約束しない。添付回収を投稿作者の ActivityPub Delete として外部配信しない。全リモートキャッシュを消す手動機能の対象条件は変更しない。
7. **移行・運用**: 新規 migration は up/down を実装する。候補 worker を既存 queue 基盤へ接続し、時間予算・batch 上限・再試行 backoff を設ける。未回収件数、最古候補、参照で延期した件数、失敗を観測できるようにする。既存清掃の設定を使い、追加 API や設定を必要なく増やさない。削除確定済みの物理回収は清掃の新規処理と区別し、中断しても状態から再開する。
8. **実装後の進行**: 意味のある機能単位で検証・日本語コミットを行う。Opus 5 と subagent に最終計画・ユーザー判断・差分・検証結果を共有し、指摘を根拠で評価して修正・再レビューする。収束後の PR/CI/マージは共通計画とユーザー指示に従う。

DB と storage を原子的に削除する方式ではなく、永続状態により停止後も回収を再開できる設計。既存清掃が参照保護等によって残す投稿やファイルへ厳密な90日時刻削除を追加するものではない。

後処理の根拠: 最新 `chart/core.ts` の `commit` はメモリバッファに追加し、`ChartManagementService` が20分ごとに保存する。hour/day の加算は独立しており、永続的な重複排除APIはない。`GlobalEventService` も Redis Pub/Sub で配送確認を持たない。単に outbox を追加しても、ack とバッファ保存の間の欠落・重複を解消できない。チャート基盤全体の変更を本件へ含めない。

## 検証方法・受け入れ条件

既存 `packages/backend/test/unit/queue/processors/CleanRemoteNotesProcessorService.ts` の DB を使うテストを拡張する。最新 master は Vitest であり、旧作業ツリーの Jest コマンドは使用しない。

| 検証対象 | 受け入れ条件 |
| --- | --- |
| TTL と対象 | 既存90日既定・任意の現設定・無効状態・境界時刻・ローカル投稿を固定時計で回帰検証し、投稿削除集合が変わらない |
| 保持木 | 最近の子孫・ローカル返信・clip/page/pin/favorite/ローカル reaction による既存保護を維持する |
| 共有ファイル | 古い削除投稿と保持投稿で同じ file ID を使っても保持側が壊れない。Draft/Gallery/Profile/Channel/Chat/Page 参照を個別検証する |
| 添付の競合 | 無参照確認と物理削除の間に参照作成を挟み、共通ロック/状態規約によって失われないか、確定済み削除として新規参照が拒否される |
| DB と storage | 内部保存・object storage・リンクのみ・原本と各派生物を検証する。部分削除失敗、DB commit 直後の停止、worker 二重実行、再試行時に key を失わず完了できる |
| 負荷 | 大量の保持対象と削除候補、長い返信木、statement timeout、時間上限を確認する。EXPLAIN で既存 fileIds GIN index の利用を確認し、必要な index のみ追加する |
| 運用 | 無効時、実行中の無効化、migration up/down、初回の清掃由来候補、queue の再試行と失敗観測を検証する |

実装時の検証コマンド案:

```sh
mise exec -- pnpm --filter backend test --run CleanRemoteNotesProcessorService
mise exec -- pnpm --filter backend test --run DriveService
mise exec -- pnpm --filter backend test --run
mise exec -- pnpm lint
mise exec -- pnpm --filter backend check-migrations
```

backend テストと migration 検査の前に `compose.test.yml` の DB/Redis と `.config/test.yml` を準備し、新規 migration をテスト DB へ適用する。API を変えた場合は `mise exec -- pnpm build-misskey-js-with-types` を実行する。実装時の追加テストファイル名に応じて絞り込みを更新する。JXL/libvips の fork 前提と既知 lint 例外は最新 `AGENTS.md` に従い、今回起因の失敗と分ける。

本ターンは計画文書だけのためテスト・ビルド・migration は未実行。`shipping-misskey-change` スキルを確認し、コード/API/entity/locale/画面の変更がないため対応する検証・生成・SPDX・CHANGELOG 更新は非該当。画像変換や CI の不変条件を変更していない。

## 未決事項・ユーザー判断

### ユーザー判断（2026-09-07）

Claude の設計・議論の実行にタイムアウトを設けず、時間を理由に中断しない。ユーザーの理由: 「60秒は無理だと思う」。短い poll で進捗を確認しながら待機を続ける。この判断は実装許可や保持仕様の確定ではない。

### ユーザー判断: 対象の変更（2026-09-07）

ユーザーの指示: 「既存の削除があるなら issue 側を変えて、90 日の DB 削除にファイル削除機能を追加する形の改修にして」。理由は、既存の削除機能があるため。既存90日清掃への不要添付回収追加へ絞り、既存削除・保護条件・有効化設定を維持する。1ヶ月化と新規フォロー保護は対象外。この判断は実装許可ではない。

主担当が GitHub #18 のタイトルを「既存の90日DBクリーンアップに添付ファイル削除を追加」へ変更し、本文も更新した。更新後の再取得による確認済み。計画担当も `/tmp/misskey-issue-18-body.md` の更新本文を読み、本書の最終要件へ反映した。

### 未決事項

従来の30日/暦月・受信起点・フォロー保護・自動有効化についての質問は対象変更により不要になった。最終要件での Fable 合議は完了。参照経路の具体的なロック参加箇所・候補状態遷移の実装と検証は、明示的な実装許可後に進める。保持方針を広げる必要が生じた場合だけ、新たなユーザー判断を求める。

### ユーザー判断: セッション保存（2026-09-07）

更新された AGENTS.md により、今後は `--no-session-persistence` を禁止し、指定引数順序で保存セッションを使用する。理由は設計・議論・レビューを再開可能にするため。過去の無効化指定は当時の実行履歴として残す。既存履歴を受け取った新しい保存セッションで継続する。フックの信頼状態は未確認であり、自動拒否の有効性は主張しない。

## 実装許可

実装許可は未取得。対象計画への合意だけでは実装を始めない。許可取得後、対象計画の版・許可日・許可範囲をここへ追記する。

## 実装許可の記録

**ユーザー判断（2026-09-07）**: 「それぞれ、実装を開始して」と明示された。対象は本書の確定方針（計画コミット `838335d0c7` 時点）であり、issue #18 の実装・検証・修正を開始する。理由の提示なし。過去の「実装未許可」は計画段階の履歴で、この許可により更新する。
