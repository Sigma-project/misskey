# Issue #18: 既存90日リモート投稿清掃への添付ファイル回収追加

- 対象: [Sigma-project/misskey #18](https://github.com/Sigma-project/misskey/issues/18)
- 作成日: 2026-09-07
- 計画基準: `origin/master` `2b006ee066e6360957a0c37c42569a23273c35ff`。作業ツリーの旧 HEAD からの関連差分も確認した。
- 状態（2026-09-07更新）: ユーザーの明示許可を得て実装済み。Opus5の第1回指摘を検証・修正し、unit全体とmigration往復を検証済み。API e2e全体と第2回レビューを実行中。下記の計画時点の記述は当時の検討履歴であり、現在の実装・許可状態は「実装許可の記録」以降を参照する。
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

初回計画作成ターン時点（履歴）は計画文書だけのためテスト・ビルド・migration は未実行。`shipping-misskey-change` スキルを確認し、コード/API/entity/locale/画面の変更がないため対応する検証・生成・SPDX・CHANGELOG 更新は非該当。画像変換や CI の不変条件を変更していない。

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

2026-09-07に明示的な実装許可を取得済み。対象計画の版・許可日・許可範囲は直下の「実装許可の記録」に記載する。計画段階では許可取得まで実装を待機した。

## 実装許可の記録

**ユーザー判断（2026-09-07）**: 「それぞれ、実装を開始して」と明示された。対象は本書の確定方針（計画コミット `838335d0c7` 時点）であり、issue #18 の実装・検証・修正を開始する。理由の提示なし。過去の「実装未許可」は計画段階の履歴で、この許可により更新する。


## 実装記録（2026-09-07）

以下はエージェントの実装判断であり、追加の「ユーザー判断」ではない。対象・期限・有効化状態・投稿保護条件を変更していない。

- `CleanRemoteNotesProcessorService` の既存バッチDELETEに transaction を加え、`DELETE RETURNING fileIds` で実際に削除された投稿の候補だけを独立表へ記録する。候補書込み失敗時は投稿削除も rollback する。
- `remote_file_cleanup` はfile IDの一意キー、pending/deleting、試行回数、次回時刻、最終エラー、Drive descriptorを保持する。FKを設けず、通常削除経路でDrive行が消えてもdeletingのstorageキーを失わない。pending欠損は候補完了、deleting欠損はdescriptorによる物理回収を完了する。
- 参照追加ガードはDBのBEFORE INSERT/UPDATE triggerで実装した。全7表の保存transactionで、新規追加IDを順にDrive行FOR SHARE→新しいREAD COMMITTED snapshotでdeleting確認する。アプリ個別経路のtransaction改修より網羅性を維持しやすく、AP・Page・直接Repository経路にも同じ規約が適用される。GCはDrive行FOR UPDATE後の新しいsnapshotで共有参照を再確認する。既存IDを維持する更新は追加参照として扱わない。
- Page content/variablesのfileId/fileIdsは入れ子も抽出し所有者不問で保護する。任意文字列URLは対象外。既存欠損IDを維持する更新を許容する一方、新規欠損IDは拒否する。完了後にDrive行と候補が消えた古いIDへの参照を拒否するために必要で、他の各APIは既に存在チェックを持つ。Pageの任意JSON保存だけはこの整合性検査が新たに適用される。
- 再利用のmd5/URI lookupはdeletingを除外する。既存動画processorはリモート所有ファイルを生成対象外にするため、その境界を回帰検証した。画像生成は新規Drive行のinsert前に完了し、その未公開IDはGC候補にならない。
- 回収workerは5分間隔の既存system queueで起動し、最大100候補・開始から60秒のバッチ予算を持つ。Claudeの実行待機タイムアウトとは無関係の運用上のworker負荷上限である。参照中は候補を保持し、2分から最大24時間へbackoffする。無効時はpendingの新規削除確定を止め、deletingだけを再開する。
- 同じfile IDの二重workerをsession advisory lockで排除し、短いDB transactionの間にstorage I/Oを行う。内部保存はawait/ENOENTのみ許容、object storageはNoSuchKeyのみ許容。S3のHTTP成功内のDeleteObjects.Errorsも検査する。全key回収後にDrive削除と候補完了を同transactionでcommitし、その実行だけが既存chart/eventをbest-effortで試す。
- Page JSONの再帰抽出が候補ごとの全走査になるため、抽出式に単一GIN indexを追加した。既存Note/NoteDraftのGINを再利用する。Page 1000件×100候補の独立schema計測は25,222ms→107ms。Note1万件のEXPLAINで既存GIN、新Pageの実SQL EXPLAINで追加GINの利用を確認。100候補に対するChat10万行411ms、Gallery1万行152ms、Channel1万行134msの計測では、これらへの追加indexは今回の負荷予算に不要と判断した。これらはローカル測定で本番性能保証ではない。
- Page indexは通常作成と環境変数でのCONCURRENTLY作成をサポートし、失敗時のinvalid indexを再作成できる。migrationのdownはindex→trigger/function→候補表の順に巻き戻す。

### 検証の記録

- 独立worktree `/tmp/misskey-issue18`、独立compose project `misskey-issue18-test`（DB54318/Redis56318）で検証。共有の運用DBは使用しない。migration検証はunit testのdropSchema/synchronizeと干渉しない別DB `test-misskey-migration18` を使用する。
- 清掃・回収48件、guard/再利用/remote動画21件、共有参照/索引/負荷15件、Drive storage9件のテスト成功。清掃fixtureは本番同様にguard migrationを明示up/downする（TypeORM synchronizeだけではSQL trigger/functionを作らないため）。
- 内部ファイルの実unlink/prefix削除とENOENT/ディレクトリエラー、S3原本/派生物/prefix/ページング/部分Errors/NoSuchKey、候補書込みrollback、storage失敗とdescriptor再試行、worker重複、通知失敗、参照の保留と解消後回収、全7表参照追加競合を確認した。
- backend lint/typecheck成功。全体lintはfrontend-builderの既知OXC型不整合、および初回frontend依存workspace未buildを検出したため、後者の依存をbuildして再検証中。API定義・locale・画面コードは変更していないためAPI生成・locale追加・画面確認は対象外。手書きmigration、entity、TS新規ファイルへSPDXを追加した。
- backend/依存workspaceのbuild-pre/buildはgitignored成果物のみで、tracked生成差分はない。手書き変更は機能一体としてコミットする。
- 新規migrationの専用DB適用・往復・pending DDL検証とOpus5/独立subagentレビューは進行中。完了後に結果を追記する。


### 実装時の最終検証（2026-09-07）

- 関連6ファイルをまとめて94テスト成功。その後、最終DB確定失敗の再試行・pending欠損の2件を追加し、GC10件を再実行して全成功。異なるテスト総数96件。ログ: `/tmp/issue18-final-tests.log`、`/tmp/issue18-gc-final-tests.log`。テスト型チェックも成功。
- 新規3 migrationを専用DBで全適用後、index→guard→候補表の順にdownして再適用し、`check-migrations` が `All migrations are clean.`（pending DDL 0件）で成功。ログ: `/tmp/issue18-migrations-up.log`、`/tmp/issue18-migration-down-{1,2,3}.log`、`/tmp/issue18-migration-reapply.log`、`/tmp/issue18-migration-check.log`。Page indexのCONCURRENTLYモードも独立schemaの往復試験に成功。
- 全体 `pnpm lint` は13 workspace成功、frontend-builderはAGENTS記載の既知OXC型不整合。frontendは未buildのmisskey-bubble-game依存に起因した失敗を解消し、依存build後にfrontend lint成功。追加実装後のbackend lint/typecheck、テスト型チェック、変更ファイルESLint、diff空白チェックも成功。ログ: `/tmp/issue18-lint-escalated.log`、`/tmp/issue18-frontend-lint.log`、`/tmp/issue18-backend-lint-final.log`。
- ローカルglobal libvips未設置のため、この独立worktreeの依存インストール時だけ `SHARP_IGNORE_GLOBAL_LIBVIPS=1` とbuild-from-source環境変数解除を使用した。JXLエンコードを検証するものではなく、今回のDB/収納削除テストは全成功。リポジトリのJXLビルド設定・画像生成挙動は変更していない。初回実装検証時点ではbackend全unit suite・JXLの追加検証は未実行だった（その後、レビュー修正の広域検証でJXL対応環境の全unitを実行。後節参照）。
- 実装差分・本書・検証結果をOpus5と独立subagentへ渡す準備が完了した。レビュー収束とPR/CI/マージは引き続き必要であり、実装コミットだけで完了扱いにしない。


## Opus 5 第1回レビューへの検証・対応（参照ガード担当、2026-09-07）

対象回答: `/tmp/issue18-opus-review1.json`（`result` 全文読了）。本節はエージェントによる評価・実装判断であり、ユーザー判断ではない。

### P1-4: 全行JSON化と添付なし書込み負荷 — 妥当、修正済み

旧ガードは `to_jsonb(NEW)` と再帰CTEを全対象INSERTで実行し、添付なしNoteでもtext・reactions等を走査していた。独立schemaで5000件、各text3600文字・reactions32項目・空fileIdsを一文INSERTして793msを計測した。

修正後は対象列を直接読む。Note/Draft/GalleryはfileIds配列、UserはavatarId/bannerId、ChannelはbannerId、ChatはfileId、Pageだけcontent/variablesの既知IDを再帰抽出する。全行JSON化の補助関数は廃止した。INSERTには非空WHEN、UPDATEには非空と対象列のIS DISTINCT FROMを組み合わせたWHENを設定し、空参照や同じ値への更新ではトリガー関数そのものを呼ばない。既存missing参照を維持する更新の許容、ID順FOR SHARE、新snapshotのdeleting確認は維持する。nullableな旧参照配列はNULL要素を除去してからANY比較し、新規参照がSQL NULLで判定から抜けないようにした。

同じ5000件の挿入は修正後64ms、再実行58ms。EXPLAIN ANALYZEでも添付なしINSERTと同じfileIdsのUPDATEにTriggersが無いことをassert。無関係なNote JSONを参照として扱わないテストを追加し、全7表の新規/更新/消滅/競合テストも通過した。時間値は最小テスト構成の測定であり、本番環境の保証ではない。

### P1-1: Draft/Userの索引欠落という指摘 — 当該3経路は不採用、検証補完

マイグレーション用DB（`.config/migration18.yml` 接続先）を読み取り、`pg_indexes`から以下の実在を確認した。

- `note_draft`: `IDX_NOTE_DRAFT_FILE_IDS`、`USING gin ("fileIds")`。既存 `1736686850345-createNoteDraft.js` が作成。
- `user`: `REL_58f5c71eaab331645112cf8cfa`、avatarIdのunique btree。
- `user`: `REL_afc64b53f8db3707ceb34eb28e`、bannerIdのunique btree。

Userの2索引は既存@OneToOne由来。通常のschema同期用test.yml DBにはsynchronize:falseのDraft GINは無く、これを本番migrationの欠落と混同しない。

独立schemaに上記と同じ索引を設定し、実hasReferencesが発行したSQLをそのままEXPLAIN ANALYZEした。Draft1万件の命中/不一致とも既存GINを使用。User10万件のavatar命中/banner命中/不一致はいずれも2つの既存unique索引を使用した。100個の不一致候補に対する測定はDraft119ms、User96ms（投入時間除外）。不要な重複索引は追加しない。

他の未索引経路も再測定: Chat10万件380ms、Gallery1万件159ms、Channel1万件127ms（各100候補、投入時間除外）。Pageは新索引利用で1000件98ms。これらはwarmな最小schemaの観測値であり、無制限の本番規模の性能保証ではない。現状の具体的な30秒timeoutの再現根拠はなく、候補数/運用観測は主担当の別指摘対応と合わせて評価する。

### P2-8: ガードエラー識別 — 主担当のAPI修正へ対応済み

missing/deletingの両RAISEに `CONSTRAINT = 'remote_file_cleanup_reference_guard'` を追加し、SQLSTATE23503は維持した。ガード拒否のテスト全てでcodeとconstraintの両方をassertした。通常のFKエラーとの識別とAPI側400への変換は主担当の担当範囲。

### P2-9: IMMUTABLE抽出関数と式索引の依存 — 妥当、コメント追加済み

`remote_file_cleanup_json_ids` の直前に、将来の抽出規則変更では同じmigration内で `IDX_PAGE_REMOTE_FILE_REFERENCES` を再構築し、回収処理再開より前に完了させる必要を明記した。PostgreSQLは関数の実装変更だけでは既存index値を無効化しない。今回の関数の抽出意味自体は変更していない。

`down()`には、Page索引migrationを先に戻す必要があり、CASCADEで誤った順序を隠さないことを明記した。独立schemaテストはindex down→index up→index down→guard downの順で実行している。AGENTS.mdの共通規則へ追記するなら「remote_file_cleanup_json_idsの抽出規則変更時はPage式索引を同migrationで再構築し、rollbackは索引を先に戻す」を推奨（本担当の編集許可ファイル外なので未変更）。

### 検証

backend cwd:

```sh
mise exec -- ./node_modules/.bin/vitest run --config vitest.config.unit.ts RemoteFileReferenceGuard RemoteFileReferenceQueries --reporter verbose --disableConsoleIntercept
mise exec -- ../../node_modules/.bin/eslint --quiet test/unit/RemoteFileReferenceGuard.ts test/unit/RemoteFileReferenceQueries.ts
```

36 tests passed、2 files passed、13.80s（2026-09-07 22:01:38 UTC開始）。ESLintとgit diff --checkは別途完了を確認。主担当の全体lint/migration/e2e/レビューと機能単位コミットに含める。


### 第1回レビューの残項目への評価・対応（主担当）

以下もエージェントの判断であり、ユーザー判断ではない。

- **P1-2（派生物キー書込み）: 提案を不採用。** 現在の画像生成はDriveService.addFile/saveで新規Drive行insertより前に完了する。既存行へ新規storage成果物を書き戻す経路はVideoTranscodingProcessorServiceだけで、リモート所有ファイルは処理開始時にskipし回帰テストでも確認した。DriveService.updateは名前/フォルダ/説明/センシティブ等でstorage keyを更新しない。期限切れリンク化はNULL化ではなくrandomUUIDのproxy用キーへ更新するため、提案された非NULLキー変更禁止は既存の期限切れ処理を誤って拒否する。将来リモート向け派生生成を追加する際は状態規約への参加が必要だが、現存しない書込み経路を理由に禁止トリガーを追加しない。
- **P1-3（linkに非NULLキーがあるならS3削除）: 前提が誤りのため不採用。** DriveService.addFileのlink作成も期限切れリンク化も、実体のないproxy解決用accessKey/thumbnailAccessKey/webpublicAccessKeyをrandomUUIDで設定する。純linkのキーはNULLという指摘は実コードと異なる。isLink条件を外すと、object storage未設定の通常linkを架空キーのS3削除に送って永続失敗させる。原本はstoredInternal/非linkの実保存情報に従い、独立したtranscodingPrefixはlink状態にかかわらず回収する。期限切れ化前にdeleting確定した場合は、descriptorに旧実キーが残る。過去の別削除経路で既に失われた未知のstorage keyを一般孤児として探すことは計画の範囲外。
- **P1-5（同URI登録のunique衝突）: 前提が誤りのため不採用、再現検証を追加。** 初期migrationのdrive_file.uriは非uniqueのIDX_e5848eac4940934e23dbc17581で、現MiDriveFileも@Index()のみ。uri/userIdの複合uniqueは存在しない。削除中旧行を保持したまま、同URI・同ownerの新ID挿入とPageへの新規参照がHTTP e2eで成功した。DriveService.addFileの実再登録経路でも同bytes/URIの削除中行から別ID/別proxy keyで作成できる回帰検証を追加した。したがってDrive行の早期削除やURI切離しは必要なく、全物理回収後にDrive行を削除する確定計画を維持する。
- **P2-6（最古候補の走査）: 改善。** createdAtに索引を追加して最古候補LIMIT 1を支える。候補件数countは正確な未回収件数の観測に必要なので維持する。候補表は本PRの新規表で、追加indexの通常作成は既存巨大表のlockを発生させない。
- **P2-7（テスト並列衝突）: 不採用、根拠を確認。** vitest.config.tsはmaxWorkers:1でunit/e2e共通設定へ継承される。ファイルの実行は同時に1つで、各public schema fixtureのup/downは並列にならない。専用schemaのguard/queryテストは引き続き独立。DB自体も他issue/運用DBから分離した。e2e共通setupは本番のguardを明示設置し、独自にDBを再初期化するmove suiteでも再設置する。
- **P2-8（APIの500）: 妥当、修正。** ガードに固有constraint名を付け、ApiCallServiceは当該23503だけを400 NO_SUCH_FILEへ変換する。既存FK違反全般をmissing扱いにしない。Page JSONの新規missing/deletingをHTTPで検証し、通常FKはINTERNAL_ERRORのままであることも確認する。meta/paramDef/resやendpoint登録は変更していないためSDK生成対象の差分はない。API reviewer指示書の対象はendpoints配下と定義されており、本件にはその変更がない。
- **P2-10（transcoding削除重複）: 現在の不具合ではないため不採用。** 既存cleanupTranscodingArtifactsと厳密版は、同じ保存済みprefixを内部ではdirectory、S3ではprefix末尾slashとして使う。動画保存のstoredPrefixもこの規約と一致している。GCで通常削除のエラー握り潰しを再利用しないことは確定計画に沿い、将来のdriftという仮定だけで通常削除全体の待機/失敗挙動を変更しない。双方の保存先判定をstorageテストで検証した。
- **P2-11（100件/回の上限）: 妥当、修正。** 100件はメモリ上限の1バッチとし、同じ60秒予算内でfileIdのkeysetを進めて次バッチを取得する。これにより1日28,800件という人工的な上限をなくし、locked候補を同じ実行で繰り返さない。205件のdue候補について複数バッチを走査し、一度ずつ試すテストを追加した。物理I/O待機はなお処理量の上限であり、無制限の入力に追従する保証はしない。既存system queueを長時間占有する最大60分化や無条件並列I/Oは採らず、固定の負荷予算と観測を維持する。
- **P3:** 候補欠損等のdeferred分類は「この試行で物理回収していない」の意味で既存ログを維持する。stackはlogger.warn(err)に記録し、永続lastErrorは要約を保持する。migrationインデントは既存ファイル群でも混在し動作問題はない。投稿削除統計は元の実装どおり選択集合を数えるもので、今回の候補はRETURNING実削除集合だけから作る。統計の既存競合挙動変更は本件に広げない。
- **要検証1:** MiUserの構造化ファイル参照はavatarId/bannerId。Ad/Meta/Emoji/AvatarDecorationはURL文字列を保存し、構造化fileId参照は無い。任意URLを参照として解析することは計画対象外。
- **要検証4/5:** 初回実装でmigration up/down/upとpending DDL0件、maxWorkers1を確認済。今回の変更後も再検証する。

`MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY=1` は既存ormconfigのmigrationsTransactionMode=eachと組み合わせ、Page式索引をtransaction外で作成する運用オプション。既定は通常のtransaction内作成。本件のJSON抽出関数の意味を将来変える場合は、同migrationでPage式索引も再構築してからGCを再開し、rollbackではindexを先に戻す。

### 第1回レビュー修正の検証進捗

- guard/query36 tests成功、修正後backend lint/typecheck成功。
- HTTP e2eのmissing/deletingエラー・sameURI新ID参照2件成功。通常FK対比のテストを追加して広域検証へ含める。
- JXL有効libvips 8.18.3のimage `misskey-issue15-vips:dev` にffmpegを追加した検証専用image `misskey-issue18-test:dev` を作成。独立worktreeのsharpをこのimage内でsource buildし、fullunit/e2eの画像前提を満たして広域検証を進行中。成果物はnode_modules/builtのみでtracked生成差分なし。


### 第1回レビュー修正の広域検証結果（追記）

- JXL有効libvips/ffmpeg imageでbackend unit全67ファイルを実行。66ファイル・830件成功、SearchServiceのMeilisearch接続だけが検証用サービス未起動によりECONNREFUSEDだった。CI同versionのMeilisearch v1.49.0を専用containerで57712に起動し、SearchService32件＋UserSearchService9件のfocused再実行が全成功。合算して異なる846件成功、元からskip指定のDriveFileEntity/DriveFolderEntity各1件だけが未実行。ログは`/tmp/issue18-review-fullunit.log`と`/tmp/issue18-review-search-unit.log`。今回の失敗をコード起因と混同しない。
- レビューで求めた実DriveService.addFileの同URI/同bytes再登録テストも成功。storage障害相当のdeleting descriptorが残る間に、同ownerの別IDと別proxy keyが生成される。
- 4件の新規migrationを専用DBでup→4件down→upし、最新版entityに対するpending DDL0件を確認。`/tmp/issue18-review-migrations.log`末尾はAll migrations are clean。
- レビュー修正後のbackend全typecheck/eslintも成功（`/tmp/issue18-review-final-lint.log`）。API e2e全体はguardを有効にして実行中であり、結果は後続に記録する。

- 全E2E初回は1262件成功したが、synalio/abuse-reportが第2Nest appを起動してtest DataSourceのdropSchemaを再実行し、guardが消えるため共通teardownが失敗した。残った関数により後続suite setupも失敗した。moveと同様、当該suiteのqueue起動直後にguardを再設置し、共通setup/teardownはtest限定のIF EXISTS付き関数清掃でschema再初期化・中断残骸に対応した。本番migrationの厳密なdownは変更していない。fixture eslint成功後、全E2Eを再実行中（`/tmp/issue18-review-fulle2e2.log`）。

### Opus 5 第2回レビューの採否

- N1: E2E fixture問題として妥当で対応済。第2Nest appのtest schema再作成が実際の発火点だった。setup/teardownのtest限定清掃とqueue開始後のguard復旧を採用した。本番migrationはtransactional up/downで履歴が管理され、冪等化を必須とする根拠がない。CREATE OR REPLACEで将来の式索引を無意識に古いまま残すリスクを増やさず、誤順序downも引き続き検出する。
- N2: 中央で発生するクライアント入力エラーとして扱う。ApiCallServiceの既存RATE_LIMIT_EXCEEDED/AUTHENTICATION_FAILED同様、各endpoint metaに同じ共通エラーを複製しない。追加UUIDはpackages内検索で当該定義1件のみ。pages/createのNO_SUCH_FILEはb7b97489-0f66-4b12-a5ff-b21bd63f6e1c、notes/createはb6992544-63e7-67f0-fa7f-32444b1b5306で、元々同codeが発生元別UUIDを持つ規約。今回も中央DB guard発生元を一意に識別する。ログ必須化は不採用: JSON内の普通のmissing ID入力でも発火するため「低頻度のGC競合のみ」という前提が誤り。既存ApiErrorと同じ400応答とし、不正入力のmessage/userIdを必ずwarnする新しい運用方針は導入しない。HTTPテストで通常FKの500診断保持と区別する。
- N3: 妥当として改善。due時刻の古い順を維持する(nextAttemptAt,fileId) tuple cursorと同順複合indexへ変更する。Dateのミリ秒丸めで同じ候補を繰り返さないようcursor時刻はPostgreSQLの::text値を保存する。逆ID順のmicrosecond差を持つ205候補の実DBテストで順序と各1回を確認する。
- N4: 不採用。WHENのORはeyeCatchingImageIdか非空JSONのいずれかに実参照があればtrueで、他項NULLでもguardを呼ぶ。全項NULL/空は抽出されるIDが無く保護すべき参照も無い。nullable fixtureはこの広い入力も試すためで、具体的な保護回避反例は無い。IS DISTINCT FROMにして空NULL行でも関数を呼ぶ必要はない。
- N5: 個別warn追加は予防提案として不採用。unlock例外は既にprocessのfailed+logger.warnへ到達し診断が残るため「観測不能」ではない。接続断ならPostgreSQLがsession lockを解放する。専用warnだけでは指摘の仮定である生きた接続のlock残存を解決せず、実際の故障根拠なく追加しない。旧row_ids関数DROP IF EXISTSは本番へ未マージの初期実装との差分で、masterのmigration履歴は一切編集していない。
- 残余のChat/Gallery/Channel線形走査は今回の計測規模（Chat10万、Gallery/Channel各1万）の結果であり、より大きい運用で同じ性能を保証しない。候補backlog/最古時刻/処理時間を監視し、規模増大で走査が支配的になれば該当列のindexを追加する。countの概算化提案は実害根拠が示されておらず、計画の正確な未回収候補数を維持する。

### 第2回レビュー修正後の検証結果

- 全E2E: 30ファイル、1332件成功、既存2skip/20todo、exit 0（`/tmp/issue18-review-fulle2e2.log`）。Page guardの400、無関係FKの500、deleting中の同URI再登録の3件も成功。
- tuple cursor変更後の清掃processor2ファイル51件成功（`/tmp/issue18-review2-processors.log`）。205件/microsecond境界のテストを含む。raw SQL cast列を引用する修正後に再実行した。
- 複合due索引の新migrationをup/down/upし、pending DDL 0件（`/tmp/issue18-review2-migrations.log`）。この時点の新規migrationは合計5件。
- backend全lint/typecheckと最終変更ファイルeslint成功（`/tmp/issue18-review2-lint.log`、`/tmp/issue18-review2-final-eslint.log`）。
- N1のunit中断再開についても、2つの清掃processor fixtureでup前にtest限定の残存関数清掃を行うようにした。通常のunit終了時は厳密なdownでproduction rollbackを引き続き検証する。
- 独立subagentは第2回修正差分も必須指摘なし。Opus 5は第3回再レビュー中。

### 正式レビューの収束

Opus 5は保存セッション `4e3a4bea-aa1b-4b95-a773-9c8f7b8e4aac` で3回レビューし、第3回で第1/2回の指摘をすべて修正済みまたは根拠により撤回として収束を明示した。独立subagentも全差分、tuple/indexの追加修正、最後のunit fixture前処理まで再確認し、必須指摘なしと回答した。unitの両清掃fixtureに中断後の関数清掃があることも確認済み。レビューの回数を理由に指摘を残していない。

migration5本の整理案やcursorの明示castなどは不具合根拠のない任意提案として現状を維持する。各機能の修正・検証履歴をコミット単位で残す。PR/CIと最新masterの統合後確認を引き続き実施する。

### 最新masterの統合

#15のPR #20が全39 CI成功後にmasterへマージされたため、そのcommit `7f52e05f34a38c3350ac0e702092590e16369843` を統合する。競合は計画Docsのadd/addとCHANGELOGの追記のみで、各issueの最新計画・判断・検証履歴と両changelog行を保持した。製品コードの競合・手動改変はない。統合後の画像判定/清掃processorテストと型検査を行う。

統合後のFileInfo44件＋清掃processor51件、計95件が同一JXL環境で成功した（`/tmp/issue18-integrated-tests.log`）。backendの全型検査とESLintもexit0（`/tmp/issue18-integrated-lint.log`）。Opusの保存セッションでの追加統合確認と独立subagentの確認はいずれも新たな必須指摘なし、収束維持。以降のPR/CI・マージ結果は[GitHub issue #18](https://github.com/Sigma-project/misskey/issues/18)に紐づくPRで確認できる。

### PR #21 レビュー: 候補INSERTのbind上限（2026-09-08）

- Codexコメント3950766265は妥当。再帰reply treeからの削除RETURNING集合はroot選択のcurrentLimitだけでは制限できず、全unique fileIdを1回のINSERTへ渡すとPostgreSQLのbind parameter上限を超えうる。
- 候補INSERTを1000件ごとに分割し、すべて既存の投稿DELETEと同一transaction内でawaitする。後続batchが失敗した場合は先行候補INSERTと投稿DELETEをまとめてrollbackする。削除条件、RETURNING限定、重複候補のorIgnoreは維持する。
- 実DBで65536個のDrive IDsを持つ削除RETURNING集合を用意し、全65536候補が保存され投稿が削除される境界テストを追加。さらに先行batch成功後だけ例外を出すstatement triggerで2batch目を失敗させ、候補0件と投稿残存を確認した。入力は巨大RETURNING集合に焦点を当てたDB fixtureで、APIの1投稿添付上限を変更するものではない。
- CleanRemoteNotesProcessorService全42件成功（`/tmp/issue18-bind-boundary.log`）。backend全lint/typecheck成功（`/tmp/issue18-bind-lint.log`）、変更src/test eslintはerror 0（既存同様のwarningあり、`/tmp/issue18-bind-eslint.log`）。製品schema/API定義変更なし、migration/SDK生成は不要。
