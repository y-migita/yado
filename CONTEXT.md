# yado

ローカル開発サーバーに空きポートを自動で割り当て、`<名前>.local` としてmDNSで広告することで、ポート衝突と「localhost:3000どれだっけ」問題をなくすツール。人間もコーディングエージェント(Claude Code / Codex)も同じ入口を使うことで干渉を構造的に解消する。

## Language

**Guest(ゲスト)**:
yadoの台帳に載っている開発サーバープロセス。yado経由で起動したものと、自動チェックインで拾われたものの2種類がある。
_Avoid_: app, server, process

**Check-in(チェックイン)**:
Guestを台帳に登録し、名前をmDNSで広告するまでの一連の手続き。yado経由起動では空きポート割当とログのteeも含む。
_Avoid_: register, start

**Auto check-in(自動チェックイン)**:
yadoを経由せず起動された開発サーバーを、デーモンがLISTENポートのスキャンで発見して台帳に載せること。名前とプロキシ経由アクセスのみ提供され、ポート割当とログteeは付かない。
_Avoid_: adoption, discovery

**Check-out(チェックアウト)**:
Guestの行儀よい停止。台帳と実プロセスの一致を確認した上でプロセスグループにSIGTERMを送り、名前の広告をやめ、台帳から外す。
_Avoid_: kill, stop(生のシグナル送信の意味で)

**Registry(台帳)**:
yadoが管理する開発サーバーの記録。名前、ポート、プロセスグループ、Owner、作業ディレクトリ、ログファイルの場所を持つ。
_Avoid_: state file, database

**Owner(所有者)**:
その開発サーバーを起動した主体。人間のターミナルか、特定のエージェントセッションか。停止・再起動の権限判断の基準になる。
_Avoid_: user, creator
