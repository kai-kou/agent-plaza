# Socket Mode リスナー キット（参照実装）

agent-plaza の VM 交換前提の運用方式（`docs/vm-resilient-operations.md`）の参照実装。Slack の Socket Mode で投稿を常駐受信し、ドアベル本体の ingress へ転送する。導入手順は `docs/socket-mode-listener.md`、方式の正本は `docs/vm-resilient-operations.md` を参照。

## 構成

| ファイル | 役割 |
|---|---|
| `socket_mode_listener.py` | Socket Mode 受信 → envelope 即 ack → 対象チャンネルの message のみ ingress へ転送。heartbeat（30 秒）と診断ログをホーム配下へ書く。接続断 45 秒継続で自己終了（ウォッチドッグ） |
| `test_socket_mode_listener.py` | 単体テスト（安定 ID 規則、対象フィルタ、seen 記録、再試行、dry-run） |
| `start-listener.sh` | 起動ランチャ。flock（保持者＝リスナー自身）で単一性を保ち、0600 の env ファイルからトークンを読む。プロキシは呼び出し元環境から継承する |
| `hooks/agent-plaza-socket-supervisor.sh` / `.json` | スーパーバイザフック（poll 5 秒）。未起動なら起動、凍結は heartbeat 鮮度＋プロセス起動時刻で判定して kill＋起床 |
| `hooks/vm-boot-history.sh` / `.json` | boot 履歴フック（poll 60 秒）。boot_id と btime をホーム配下の JSONL へ追記 |
| `measure_wake_latency.py` | 起床遅延（投稿→起床）の計測。観測行と起床フックのログから集計する |
| `readiness_check.py` | 稼働状態の一括確認（boot 履歴、スーパーバイザ有効、リスナーの生存・接続・heartbeat 鮮度、env 権限、閾値とガードの構成、起床遅延） |
| `agent-plaza-socket-listener.system.service` | systemd フォールバック用テンプレート（通常の起動経路ではない。`<home>` を自分のホームへ置換して使う） |

## 設定（環境変数）

実値は 0600 の env ファイル（例：`~/.config/agent-plaza/env`）に置き、リポジトリ・ログ・チャットへ書かない。

| 変数 | 必須 | 内容 |
|---|---|---|
| `SLACK_APP_TOKEN` | 必須 | Slack アプリの App-Level Token（xapp、connections:write） |
| `SLACK_BOT_TOKEN` | 必須 | Bot User OAuth Token（xoxb） |
| `TARGET_CHANNEL_ID` | 必須 | 転送対象のチャンネル ID。既定値はない |
| `WORKER_BASE` | 必須 | ドアベル本体のベース URL。既定値はない（env または配備情報ファイルから読む） |
| `PRODUCER_TOKEN` | 必須 | ingress の producer トークン（env または配備情報ファイルから読む） |
| `AGENT_PLAZA_DRY_RUN` | 任意 | `1` で接続と ack のみ行い転送しない（検証用） |
| `AGENT_PLAZA_OBS_LOG` / `AGENT_PLAZA_DIAG_LOG` / `AGENT_PLAZA_SDK_LOG` / `AGENT_PLAZA_HEARTBEAT_FILE` / `AGENT_PLAZA_PIDFILE` | 任意 | 各ログ・状態ファイルの配置先の上書き |

配備情報ファイル（deploy.env）の既定の場所は `~/workspace/agent-doorbell-mcp/hidden/deploy.env`、観測ログの既定は `~/workspace/agent-doorbell-mcp/hidden/bridge-state/observations.jsonl`、リスナーの状態ファイルの既定は `~/workspace/agent-plaza/bridge/` 配下。自分の配置に合わせて上書きするか、配置を既定に合わせる。

## 前提とする配置

- リスナー一式はホーム配下の 1 ディレクトリ（例：`~/workspace/agent-plaza/bridge/`）に置き、その中に `.venv`（slack_sdk 入り）を用意する。`start-listener.sh` は自ディレクトリを基準に動作する。
- フックのスクリプトは `~/hooks/scripts/`、定義は `~/hooks/definitions/` へ配置する（定義 JSON の prompt は自環境に合わせて書き換える）。
- systemd は使わない（ユーザーバスが無く、/etc は VM 交換で消えるため）。常駐化はスーパーバイザフックが担う。

## テスト

```
.venv/bin/python -m unittest test_socket_mode_listener
```

全件通過が導入の前提。フィクスチャは実 payload の形（envelope 種別と payload の type の違いを含む）から取ること。過去に、フィクスチャ側の誤った前提が実装のフィルタ不具合を隠した事例がある。
