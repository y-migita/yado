import { mkdirSync } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  assertSupportedPlatform,
  daemonHealth,
  runDaemon,
} from "./daemon";
import { resolveLaunchCommand } from "./detect";
import type { Guest } from "./registry";
import {
  listeningPortsForProcessGroup,
  probeHttpPort,
  processCwd,
  processTty,
} from "./scan";
import { STATE_PATHS, chooseMeasuredPort, sleep } from "./util";

const DAEMON_START_TIMEOUT_MS = 8_000;
const LISTEN_TIMEOUT_MS = 20_000;
const ALLOCATED_PORT_GRACE_MS = 5_000;
const DAEMON_SOURCE = Bun.fileURLToPath(new URL("./daemon.ts", import.meta.url));
const PROJECT_ROOT = dirname(dirname(DAEMON_SOURCE));
// A standalone binary produced by `bun build --compile` serves its sources from
// the virtual /$bunfs mount, so every module path resolves under it.
const IS_COMPILED_BINARY = Bun.main.includes("$bunfs");

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type LogSink = {
  write: (chunk: string | Uint8Array) => void;
  end: () => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A FileSink opens at offset 0 without truncating, so the caller must empty the
// log first to keep one file per launch.
function createLogSink(path: string): LogSink {
  const sink = Bun.file(path).writer();
  let failed = false;
  const fail = (error: unknown) => {
    failed = true;
    console.error(`yado: log write failed: ${errorMessage(error)}`);
  };

  return {
    write(chunk) {
      if (failed) {
        return;
      }
      try {
        sink.write(chunk);
        // Flush every chunk so `tail -f` on the log keeps up with the Guest.
        const flushed = sink.flush();
        if (typeof flushed !== "number") {
          void flushed.catch(fail);
        }
      } catch (error) {
        fail(error);
      }
    },
    async end() {
      if (failed) {
        return;
      }
      try {
        await sink.end();
      } catch (error) {
        fail(error);
      }
    },
  };
}

async function apiResponse(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    unix: STATE_PATHS.socketPath,
  });
}

