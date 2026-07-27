# yado v1 設計書(実装指示書)

設計は確定済み。実装はこの文書に忠実に行うこと。用語はCONTEXT.md、判断の背景はdocs/adr/を参照。

## 背景

Claude Code / Codexでの開発は複数セッションが同時に`dev server`を起動するため、localhost:3000の衝突、エージェントがユーザーのプロセスをkillする事故、「どのポートがどの作業か分からない」問題が常態化している。yadoは空きポートの自動割当と`<名前>.local`によるmDNS名前アクセスでこれを解消する。macOS専用、HTTP-only、sudoゼロ(ADR-0001)。人間もエージェントも同じCLIを使う(ADR-0002)。素の`bun run dev`も自動チェックインで救う(ADR-0003)。

技術的な土台は実機検証済み: macOSではuid=501のままポート80をbindでき、`dns-sd -P <name> _http._tcp local 80 <name>.local <IP>`で登録した名前はMac自身からも解決できる。

## リポジトリ構成と担当分界

```
yado/
├── SKILL.md          # オーケストレーター担当。触らない
├── README.md ほか     # オーケストレーター担当。触らない(docs/, CONTEXT.md, LICENSE, assets/も)
├── bin/yado          # bashシム: exec bun "<自身の隣>/../src/cli.ts" "$@"
├── package.json      # name: yado, bin: {yado: "./bin/yado"}, devDeps: @types/bun, typescript
├── tsconfig.json
├── src/
│   ├── cli.ts        # エントリポイント・サブコマンド分岐
│   ├── daemon.ts     # デーモン本体(プロキシ+mDNS監督+スキャナ+制御API)
│   ├── proxy.ts      # HTTP/WSプロキシ
│   ├── mdns.ts       # dns-sd子プロセス管理
│   ├── scan.ts       # 自動チェックインスキャナ
│   ├── registry.ts   # 台帳の型とストア(書き込みはデーモンのみ)
│   ├── detect.ts     # パッケージマネージャ/devスクリプト/フレームワーク検出
│   └── util.ts
├── scripts/smoke.sh  # 結合スモークテスト
└── tests/            # bun test(純粋ロジックのユニットテスト)
```

状態はすべて `~/.local/state/yado/` に置く: `registry.json`(台帳)、`daemon.sock`(unixソケット)、`daemon.pid`、`daemon.log`、`logs/<name>.log`、`config.json`。

## 台帳(registry)

```ts
type Guest = {
  name: string;            // "morimiru" (.localは付けない)
  port: number;
  pid: number;
  pgid: number | null;     // 自動チェックインでは不明な場合null
  path: string;            // 作業ディレクトリ絶対パス
  cmd: string;             // 表示用コマンド文字列
  kind: "managed" | "auto";
  owner: { tty: string | null; label: string }; // label例: "terminal" | "agent"
  startedAt: string;       // ISO8601
  logFile: string | null;  // managedのみ
};
```

**書き込みはデーモンのみ**(単一ライターにしてロック不要にする)。CLIはunixソケットの制御APIを介して読み書きする。デーモン起動時に台帳を読み、pidが死んでいるエントリを掃除する。

## デーモン

- 多重起動防止: `daemon.pid`+ソケットへのヘルスチェックで判定。CLIはデーモン不在なら`node:child_process`の`spawn(detached: true, stdio: "ignore")`で`bun src/daemon.ts run`を起動して切り離す。
- 制御API(unixソケット、`Bun.serve({unix})`): `GET /health`, `GET /guests`, `POST /allocate`(空きポート採番と名前予約をアトミックに行う), `POST /guests`(登録), `PATCH /guests/:name`(ポート実測値の訂正), `DELETE /guests/:name`。
- ポート80が取れない場合は原因プロセスを`lsof -nP -iTCP:80 -sTCP:LISTEN`で調べてエラーメッセージに含め、終了する。

### プロキシ(port 80)

- Hostヘッダから`<name>.local`の`name`を引き(ポート部除去、大文字小文字無視)、台帳のGuestへ`http://127.0.0.1:<port>`で中継する。
- HTTP: method/headers/bodyをストリームで転送。hop-by-hopヘッダ(connection, keep-alive, transfer-encoding, upgrade等)は除去し、`X-Forwarded-For`/`X-Forwarded-Host`/`X-Forwarded-Proto: http`を付与。リダイレクトは追わずそのまま返す(`redirect: "manual"`)。
- **ループバックの両ファミリー対応**: Guestは`127.0.0.1`ではなく`::1`だけで待ち受けることがある(実機で確認: Vite 8はhost未指定だと[::1]のみにbindする場合がある)。上流への接続(HTTP fetch/WebSocket)とHTTPプローブは両ファミリーを試行し、どちらで応答したかをGuestごとにメモリ内キャッシュする。接続拒否時はもう一方へフォールバックする。台帳スキーマは変えない。
- WebSocket: Upgrade要求は`server.upgrade()`で受け、バックエンドへ`new WebSocket("ws://127.0.0.1:<port><path>", protocols)`を張り、両方向にmessage/close/errorを中継する。HMRが通ることが受け入れ条件。
- 未知のHost: 404で現在のGuest一覧(リンク付き)を返す。
- `yado.local`はデーモン自身が名乗り、Guest一覧のステータスページ(素のHTML、外部アセットなし)を返す。

### mDNS広告(dns-sd監督)

