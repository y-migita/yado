#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
YADO="$ROOT_DIR/bin/yado"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/yado-smoke.XXXXXX")"
NAME="yado-smoke-$$"
PROJECT_DIR="$SMOKE_ROOT/smoke-project"
CLI_PID=""
PGID=""

mkdir -p "$PROJECT_DIR"
export YADO_STATE_DIR="$SMOKE_ROOT/state"
export NO_PROXY="*"
export no_proxy="*"

cleanup() {
  local cleanup_status=$?
  set +e
  if "$YADO" daemon status >/dev/null 2>&1; then
    "$YADO" stop "$NAME" --force >/dev/null 2>&1
    "$YADO" daemon stop >/dev/null 2>&1
  fi
  if [[ "$PGID" =~ ^[0-9]+$ ]] && kill -0 -- "-$PGID" 2>/dev/null; then
    kill -TERM -- "-$PGID" 2>/dev/null
    for _cleanup_attempt in $(seq 1 20); do
      kill -0 -- "-$PGID" 2>/dev/null || break
      sleep 0.05
    done
    kill -KILL -- "-$PGID" 2>/dev/null
  fi
  if [[ -n "$CLI_PID" ]]; then
    if kill -0 "$CLI_PID" 2>/dev/null; then
      kill -TERM "$CLI_PID" 2>/dev/null
      for _cleanup_attempt in $(seq 1 20); do
        kill -0 "$CLI_PID" 2>/dev/null || break
        sleep 0.05
      done
      kill -KILL "$CLI_PID" 2>/dev/null
    fi
    wait "$CLI_PID" >/dev/null 2>&1
  fi
  rm -rf -- "$SMOKE_ROOT"
  return "$cleanup_status"
}
trap cleanup EXIT

echo "[smoke] starting daemon"
"$YADO" ls --json >"$SMOKE_ROOT/initial-registry.json"
"$YADO" daemon status

echo "[smoke] starting managed Guest $NAME"
(
  cd "$PROJECT_DIR"
  "$YADO" --name "$NAME" -- bun "$ROOT_DIR/tests/fixtures/smoke-server.ts"
) >"$SMOKE_ROOT/yado.out" 2>&1 &
CLI_PID=$!

HTTP_BODY=""
for _attempt in $(seq 1 80); do
  if HTTP_BODY="$(
    curl --noproxy "*" --fail --silent --show-error \
      --connect-timeout 1 --max-time 2 "http://$NAME.local/" 2>/dev/null
  )" && [[ "$HTTP_BODY" == "smoke-ok" ]]; then
    break
  fi
  sleep 0.25
done
if [[ "$HTTP_BODY" != "smoke-ok" ]]; then
  echo "[smoke] HTTP through mDNS failed" >&2
  sed -n '1,160p' "$SMOKE_ROOT/yado.out" >&2
  exit 1
fi
echo "[smoke] HTTP via mDNS: $HTTP_BODY"

"$YADO" ls --json >"$SMOKE_ROOT/registry-live.json"
if ! grep -Fq "\"name\": \"$NAME\"" "$SMOKE_ROOT/registry-live.json"; then
  echo "[smoke] Guest missing from registry" >&2
  cat "$SMOKE_ROOT/registry-live.json" >&2
  exit 1
fi
PGID="$(
  bun -e '
    const guests = JSON.parse(await Bun.stdin.text());
    const guest = guests.find((candidate) => candidate.name === process.argv[1]);
    if (!guest?.pgid) process.exit(1);
    console.log(guest.pgid);
  ' "$NAME" <"$SMOKE_ROOT/registry-live.json"
)"
echo "[smoke] registry contains $NAME (pgid $PGID)"

bun "$ROOT_DIR/tests/fixtures/ws-client.ts" "ws://$NAME.local/ws"
# Bun 1.3.14のクライアントWebSocket close(code, reason)はreasonを送信しないため、
# frontend→backend方向はコードのみ検証する。
for _attempt in $(seq 1 20); do
  if grep -Fq "backend-close 4002" "$SMOKE_ROOT/yado.out"; then
    break
  fi
  sleep 0.1
done
if ! grep -Fq "backend-close 4002" "$SMOKE_ROOT/yado.out"; then
  echo "[smoke] frontend close was not observed by backend" >&2
  sed -n '1,200p' "$SMOKE_ROOT/yado.out" >&2
  exit 1
fi
echo "[smoke] WebSocket frontend/backend close propagation confirmed"

"$YADO" stop "$NAME"
set +e
wait "$CLI_PID"
CLI_STATUS=$?
set -e
CLI_PID=""
if [[ "$CLI_STATUS" -ne 0 && "$CLI_STATUS" -ne 143 ]]; then
  echo "[smoke] managed yado command exited unexpectedly: $CLI_STATUS" >&2
  exit 1
fi

if kill -0 -- "-$PGID" 2>/dev/null; then
  echo "[smoke] process group $PGID survived checkout" >&2
  exit 1
fi
echo "[smoke] managed process group stopped"

"$YADO" ls --json >"$SMOKE_ROOT/registry-stopped.json"
if grep -Fq "\"name\": \"$NAME\"" "$SMOKE_ROOT/registry-stopped.json"; then
  echo "[smoke] Guest remained in registry after checkout" >&2
  exit 1
fi
echo "[smoke] registry checkout confirmed"

"$YADO" daemon stop
echo "[smoke] PASS"