async function apiJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await apiResponse(path, init);
  } catch (error) {
    throw new Error(`cannot reach yado daemon: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const value = (await response.json()) as { error?: unknown };
      if (typeof value.error === "string") {
        message = value.error;
      }
    } catch {
      // Keep the HTTP status when an error body is not JSON.
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

async function ensureDaemon(): Promise<void> {
  assertSupportedPlatform();
  if (await daemonHealth()) {
    return;
  }

  // The binary re-executes itself with the daemon subcommand because its
  // sources are not on disk; /$bunfs is also not a usable working directory.
  let daemon: Bun.Subprocess<"ignore", "ignore", "ignore">;
  try {
    daemon = Bun.spawn({
      cmd: [
        process.execPath,
        ...(IS_COMPILED_BINARY ? ["daemon", "run"] : [DAEMON_SOURCE, "run"]),
      ],
      cwd: IS_COMPILED_BINARY ? homedir() : PROJECT_ROOT,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: process.env,
    });
  } catch (error) {
    throw new Error(`cannot start yado daemon: ${errorMessage(error)}`);
  }
  daemon.unref();

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await daemonHealth()) {
      return;
    }
    await sleep(100);
  }

  let detail = "";
  try {
    const log = (await Bun.file(STATE_PATHS.daemonLogPath).text()).trim();
    detail = log ? `\n${log.split(/\r?\n/).slice(-8).join("\n")}` : "";
  } catch {
    // A missing daemon log is reported through the timeout itself.
  }
  throw new Error(`yado daemon did not become healthy${detail}`);
}

async function listGuests(): Promise<Guest[]> {
  return apiJson<Guest[]>("/guests");
}

function jsonInit(value: unknown, method: string): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

function inferOwnerLabel(): string {
  return [
    "CODEX_THREAD_ID",
    "CODEX_CI",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CURSOR_TRACE_ID",
  ].some((name) => process.env[name])
    ? "agent"
    : "terminal";
}

function processTargetAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

async function deleteGuest(name: string, expected: Guest): Promise<void> {
  const response = await apiResponse(
    `/guests/${encodeURIComponent(name)}`,
    jsonInit(
      {
        pid: expected.pid,
        pgid: expected.pgid,
        path: expected.path,
        startedAt: expected.startedAt,
      },
      "DELETE",
    ),
  );
  if (!response.ok && response.status !== 404) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") {
        detail = body.error;
      }
    } catch {
      // Keep the HTTP status.
    }
    throw new Error(`failed to check out ${name}: ${detail}`);
  }
}

async function cancelReservation(name: string, token: string): Promise<void> {
  const response = await apiResponse(
    `/guests/${encodeURIComponent(name)}`,
    jsonInit({ token }, "DELETE"),
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `failed to cancel reservation ${name}: HTTP ${response.status}`,
    );
  }
}

function parseMainInvocation(args: string[]): {
  requestedName: string | null;
  explicitArgv: string[] | null;
} {
  let requestedName: string | null = null;
  let index = 0;

  while (index < args.length) {
    const argument = args[index]!;
    if (argument === "--") {
      return { requestedName, explicitArgv: args.slice(index + 1) };
    }
    if (argument === "--name") {
      const name = args[index + 1];
      if (!name) {
        throw new Error("--name requires a value");
      }
      requestedName = name;
      index += 2;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return { requestedName, explicitArgv: null };
}

async function teeStream(
  stream: ReadableStream<Uint8Array>,
  out: NodeJS.WriteStream,
  log: () => LogSink | null,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      out.write(value);
      log()?.write(value);
    }
  } catch {
    // A broken pipe ends the tee; the child's exit is reported on its own.
  }
}

function exitCodeFor(result: ChildResult): number {
  if (result.code !== null) {
    return result.code;
  }
  if (result.signal) {
    const signalNumber =
      osConstants.signals[result.signal as keyof typeof osConstants.signals];
    if (typeof signalNumber === "number") {
      return 128 + signalNumber;
    }
  }
  return 1;
}

async function terminateProcessTarget(
  target: number,
  graceMs = 5_000,
): Promise<void> {
  if (!processTargetAlive(target)) {
    return;
  }
  try {
    process.kill(target, "SIGTERM");
  } catch (error) {
    if ((error as { code?: string }).code !== "ESRCH") {
      throw error;
    }
    return;
  }

  const deadline = Date.now() + graceMs;
  while (processTargetAlive(target) && Date.now() < deadline) {
    await sleep(100);
  }
  if (processTargetAlive(target)) {
    process.kill(target, "SIGKILL");
    const killDeadline = Date.now() + 1_000;
    while (processTargetAlive(target) && Date.now() < killDeadline) {
      await sleep(25);
    }
    if (processTargetAlive(target)) {
      throw new Error(`process target ${target} survived SIGKILL`);
    }
  }
}

async function runGuest(args: string[]): Promise<number> {
  const { requestedName, explicitArgv } = parseMainInvocation(args);
  await ensureDaemon();

  const cwd = resolve(process.cwd());
  type Allocation =
    | { kind: "existing"; guest: Guest }
    | { kind: "allocated"; name: string; port: number; token: string };

  let allocation: Allocation;
  for (;;) {
    try {
      allocation = await apiJson<Allocation>(
        "/allocate",
        jsonInit(
          {
            path: cwd,
            ...(requestedName === null ? {} : { name: requestedName }),
          },
          "POST",
        ),
      );
      break;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await sleep(100);
        continue;
      }
      throw error;
    }
  }

  if (allocation.kind === "existing") {
    console.log(
      `yado ▸ http://${allocation.guest.name}.local/ (already running)`,
    );
    return 0;
  }

  let receivedSignal: NodeJS.Signals | null = null;
  let childPgid: number | null = null;
  let childExited = false;
  let guest: Guest | null = null;
  let registered = false;
  let log: LogSink | null = null;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      receivedSignal ??= signal;
      if (childPgid === null) {
        return;
      }
      try {
        process.kill(-childPgid, signal);
      } catch (error) {
        if ((error as { code?: string }).code !== "ESRCH") {
          console.error(`yado: cannot forward ${signal}: ${errorMessage(error)}`);
        }
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    const launch = await resolveLaunchCommand(
      cwd,
      explicitArgv,
      allocation.port,
    );
    if (receivedSignal !== null) {
      return exitCodeFor({ code: null, signal: receivedSignal });
    }

    mkdirSync(STATE_PATHS.logsDir, { recursive: true });
    const logFile = join(STATE_PATHS.logsDir, `${allocation.name}.log`);
    await Bun.write(logFile, "");
    log = createLogSink(logFile);
    log.write(`[${new Date().toISOString()}] ${launch.display}\n`);

    if (receivedSignal !== null) {
      return exitCodeFor({ code: null, signal: receivedSignal });
    }

    let child: Bun.Subprocess<"inherit", "pipe", "pipe">;
    try {
      child = Bun.spawn({
        cmd: launch.argv,
        cwd,
        env: { ...process.env, PORT: String(allocation.port) },
        detached: true,
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      throw new Error(`cannot start ${launch.display}: ${errorMessage(error)}`);
    }

    const tees = Promise.all([
      teeStream(child.stdout, process.stdout, () => log),
      teeStream(child.stderr, process.stderr, () => log),
    ]);
    const completion = (async (): Promise<ChildResult> => {
      await child.exited;
      // The tees must drain before the exit code is reported, so no Guest
      // output is lost on the way to the terminal and the log file.
      await tees;
      return { code: child.exitCode, signal: child.signalCode };
    })();

    const pid = child.pid;
    if (!pid) {
      throw new Error(`cannot determine pid for ${launch.display}`);
    }
    childPgid = pid;
    if (receivedSignal !== null) {
      try {
        process.kill(-pid, receivedSignal);
      } catch (error) {
        if ((error as { code?: string }).code !== "ESRCH") {
          throw error;
        }
      }
    }

    guest = {
      name: allocation.name,
      port: allocation.port,
      pid,
      pgid: pid,
      path: cwd,
      cmd: launch.display,
      kind: "managed",
      owner: {
        tty: processTty(process.pid),
        label: inferOwnerLabel(),
      },
      startedAt: new Date().toISOString(),
      logFile,
    };

    await apiJson<Guest>(
      "/guests",
      jsonInit({ guest, token: allocation.token }, "POST"),
    );
    registered = true;

    const banner = `yado ▸ http://${guest.name}.local → :${guest.port}`;
    console.log(banner);
    console.log(`log ▸ ${guest.logFile}`);
    log.write(`${banner}\nlog ▸ ${guest.logFile}\n`);

    const measurePort = async () => {
      const deadline = Date.now() + LISTEN_TIMEOUT_MS;
      let firstRespondingAt: number | null = null;
      while (!childExited && Date.now() < deadline) {
        const ports = listeningPortsForProcessGroup(pid);
        if (ports.length > 0) {
          const probeResults = await Promise.all(
            ports.map(async (port) => ({
              port,
              responds: await probeHttpPort(port),
            })),
          );
          const respondingPorts = probeResults
            .filter((result) => result.responds)
            .map((result) => result.port);
          if (respondingPorts.length > 0 && firstRespondingAt === null) {
            firstRespondingAt = Date.now();
          }
          const graceElapsed =
            firstRespondingAt !== null &&
            Date.now() - firstRespondingAt >= ALLOCATED_PORT_GRACE_MS;
          const measured = chooseMeasuredPort(
            allocation.port,
            respondingPorts,
            graceElapsed,
          );
          if (measured === null) {
            await sleep(200);
            continue;
          }
          if (measured !== allocation.port) {
            await apiJson<Guest>(
              `/guests/${encodeURIComponent(guest!.name)}`,
              jsonInit(
                {
                  port: measured,
                  pid: guest!.pid,
                  pgid: guest!.pgid,
                  path: guest!.path,
                  startedAt: guest!.startedAt,
                },
                "PATCH",
              ),
            );
            guest!.port = measured;
            const correction = `yado ▸ corrected http://${guest!.name}.local → :${measured}`;
            console.log(correction);
            log?.write(`${correction}\n`);
          }
          return;
        }
        await sleep(200);
      }
      if (!childExited) {
        const warning = `yado: warning: ${guest!.name} did not listen within 20 seconds`;
        console.error(warning);
        log?.write(`${warning}\n`);
      }
    };
    const measurement = measurePort().catch((error) => {
      const warning = `yado: warning: port measurement failed: ${errorMessage(error)}`;
      console.error(warning);
      log?.write(`${warning}\n`);
    });

    const result = await completion;
    childExited = true;
    await measurement;
    return exitCodeFor(result);
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    if (childPgid !== null && !childExited) {
      await terminateProcessTarget(-childPgid).catch((error) => {
        console.error(`yado: cannot clean up process group: ${errorMessage(error)}`);
      });
    }
    if (guest && registered) {
      await deleteGuest(guest.name, guest).catch((error) => {
        console.error(`yado: ${errorMessage(error)}`);
      });
    } else {
      await cancelReservation(allocation.name, allocation.token).catch((error) => {
        console.error(`yado: ${errorMessage(error)}`);
      });
    }
    if (log) {
      await log.end();
    }
  }
}

function formatUptime(startedAt: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(startedAt)) / 1_000),
  );
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3_600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3_600)}h`;
  }
  return `${Math.floor(seconds / 86_400)}d`;
}

function printGuestTable(guests: readonly Guest[]): void {
  const headers = ["NAME", "URL", "PORT", "OWNER", "KIND", "UPTIME"];
  const rows = guests.map((guest) => [
    guest.name,
    `http://${guest.name}.local/`,
    String(guest.port),
    guest.owner.tty
      ? `${guest.owner.label}:${guest.owner.tty}`
      : guest.owner.label,
    guest.kind,
    formatUptime(guest.startedAt),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const printRow = (row: readonly string[]) =>
    console.log(
      row.map((value, index) => value.padEnd(widths[index]!)).join("  "),
    );
  printRow(headers);
  for (const row of rows) {
    printRow(row);
  }
}

