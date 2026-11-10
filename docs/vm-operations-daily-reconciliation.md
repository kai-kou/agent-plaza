# boot 完備・誤 kill／未帰属・欠落の日次突合手順（段階 0・#60）

段階 0「mugi 環境での安定稼働確認（展開ゲート）」のゲート条件 3・4・5 の判定手順を、日次で再現できるチェック手順として固定する文書である。単位 AP-R0-3（#60 コメント 6734185202）で作成した。

## 正本の位置づけ

- ゲート条件そのものの正本は #60 本文と `docs/vm-operations-rollout.md` 段階 0 である。本書は条件を変更しない。条件の解釈を変える場合は本書ではなく正本側の手続きによる。
- 日次の判定結果の正本は #60 への転記コメントとする。手元ファイル `~/workspace/research-vm-resilience/stability-log.md`（日次 cron `vm-ops-stability-daily` が追記する）は正本の写しと位置づける。判定表の型は `docs/vm-operations-gate-decision-table.md`（AP-R0-2）に固定済みであり、本書はその条件 3・4・5 列の入力手順を定める。
- 「連日」の数値定義は正本にない（AP-R0-2 文書の「「連日」について」を参照）。本書では解釈を確定しない。

## 入力ファイルと役割

| 入力 | パス | 役割 | 保持・窓の注意 |
|---|---|---|---|
| boot 履歴 | `~/workspace/agent-plaza/bridge/boot-history.jsonl` | 全 boot の記録。1 行 1 boot（`boot_id`・`boot_time_iso`・`first_seen_iso`）。条件 3 の主入力。 | 追記型。観測開始（2026-11-08）以降の行だけを数える。行数は当日分を含め記録時点の値を、確認時刻とともに書く。 |
| 現行 boot_id | `/proc/sys/kernel/random/boot_id` | 現在稼働中の boot の識別子。条件 3 の照合入力。 | カーネルが返す UUID 全文。短縮表記は先頭 8 文字（下記「識別子の表記」を参照）。 |
| リスナー起動記録 | `~/workspace/agent-plaza/bridge/socket-listener.log` | `A new session has been established` 行。boot 直後のセッション確立時刻。無人復旧の第一の証拠。 | 追記型。行頭の日時（UTC）で読む。 |
| heartbeat 現在値 | `~/workspace/agent-plaza/bridge/socket-heartbeat.json` | `is_connected`・`session_id`・`at`。リスナーの接続中を示す現在値。 | 現在値のみで履歴を持たない。鮮度の判定は `readiness_check.py` の heartbeat 鮮度チェック（60 秒以内）に拠る。 |
| スーパーバイザ poll ログ | `~/hooks/logs/agent-plaza-socket-supervisor.jsonl` | 5 秒ごとの poll 行（`outcome`・`reason`・`error`）。停止・kill・起動の判定入力。条件 4 の主入力。 | 保持は約 8 時間分（2026-11-10 時点で 5868 行・06:21:28Z〜14:31:08Z）。窓の外の事象は本ログでは確認できない（下記「保持窓の扱い」を参照）。 |
| 進捗ドライブ状態ファイル | `~/workspace/goals/agent-doorbell-mcp-implementation-and-dogfooding/hidden_files/progress-drive-state.json` の `d1_snapshot` | D1 突合の当日値。条件 5 の入力。 | 毎時の進捗ドライブが更新する。`checked_at_jst` を確認時刻として使う。 |
| 安定稼働ログ | `~/workspace/research-vm-resilience/stability-log.md` | 日次行。条件 3・4 の既記録値と、保持窓外の事象の記録。 | 写し。数値は逐語で使い、書き換えない。 |

## 識別子の表記

- boot の識別子は UUID 全文を正とする。短縮表記は先頭 8 文字とする（例：`a80d2dc3` は `a80d2dc3-dc0e-4d52-bbd1-3db61b4c343a` の先頭 8 文字）。
- 照合は全文同士、または短縮表記と全文の先頭 8 文字で行う。先頭 8 文字が history 内の 1 行にだけ一致することを確認する。短縮表記同士の一致だけでは照合としない。
- stability-log.md の行に短縮表記だけが書かれている場合は、history から全文を引き、全文を併記して記録する。

## 条件 3：boot 履歴の完備確認手順

ゲート条件 3 は「実再起動が 3 回以上発生し、全て無人復旧する（boot 履歴に全 boot の記録が揃う）」である。