- Guestごとに`dns-sd -P <name> _http._tcp local 80 <name>.local <IP>`を子プロセスとして起動し、異常終了したら再起動する。チェックアウトで該当子プロセスをkillする。`yado.local`も同様に広告する。
- 広告IP: デフォルトルートのインターフェース(`route -n get default`)のIPv4(`ipconfig getifaddr`)。それが無い/リンクローカル(169.254._)/CLAT46(192.0.0._)の場合はIPv6 GUAで広告する(dns-sdはIPv6アドレスも受け付ける)。
- 15秒間隔でIPを再確認し、変わっていたら全子プロセスを再起動する。

### 自動チェックインスキャナ

- 3秒間隔: `lsof -nP -iTCP -sTCP:LISTEN`をパースし、(pid, port)を列挙。既知Guest・デーモン自身・1024未満のポートを除外。
- 候補のcwdを`lsof -a -p <pid> -d cwd -Fn`で取得し、`config.json`の`scanRoots`(デフォルト`["~/Documents/GitHub"]`)配下のみ対象。
- HTTPプローブ: `GET /`を400msタイムアウトで投げ、HTTPレスポンスが返れば(ステータス不問)Web系Guestとみなす。同一pidが複数LISTENしている場合はプローブに応答した最小ポートを採用する。
- チェックイン: 名前は`basename(cwd)`を正規化(小文字化、`[a-z0-9-]`以外を`-`に)。owner.ttyは`ps -o tty= -p <pid>`。kind: "auto"。
- 通知(両方出す): (1) ownerのttyが実在すれば`/dev/<tty>`に`\nyado ▸ http://<name>.local/ (auto check-in)\n`を書き込む。(2) `osascript -e 'display notification ...'`。
- Guestのpidが消えたら自動チェックアウト(台帳から削除、dns-sd停止)。

## 名前規約(決定済み)

- 基本は`basename(cwd)`の正規化。`--name <n>`で上書き。
- 同一pathのGuestが既に生きていれば二重起動せず、そのURLを表示して終了(exit 0)。
- 別pathで名前衝突したら`-2`, `-3`と連番を付ける。

## CLI

### `yado [--name <n>] [-- <cmd...>]`

1. デーモンを保証(不在なら起動して`/health`をポーリング)。
2. 起動コマンド決定: `--`があればそれ。なければpackage.jsonの`dev`スクリプト(無ければ`start`、それも無ければエラー)。パッケージマネージャはロックファイルで判定: `bun.lock`/`bun.lockb`→bun、`pnpm-lock.yaml`→pnpm、`yarn.lock`→yarn、`package-lock.json`→npm、いずれも無ければbun。
3. `/allocate`で名前とポートを予約。
4. 起動: `spawn(detached: true)`で新プロセスグループ、env に`PORT=<port>`。vite/astro系(devDependenciesまたはスクリプト文字列で判定)は引数でもポートを渡す: npm/pnpm/yarnは`run dev -- --port <port>`、bunは`run dev --port <port>`。
5. stdout/stderrをターミナルと`logs/<name>.log`の両方へtee。開始時にバナー`yado ▸ http://<name>.local → :<port>`を出す。
6. ポート実測: 起動後20秒まで、プロセスグループ内のLISTENを`lsof`で確認。割当と違うポートで立っていたら`PATCH`で台帳を訂正する(フレームワークがPORTを無視しても名前は正しく振れる)。20秒以内にLISTENしなければ警告(プロセスは生かす)。子が即死したらチェックアウトして同じexit codeで終了。
7. SIGINT/SIGTERMをプロセスグループへ転送。子の終了でチェックアウトして同code終了。

### `yado stop [name] [--force]`

- name省略時はcwdのGuest。
- Owner照合: 呼び出し元のtty(`ps -o tty= -p $$`相当)と台帳のowner.ttyを比較。不一致かつ`--force`なしなら停止せず、exit 3で「他人のGuestです。ユーザーに確認してから`--force`を使ってください」という定型メッセージを出す(SKILL.mdがこのexit codeを扱う)。
- 停止: pgidがあれば`kill -TERM -<pgid>`、5秒待ってから残っていれば`kill -KILL`。kind: "auto"でpgid不明ならpidへ送る。完了後デーモンへ`DELETE`。

### `yado ls [--json]`

台帳をテーブル表示: NAME, URL, PORT, OWNER, KIND, UPTIME。`--json`は台帳をそのまま出す(エージェント用)。

### `yado daemon <run|status|stop>`(補助)

runはフォアグラウンド実行(デバッグ用)。statusはヘルス表示。stopはデーモンと全dns-sd子プロセスを終了する(Guestは殺さない)。

## エラーとエッジ

- macOS以外/`dns-sd`不在: 「yado v1 is macOS-only」と明言して終了。
- 名前解決の初回遅延: dns-sd登録直後は数百msかかることがある。バナー表示前に自己解決を待たない(表示だけ先行してよい)。
- ログファイルは起動ごとにtruncate。冒頭にタイムスタンプとコマンドを書く。

## 品質要件

- 純粋ロジック(名前正規化・連番、PM/フレームワーク判定、lsof出力パース、Host→Guest解決)は`bun test`のユニットテストを書く。
- `scripts/smoke.sh`: デーモン起動→ダミーHTTPサーバーをyado経由起動→`curl http://<name>.local/`成功→`yado ls`に載る→`yado stop`→台帳から消える、までを自動確認。
- 検証コマンド: `bunx tsc --noEmit` と `bun test` と `bash scripts/smoke.sh` がすべて通ること。
- 依存は`@types/bun`とtypescript(devDependencies)のみ。ランタイム依存ゼロ。
- コミットはしない(レビュー後にオーケストレーターが行う)。