async function lsCommand(args: string[]): Promise<number> {
  if (args.some((argument) => argument !== "--json")) {
    throw new Error("usage: yado ls [--json]");
  }
  await ensureDaemon();
  const guests = await listGuests();
  if (args.includes("--json")) {
    console.log(JSON.stringify(guests, null, 2));
  } else {
    printGuestTable(guests);
  }
  return 0;
}

function parseStopArgs(args: string[]): { name: string | null; force: boolean } {
  let name: string | null = null;
  let force = false;
  for (const argument of args) {
    if (argument === "--force") {
      force = true;
    } else if (!argument.startsWith("-") && name === null) {
      name = argument;
    } else {
      throw new Error("usage: yado stop [name] [--force]");
    }
  }
  return { name, force };
}

async function stopCommand(args: string[]): Promise<number> {
  const { name, force } = parseStopArgs(args);
  await ensureDaemon();
  const guests = await listGuests();
  const guest =
    name === null
      ? guests.find((candidate) => candidate.path === resolve(process.cwd()))
      : guests.find((candidate) => candidate.name === name);
  if (!guest) {
    throw new Error(
      name === null
        ? "the current directory has no Guest"
        : `Guest "${name}" was not found`,
    );
  }

  const callerTty = processTty(process.pid);
  if (callerTty !== guest.owner.tty && !force) {
    console.error(
      "このGuestは別のOwnerが起動しています。ユーザーに確認した上で --force を付けて再実行してください",
    );
    return 3;
  }

  const current = (await listGuests()).find(
    (candidate) => candidate.name === guest.name,
  );
  if (
    !current ||
    current.pid !== guest.pid ||
    current.pgid !== guest.pgid ||
    current.path !== guest.path ||
    current.startedAt !== guest.startedAt
  ) {
    throw new Error("Guest changed while checkout was in progress");
  }
  const actualCwd = processCwd(guest.pid);
  if (actualCwd !== null && resolve(actualCwd) !== guest.path) {
    throw new Error(
      `Guest process no longer matches its registry path: ${actualCwd}`,
    );
  }

  const target = guest.pgid === null ? guest.pid : -guest.pgid;
  await terminateProcessTarget(target);

  await deleteGuest(guest.name, guest);
  console.log(`yado ▸ checked out ${guest.name}`);
  return 0;
}