1. `boot-history.jsonl` の行数を数える。`boot_time_iso` の日付（UTC）ごとに集計し、日別件数と、観測開始（2026-11-08）以降の累計を出す。確認時刻（JST）を併記する。累計は「観測開始日以降の UTC 日の合計」と定義し、当日分は未確定（進行中）であることを明記する。
2. 現行 boot の一致を確認する。`/proc/sys/kernel/random/boot_id` の全文が history の最新行の `boot_id` と一致することを確認する。一致しない場合は、最新行より後に再起動があったか、history フックが動いていないかのどちらかであり、完備ではない。原因を切り分けるまで「完備」としない。
3. 無人復旧を boot ごとに確認する。各 boot について、`boot_time_iso` の直後に `socket-listener.log` のセッション確立行があることを確認する。復旧の基準は、boot から 600 秒以内にセッションが確立することとする（実績は 30〜50 秒）。600 秒を超えた boot があれば、その boot は無人復旧の証拠なしとして記録し、原因を切り分ける。
4. スーパーバイザ側の起動記録を第二の証拠として確認する。boot 直後の poll 行に `listener launched` または `listener running` があり、heartbeat が新鮮であることを確認する。セッション確立行と poll 行の両方が揃わない boot は、片方だけでは復旧としない。
5. 結果を判定表の条件 3 列へ書く。累計件数・当日件数・確認時刻・現行 boot（全文または短縮表記＋全文への参照）を書く。無人復旧の証拠が揃わなかった boot があれば、その boot_id と不足している証拠を明記する。

### 実施記録（2026-11-09 時点の実データ）

- 確認時刻：2026-11-10 23:30 JST。history は 33 行。日別（UTC）は 11-08 が 14 件、11-09 が 12 件、11-10 が 7 件（当日分、進行中）。累計は 33 件で、11-10 行の記録時点の 26 件からの増加 7 件は 11-10 分である（26+7=33）。
- 2026-11-09（UTC）の 12 boot は全て、boot から 30〜50 秒以内にセッションが確立しており、12/12 が 600 秒以内の無人復旧である。2026-11-10（UTC）の 7 boot も全て 35〜47 秒以内にセッションが確立しており、7/7 が無人復旧である。
- 現行 boot は `961066f5-066b-4e31-8510-dd89e1c605b7`（boot_time 2026-11-10T13:05:00Z）で、カーネルの現行 boot_id と完全一致した。セッションは 13:05:42Z に確立（42 秒後）、heartbeat は 23:29:43 JST 時点で同 session id で接続中であった。
- 前提検証時の気づきの解決：history 33 行と stability-log.md の「2026-11-08 以降 26 件」の差は、11-10 行の記録後に 7 件の再起動があったためであり、観測開始前の boot が混ざっているわけではない（先頭行は 2026-11-08T03:58:22Z）。短縮表記 `a80d2dc3` は history 内の `a80d2dc3-dc0e-4d52-bbd1-3db61b4c343a`（boot 2026-11-09T22:37:31Z）の先頭 8 文字であり、同一性の照合方法は先頭 8 文字で確定した。

## 条件 4：停止イベントの帰属表

ゲート条件 4 は「誤 kill が 0 件、帰属できないリスナー停止が 0 件」である。

### 停止イベントの定義

- リスナー停止とは、heartbeat が stale 閾値を超えて途絶したこと、またはリスナープロセスが終了したことをいう。readiness の heartbeat 鮮度チェックは 60 秒以内、スーパーバイザの stale 閾値は 45 秒である。
- セッションの再確立だけでは停止としない（SDK の接続 rotation による再確立は、heartbeat の途絶を伴わない限り停止に数えない）。

### 帰属先の区分

| 帰属先 | 意味 | 証拠 |
|---|---|---|
| 再起動 | VM・ランタイムの再起動に伴う停止。boot 履歴の行が対応する。 | boot-history.jsonl の行と、直後のセッション確立行 |
| SDK rotation | Slack SDK の接続 rotation による再接続。 | リスナー起動記録のセッション再確立行（boot の対応なし） |
| 意図的操作 | 検証 kill、フックの disable／enable、手動の再起動など、記録のある操作。 | 操作の記録（Issue・スレッド・ログ）。記録のない操作はここに入れない |
| executor draining | hook の起動が executor の draining で拒否されたもの。自動で回復する。 | スーパーバイザ poll ログの `failed` 行（error に `subprocess executor is draining`）と、直後の `listener launched` 行 |
| 誤 kill | スーパーバイザが稼働中のリスナーを kill したもの（2026-11-07 夜の誤検知が既知の例）。 | スーパーバイザ poll ログの kill 行。kill があった場合は、対象プロセスが稼働中だったかを起動時刻と heartbeat で確認する |
| 未帰属 | 上記のいずれにも帰属できない停止。 | 帰属できない理由と、確認した範囲を書く。0 件としない |

### 手順

1. スーパーバイザ poll ログの保持窓を確認する。先頭行と最終行の時刻を読み、窓（2026-11-10 時点で約 8 時間）を記録する。窓の外の事象は本ログでは確認できない。
2. 窓内の `outcome` が `silent` でない行を全件列挙する。各行を上の区分へ振り分ける。`failed` 行は error の文面で区分する（draining は error に `subprocess executor is draining` と出る）。
3. kill に関わる行がないか、reason・stdout に `kill` を含む行を検索する。kill 行があれば、対象が稼働中のリスナーだったかを起動時刻と heartbeat で確認し、誤 kill かどうかを判定する。
4. 保持窓の外の事象は、stability-log.md の当日行の記録を入力とする。ただしその場合は「保持窓外のため stability-log.md の行を記録として用いた」ことを明記し、スーパーバイザ poll ログでの再確認はできていないことを留保する。
5. 結果を帰属表として記録する。誤 kill 件数／未帰属停止件数を「0／0」の形で書き、停止イベントがあった場合は帰属先と回復までの時間を併記する。帰属できないものは「未帰属」として残し、0 件としない。判定表の条件 4 列へは当日分を転記する。

