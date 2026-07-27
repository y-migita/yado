#!/usr/bin/env bash
# curl -fsSL https://raw.githubusercontent.com/y-migita/yado/main/scripts/install.sh | bash
set -euo pipefail

INSTALL_DIR="$HOME/.local/bin"
TARGET="$INSTALL_DIR/yado"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "yado: yado v1 は macOS 専用です" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *)
    echo "yado: 未対応のアーキテクチャです: $(uname -m)" >&2
    exit 1
    ;;
esac

ASSET="yado-darwin-$ARCH"
URL="https://github.com/y-migita/yado/releases/latest/download/$ASSET"

mkdir -p "$INSTALL_DIR"
TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/yado-install.XXXXXX")"
trap 'rm -f "$TMP_FILE"' EXIT

echo "yado: $ASSET をダウンロードしています..."
if ! curl -fsSL "$URL" -o "$TMP_FILE"; then
  echo "yado: ダウンロードに失敗しました: $URL" >&2
  exit 1
fi

chmod +x "$TMP_FILE"
mv "$TMP_FILE" "$TARGET"
trap - EXIT

echo "yado: $TARGET にインストールしました"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "yado: $INSTALL_DIR が PATH にありません。シェル設定に次の行を追加してください:"
    echo '  export PATH="$HOME/.local/bin:$PATH"'
    ;;
esac