async function daemonCommand(args: string[]): Promise<number> {
  const subcommand = args[0];
  if (args.length !== 1 || !["run", "status", "stop"].includes(subcommand ?? "")) {
    throw new Error("usage: yado daemon <run|status|stop>");
  }
  assertSupportedPlatform();

  if (subcommand === "run") {
    await runDaemon();
    return 0;
  }
  if (subcommand === "status") {
    if (!(await daemonHealth())) {
      console.log("yado daemon: stopped");
      return 1;
    }
    const health = await apiJson<{ pid: number }>("/health");
    console.log(`yado daemon: running (pid ${health.pid})`);
    return 0;
  }

  if (!(await daemonHealth())) {
    console.log("yado daemon: stopped");
    return 0;
  }
  const { pid } = await apiJson<{ pid: number }>("/health");
  if (pid > 0) {
    await terminateProcessTarget(pid);
  }
  console.log("yado daemon: stopped");
  return 0;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args[0] === "ls") {
    return lsCommand(args.slice(1));
  }
  if (args[0] === "stop") {
    return stopCommand(args.slice(1));
  }
  if (args[0] === "daemon") {
    return daemonCommand(args.slice(1));
  }
  return runGuest(args);
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`yado: ${errorMessage(error)}`);
      process.exitCode = 1;
    });
}