### 保持窓の扱い

- スーパーバイザ poll ログは 5 秒間隔の poll 行を蓄積するため、保持は約 8 時間分にとどまる（2026-11-10 時点）。1 日分の確認には窓が足りない。窓の外の事象は stability-log.md の当日行を記録として用い、その旨を明記する。
- 保持窓が 1 日分に満たないことは、手順の限界として記録する。保持の延長が必要と判明したら別単位に切り出す（本単位には含めない）。

### 実施記録（2026-11-10 当日分）

- 確認時刻：2026-11-10 23:31 JST（ログ最終行 14:31:08Z）。スーパーバイザ poll ログの窓は 2026-11-10 06:21:28Z〜14:31:08Z（15:21 JST〜23:31 JST）で、5868 行、poll 間隔の途絶（60 秒超）は 0 件であった。
- 窓内の非 silent 行は 1 件：10:56:15Z（19:56:15 JST）の `failed` 行（error：`subprocess executor is draining; rejecting new subprocess start`）。帰属先は executor draining。直後の poll は 10:56:28Z に `listener launched`、10:56:34Z に `listener running; heartbeat 1s old` で、13 秒後に起動成功して回復した。対応する boot は `9b117c88`（10:55:52Z）で、セッションは 10:56:32Z に確立（40 秒後）しており、無人復旧である。
- 窓外の事象：07:37:52 JST の executor draining による hook 失敗 1 件（supervisor 1 件、13 秒後に起動成功）。保持窓の外のため、記録として stability-log.md の 11-10 行と AP-R0-2 文書の帰属を用いた。スーパーバイザ poll ログでの再確認はできていない。
- kill に関わる行は窓内に 0 件であった。stability-log.md の 11-10 行にも stale kill の記録はない。
- 当日分の帰属表：誤 kill 0 件、未帰属停止 0 件。停止イベントは executor draining 2 件（07:37:52 JST・19:56:15 JST）で、いずれも帰属済み・自動回復済みである。

## 条件 5：欠落判定の入力指定

ゲート条件 5 は「イベント欠落が 0 件」である。欠落の判定は進捗ドライブ側の三者突合（ハブ観測・event log・delivery の ack 状態）の結果を取り込む。stability-log.md にはこの列の入力がないため、進捗ドライブの状態ファイルを入力とする。

### 見る状態値

進捗ドライブの状態ファイル `progress-drive-state.json` の `d1_snapshot` から、次の値を読む。

| 値 | 意味 | 確認すること |
|---|---|---|
| `checked_at_jst` | 突合の確認時刻 | 当日分の値であること（日付が当日であること） |
| `events_count`・`max_seq` | D1 のイベント総数と最大 seq | `events_count = max_seq` で gapless であること（`gapless` の記述も読む） |
| `deliveries_count`・`deliveries_by_state` | delivery 総数と状態別内訳（`queued`・`receipt-acknowledged`・`attempting`） | 恒等式 `deliveries = ack + queued + attempting + 隔離` が成立すること（`identity` の記述も読む） |
| `mugi_unacked` | mugi 購読の未 ack 件数 | 0 件であること。`ack = 全イベント` の記述も読む |
| `quarantine.count` | 隔離中の件数 | 0 件であること |
| `new_event` | 前回確認以降の新規イベントと差分・重複・無言消失の有無 | 差分 0・重複 0・無言消失なしであること |

### 手順

1. `d1_snapshot` の `checked_at_jst` が当日であることを確認する。当日でない場合は、その値を当日分として使わず、前回確認以降の値であることを明記するか、進捗ドライブの次回確認を待つ。
2. 上の値を読み、恒等式と gapless が成立していることを確認する。成立していない場合は、欠落の有無を判定せず「未確認」として記録し、進捗ドライブ側の切り分けを待つ。
3. 結果を判定表の条件 5 列へ書く。mugi 未 ack 件数と隔離中件数を書き、異常がなければ「異常なし」と書く。数値は `d1_snapshot` の値を逐語で使う。

### 実施記録（2026-11-10 当日分）

- 確認時刻：2026-11-10 22:46 JST（`d1_snapshot.checked_at_jst`）。events 1214・max_seq 1214 で gapless。deliveries 5058 = ack 2429 + queued 2629 + attempting 0 + 隔離 0 で恒等式が成立。mugi 未 ack 0 件（ack 1214 = 全イベント）。隔離中 0 件。新規 10 イベント（seq 1205〜1214）は差分 0・重複 0・無言消失なし。
- 条件 5 は異常なしである。

## 含まないもの

- 新しい監視の実装（保持窓の延長を含む。必要と判明したら別単位に切り出す）
- ゲート条件の変更・ゲート充足の最終判定
- ゲート 2 本体（ブリッジ無効化・Events API・Tier 再相談）
