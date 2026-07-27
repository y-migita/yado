# v1はHTTP-only、macOS専用(dns-sd方式)とする

対象ユースケースは「自宅/事務所の信頼できるWi-Fiでのスマホ実機確認」であり、外部公開はスコープ外。この前提ではTLS(ローカルCA生成、信頼ストア登録、スマホへのプロファイル導入)を丸ごと省略でき、HTTPで足りる。VRでのsecure context要件はadb reverse(Quest側でlocalhost扱いになる)で別途カバーできるため、TLSを積む理由にならない。

mDNS広告はJSでマルチキャストを扱わず、macOS標準の`dns-sd -P`を子プロセスとして起動する方式を採る。OS本体のmDNSResponderに登録されるためMac自身も同じ名前を解決でき、/etc/hostsの書き換えが不要になり、sudoが完全にゼロになる。macOSはMojave以降1024未満のポートのbindに特権が不要なので、ポート80の取得にもsudoは要らない。

## Considered Options

- HTTPS込み: localias相当のローカルCA運用が必要になり、初版のセットアップが一気に重くなるため先送り
- Linux対応(multicast-dns系の純JS実装): Bun 1.2のnode:dgram+addMembershipで技術的には可能だが、mDNSResponderとの5353同居やインターフェース選択の検証コストが高いため先送り。差し替え可能な構造にはしておく
