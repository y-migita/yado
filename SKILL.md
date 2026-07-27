---
name: yado
description: >-
  Start and manage local dev servers with automatic free-port allocation and
  <name>.local mDNS domains reachable from other devices on the same Wi-Fi.
  Use whenever you need to start a dev server (bun/npm/pnpm run dev), hit
  EADDRINUSE or "port 3000 is in use", want to know which dev server is already
  running, need to verify a web app in a browser, or the user wants to open the
  app from a phone. macOS only.
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/bin/yado *)
---

# yado — dev servers without port fights

yado allocates a free port, starts the dev server, and advertises
`http://<name>.local/` over mDNS, so the app is reachable by name from this Mac
and from phones on the same Wi-Fi. A daemon proxies the name to the right port;
the URL stays stable even when the port changes across restarts. A ledger
records who started what, so agent sessions and the human user never fight
over ports or kill each other's processes.

`<name>` is the project directory basename (sanitized). A second instance
started from a different path gets a `-2` suffix.

## Rules

1. **Never start a dev server directly** (`bun run dev`, `npm run dev`,
   `next dev`, ...). Always start it through yado from the project directory.
   Run it as a background task; within that task, the command stays in the
   foreground and streams output like a normal dev server:

   ```
   ${CLAUDE_SKILL_DIR}/bin/yado            # auto-detects package manager + dev script
   ${CLAUDE_SKILL_DIR}/bin/yado -- <cmd>   # explicit command when auto-detection is wrong
   ```

   The startup banner prints the URL and the log file path.

2. **Check the ledger before starting**:
   `${CLAUDE_SKILL_DIR}/bin/yado ls --json`. If a guest for the current
   directory already exists, do not start another one — hot reload means it
   already serves the latest code. Verify the app at its `http://<name>.local/`
   URL instead.

3. **Verify via the `.local` URL**, not `localhost:<port>`. Ports can change;
   names do not.

4. **Logs**: use the `logFile` path from `ls --json`. Guests that were
   checked in automatically (started without yado) have no log file — if
   you need logs, propose restarting through yado instead of guessing.

5. **Stopping**: `${CLAUDE_SKILL_DIR}/bin/yado stop [name]`. Exit code 3 means
   the guest was started elsewhere — usually from the user's own terminal. Ask
   the user for permission first, then retry with `--force`. This also applies
   to restarts after `.env` or config changes.

## Never

- Never kill dev-server processes with `kill`, `pkill`, or `lsof | kill`, and
  never free a busy port by killing whatever is listening on it. Use
  `yado stop`, which verifies ownership and terminates the whole process group.
- Never start a duplicate server in a directory that already has a running
  guest.
