import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";

import type { Guest } from "./registry";
import {
  expandHomePath,
  isPathInside,
  isPidAlive,
  normalizeGuestName,
} from "./util";

const LSOF = "/usr/sbin/lsof";
const PS = "/bin/ps";
const OSASCRIPT = "/usr/bin/osascript";
const DEFAULT_SCAN_ROOTS = ["~/Documents/GitHub"] as const;
const PROCESS_INSPECTION_TIMEOUT_MS = 2_000;

export interface ListeningSocket {
  command: string;
  pid: number;
  port: number;
}

export interface AutoCheckInCandidate {
  name: string;
  port: number;
  pid: number;
  pgid: number | null;
  path: string;
  cmd: string;
  tty: string | null;
}

export interface GuestScannerOptions {
  configPath: string;
  daemonPid: number;
  getGuests: () => readonly Guest[];
  checkIn: (candidate: AutoCheckInCandidate) => Promise<Guest | null>;
  checkOut: (guest: Guest) => Promise<void>;
  log?: (message: string) => void;
}

export function parseLsofListeners(output: string): ListeningSocket[] {
  const listeners = new Map<string, ListeningSocket>();

  for (const line of output.split(/\r?\n/)) {
    const processMatch = /^(\S+)\s+(\d+)\s+/.exec(line);
    const portMatch = /\bTCP\s+.+:(\d+)\s+\(LISTEN\)\s*$/.exec(line);
    if (!processMatch || !portMatch) {
      continue;
    }

    const pid = Number(processMatch[2]);
    const port = Number(portMatch[1]);
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    ) {
      continue;
    }

    const key = `${pid}:${port}`;
    listeners.set(key, {
      command: processMatch[1]!,
      pid,
      port,
    });
  }

  return [...listeners.values()];
}

export function parseLsofCwd(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("n/")) {
      return line.slice(1);
    }
  }
  return null;
}

export function parseProcessGroup(output: string): number | null {
  const value = Number.parseInt(output.trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function parseTty(output: string): string | null {
  const tty = output.trim();
  return tty === "" || tty === "?" || tty === "??" ? null : tty;
}

export function dedicatedProcessGroupId(
  pid: number,
  observedPgid: number | null,
): number | null {
  return observedPgid === pid ? observedPgid : null;
}

export async function probeHttpPort(
  port: number,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  const results = await Promise.all(
    ["127.0.0.1", "[::1]"].map(async (host) => {
      try {
        const response = await fetchImpl(`http://${host}:${port}/`, {
          signal: AbortSignal.timeout(400),
          redirect: "manual",
        });
        await response.body?.cancel();
        return true;
      } catch {
        return false;
      }
    }),
  );
  return results.some(Boolean);
}

export async function loadScanRoots(configPath: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(configPath).text());
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as { scanRoots?: unknown }).scanRoots) &&
      (parsed as { scanRoots: unknown[] }).scanRoots.every(
        (root) => typeof root === "string" && root.length > 0,
      )
    ) {
      return (parsed as { scanRoots: string[] }).scanRoots.map((root) =>
        expandHomePath(root),
      );
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }

  return DEFAULT_SCAN_ROOTS.map((root) => expandHomePath(root));
}

