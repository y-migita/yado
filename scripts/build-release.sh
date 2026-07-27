#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT_DIR/src/cli.ts"
DIST_DIR="$ROOT_DIR/dist"

if ! command -v bun >/dev/null 2>&1; then
  echo "[build-release] bun が必要です: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

build() {
  local target="$1"
  local asset="$2"
  echo "[build-release] $target -> dist/$asset"
  bun build --compile --target="$target" "$ENTRY" --outfile "$DIST_DIR/$asset"
}

build bun-darwin-arm64 yado-darwin-arm64
build bun-darwin-x64 yado-darwin-x64

(cd "$DIST_DIR" && shasum -a 256 yado-darwin-arm64 yado-darwin-x64 >checksums.txt)

echo "[build-release] dist/checksums.txt:"
cat "$DIST_DIR/checksums.txt"