function runText(command: string, args: string[]): string | null {
  let result: Bun.SyncSubprocess<"pipe", "pipe">;
  try {
    result = Bun.spawnSync({
      cmd: [command, ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return null;
  }
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0 && stdout.length === 0) {
    return null;
  }
  return stdout;
}

export async function runTextAsync(
  command: string,
  args: readonly string[],
): Promise<string | null> {
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    child = Bun.spawn({
      cmd: [command, ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The child already exited.
    }
  }, PROCESS_INSPECTION_TIMEOUT_MS);
  timeout.unref();

  try {
    let stdout: string | null = null;
    try {
      stdout = await new Response(child.stdout).text();
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited.
      }
    }
    const exitCode = await child.exited;
    if (timedOut || stdout === null) {
      return null;
    }
    return exitCode !== 0 && stdout.length === 0 ? null : stdout;
  } finally {
    clearTimeout(timeout);
  }
}

export function listListeningSockets(): ListeningSocket[] {
  return parseLsofListeners(
    runText(LSOF, ["-nP", "-iTCP", "-sTCP:LISTEN"]) ?? "",
  );
}

export async function listListeningSocketsAsync(): Promise<ListeningSocket[]> {
  return parseLsofListeners(
    (await runTextAsync(LSOF, ["-nP", "-iTCP", "-sTCP:LISTEN"])) ?? "",
  );
}

export function processCwd(pid: number): string | null {
  const output = runText(LSOF, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  return output === null ? null : parseLsofCwd(output);
}

export async function processCwdAsync(pid: number): Promise<string | null> {
  const output = await runTextAsync(LSOF, [
    "-a",
    "-p",
    String(pid),
    "-d",
    "cwd",
    "-Fn",
  ]);
  return output === null ? null : parseLsofCwd(output);
}

export function processGroupId(pid: number): number | null {
  const output = runText(PS, ["-o", "pgid=", "-p", String(pid)]);
  return output === null ? null : parseProcessGroup(output);
}

export async function processGroupIdAsync(
  pid: number,
): Promise<number | null> {
  const output = await runTextAsync(PS, [
    "-o",
    "pgid=",
    "-p",
    String(pid),
  ]);
  return output === null ? null : parseProcessGroup(output);
}

export function processTty(pid: number): string | null {
  const output = runText(PS, ["-o", "tty=", "-p", String(pid)]);
  return output === null ? null : parseTty(output);
}

export async function processTtyAsync(pid: number): Promise<string | null> {
  const output = await runTextAsync(PS, [
    "-o",
    "tty=",
    "-p",
    String(pid),
  ]);
  return output === null ? null : parseTty(output);
}

export function processCommand(pid: number): string | null {
  const output = runText(PS, ["-o", "command=", "-p", String(pid)]);
  const command = output?.trim() ?? "";
  return command || null;
}

export async function processCommandAsync(
  pid: number,
): Promise<string | null> {
  const output = await runTextAsync(PS, [
    "-o",
    "command=",
    "-p",
    String(pid),
  ]);
  const command = output?.trim() ?? "";
  return command || null;
}

export function listeningPortsForProcessGroup(pgid: number): number[] {
  const output = runText(LSOF, [
    "-nP",
    "-a",
    "-g",
    String(pgid),
    "-iTCP",
    "-sTCP:LISTEN",
  ]);
  if (output === null) {
    return [];
  }
  return [
    ...new Set(parseLsofListeners(output).map((listener) => listener.port)),
  ].sort((left, right) => left - right);
}

async function notifyCheckIn(guest: Guest, log: (message: string) => void) {
  const message = `yado ▸ http://${guest.name}.local/ (auto check-in)`;
  if (
    guest.owner.tty &&
    /^[a-zA-Z0-9/]+$/.test(guest.owner.tty) &&
    existsSync(`/dev/${guest.owner.tty}`)
  ) {
    try {
      await writeFile(`/dev/${guest.owner.tty}`, `\n${message}\n`, {
        flag: "a",
      });
    } catch (error) {
      log(`tty notification failed for ${guest.name}: ${errorMessage(error)}`);
    }
  }

  const script = `display notification "${appleScriptString(message)}" with title "yado"`;
  try {
    const notification = Bun.spawn({
      cmd: [OSASCRIPT, "-e", script],
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    notification.unref();
  } catch (error) {
    log(`desktop notification failed for ${guest.name}: ${errorMessage(error)}`);
  }
}

function appleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export class GuestScanner {
  readonly #options: GuestScannerOptions;
  readonly #log: (message: string) => void;
  #interval: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #stopping = false;
  #idleWaiters: Array<() => void> = [];

  constructor(options: GuestScannerOptions) {
    this.#options = options;
    this.#log = options.log ?? (() => {});
  }

  start(): void {
    if (this.#interval) {
      return;
    }
    this.#stopping = false;
    void this.scan();
    this.#interval = setInterval(() => {
      void this.scan();
    }, 3_000);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#interval) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
    if (this.#running) {
      await new Promise<void>((resolveIdle) => {
        this.#idleWaiters.push(resolveIdle);
      });
    }
  }

  async scan(): Promise<void> {
    if (this.#running || this.#stopping) {
      return;
    }
    this.#running = true;

    try {
      await this.#removeDeadGuests();
      await this.#discoverGuests();
    } catch (error) {
      this.#log(`scanner failed: ${errorMessage(error)}`);
    } finally {
      this.#running = false;
      for (const resolveIdle of this.#idleWaiters.splice(0)) {
        resolveIdle();
      }
    }
  }

  async #removeDeadGuests(): Promise<void> {
    for (const guest of this.#options.getGuests()) {
      if (this.#stopping) {
        return;
      }
      if (!isPidAlive(guest.pid)) {
        await this.#options.checkOut(guest);
      }
    }
  }

  async #discoverGuests(): Promise<void> {
    const guests = this.#options.getGuests();
    const knownPids = new Set(guests.map((guest) => guest.pid));
    const knownPorts = new Set(guests.map((guest) => guest.port));
    const knownProcessGroups = new Set(
      guests.flatMap((guest) => (guest.pgid === null ? [] : [guest.pgid])),
    );
    const roots = await loadScanRoots(this.#options.configPath);
    if (this.#stopping) {
      return;
    }
    const processGroups = new Map<number, number | null>();
    const grouped = new Map<number, ListeningSocket[]>();

    const listeningSockets = await listListeningSocketsAsync();
    if (this.#stopping) {
      return;
    }

    for (const listener of listeningSockets) {
      if (
        listener.pid === this.#options.daemonPid ||
        listener.port < 1_024 ||
        knownPids.has(listener.pid) ||
        knownPorts.has(listener.port)
      ) {
        continue;
      }

      let pgid = processGroups.get(listener.pid);
      if (pgid === undefined) {
        pgid = await processGroupIdAsync(listener.pid);
        if (this.#stopping) {
          return;
        }
        processGroups.set(listener.pid, pgid);
      }
      if (pgid !== null && knownProcessGroups.has(pgid)) {
        continue;
      }

      const listeners = grouped.get(listener.pid) ?? [];
      listeners.push(listener);
      grouped.set(listener.pid, listeners);
    }

    for (const [pid, listeners] of grouped) {
      if (this.#stopping) {
        return;
      }
      if (!isPidAlive(pid)) {
        continue;
      }
      const cwd = await processCwdAsync(pid);
      if (this.#stopping) {
        return;
      }
      if (!cwd || !roots.some((root) => isPathInside(cwd, root))) {
        continue;
      }
      if (this.#options.getGuests().some((guest) => guest.path === cwd)) {
        continue;
      }

      const ports = [...new Set(listeners.map((listener) => listener.port))].sort(
        (left, right) => left - right,
      );
      const probeResults = await Promise.all(
        ports.map(async (port) => ({ port, responds: await probeHttpPort(port) })),
      );
      const port = probeResults.find((result) => result.responds)?.port;
      if (port === undefined || !isPidAlive(pid)) {
        continue;
      }
      if (this.#stopping) {
        return;
      }

      let name: string;
      try {
        name = normalizeGuestName(basename(cwd));
      } catch (error) {
        this.#log(`auto check-in skipped for ${cwd}: ${errorMessage(error)}`);
        continue;
      }

      const [command, tty] = await Promise.all([
        processCommandAsync(pid),
        processTtyAsync(pid),
      ]);
      if (this.#stopping) {
        return;
      }
      if (!isPidAlive(pid)) {
        continue;
      }

      const guest = await this.#options.checkIn({
        name,
        port,
        pid,
        pgid: dedicatedProcessGroupId(
          pid,
          processGroups.get(pid) ?? null,
        ),
        path: cwd,
        cmd: command ?? listeners[0]!.command,
        tty,
      });
      if (guest) {
        await notifyCheckIn(guest, this.#log);
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
