import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, isAbsolute, resolve } from "node:path";

import { MdnsSupervisor } from "./mdns";
import { createProxyOptions } from "./proxy";
import { type Guest, RegistryStore, isGuest } from "./registry";
import { type AutoCheckInCandidate, GuestScanner } from "./scan";
import {
  STATE_PATHS,
  isPidAlive,
  nextAvailableName,
  normalizeGuestName,
} from "./util";

const LSOF = "/usr/sbin/lsof";
const DNS_SD = "/usr/bin/dns-sd";
const SHLOCK = "/usr/bin/shlock";
const RESERVATION_TTL_MS = 60_000;

type Logger = (message: string) => void;

interface Reservation {
  token: string;
  name: string;
  port: number;
  path: string;
  expiresAt: number;
}

interface AllocateBody {
  path: string;
  name?: string;
}

interface RegisterBody {
  guest: Guest;
  token: string;
}

type GuestIdentity = Pick<Guest, "pid" | "pgid" | "path" | "startedAt">;

export function assertSupportedPlatform(): void {
  if (process.platform !== "darwin" || !existsSync(DNS_SD)) {
    throw new Error("yado v1 is macOS-only");
  }
}

export async function daemonHealth(
  socketPath = STATE_PATHS.socketPath,
): Promise<boolean> {
  try {
    const response = await fetch("http://localhost/health", {
      unix: socketPath,
      signal: AbortSignal.timeout(300),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function createLogger(path: string): Logger {
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
      appendFileSync(path, line, "utf8");
    } catch {
      // A logging failure must not take down the proxy or its Guests.
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function acquirePidFile(path: string): void {
  const result = spawnSync(
    SHLOCK,
    ["-f", path, "-p", String(process.pid)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    return;
  }

  let existingPid = 0;
  try {
    existingPid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  } catch {
    // shlock's exit status remains the authoritative acquisition result.
  }
  const detail = String(result.stderr || result.stdout || "").trim();
  throw new Error(
    existingPid > 0
      ? `yado daemon is already running (pid ${existingPid})`
      : `cannot acquire yado daemon pid file${detail ? `: ${detail}` : ""}`,
  );
}

function removeOwnedPidFile(path: string): void {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (pid === process.pid) {
      unlinkSync(path);
    }
  } catch {
    // Missing/stale cleanup is harmless.
  }
}

function removeSocket(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
}

async function allocateFreePort(excluded: ReadonlySet<number>): Promise<number> {
  for (;;) {
    const server = createServer();
    server.unref();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
        } else {
          resolveClose();
        }
      });
    });
    if (port > 0 && !excluded.has(port)) {
      return port;
    }
  }
}

function parseJsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => {
    throw new Error("request body must be valid JSON");
  });
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function port80Diagnostic(): string {
  const result = spawnSync(
    LSOF,
    ["-nP", "-iTCP:80", "-sTCP:LISTEN"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = String(result.stdout || result.stderr || "").trim();
  return output || "(lsof found no listener)";
}

function validateAllocateBody(value: unknown): AllocateBody {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { path?: unknown }).path !== "string" ||
    !isAbsolute((value as { path: string }).path) ||
    ((value as { name?: unknown }).name !== undefined &&
      typeof (value as { name?: unknown }).name !== "string")
  ) {
    throw new Error("/allocate requires an absolute path and optional name");
  }

  return value as AllocateBody;
}

function validateRegisterBody(value: unknown): RegisterBody {
  const wrapped =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "guest" in value
      ? (value as { guest: unknown; token?: unknown })
      : { guest: value };
  if (
    !isGuest(wrapped.guest) ||
    typeof wrapped.token !== "string"
  ) {
    throw new Error("POST /guests requires a valid Guest and allocation token");
  }
  return wrapped as RegisterBody;
}

function validateGuestIdentity(
  value: unknown,
  context: string,
): GuestIdentity {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { pid?: unknown }).pid !== "number" ||
    !Number.isInteger((value as { pid: number }).pid) ||
    (value as { pid: number }).pid <= 0 ||
    !(
      (value as { pgid?: unknown }).pgid === null ||
      (typeof (value as { pgid?: unknown }).pgid === "number" &&
        Number.isInteger((value as { pgid: number }).pgid) &&
        (value as { pgid: number }).pgid > 0)
    ) ||
    typeof (value as { path?: unknown }).path !== "string" ||
    typeof (value as { startedAt?: unknown }).startedAt !== "string"
  ) {
    throw new Error(`${context} requires pid, pgid, path, and startedAt`);
  }
  return value as GuestIdentity;
}

async function runDaemonLifecycle(
  shutdownSignal: Promise<NodeJS.Signals>,
): Promise<void> {
  assertSupportedPlatform();
  mkdirSync(STATE_PATHS.logsDir, { recursive: true });
  const log = createLogger(STATE_PATHS.daemonLogPath);

  if (await daemonHealth()) {
    throw new Error("yado daemon is already running");
  }

  acquirePidFile(STATE_PATHS.pidPath);

  const registry = new RegistryStore(STATE_PATHS.registryPath);
  const reservations = new Map<string, Reservation>();
  let mutationQueue: Promise<void> = Promise.resolve();
  let proxyServer: Bun.Server<unknown> | null = null;
  let controlServer: Bun.Server<undefined> | null = null;
  let scanner: GuestScanner | null = null;
  const mdns = new MdnsSupervisor(log);
  let shuttingDown = false;

  try {
    removeSocket(STATE_PATHS.socketPath);

    const serialized = async <T>(operation: () => Promise<T>): Promise<T> => {
      const result = mutationQueue.then(operation, operation);
      mutationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    const cleanReservations = () => {
      const now = Date.now();
      for (const [name, reservation] of reservations) {
        if (reservation.expiresAt <= now) {
          reservations.delete(name);
        }
      }
    };

    const removeGuest = (guest: Guest) =>
      serialized(async () => {
        const current = registry.get(guest.name);
        if (
          !current ||
          current.pid !== guest.pid ||
          current.pgid !== guest.pgid ||
          current.path !== guest.path ||
          current.startedAt !== guest.startedAt
        ) {
          return;
        }
        const removed = await registry.remove(guest.name);
        if (removed) {
          await mdns.withdraw(removed.name);
          log(`checked out: ${removed.name} (pid ${removed.pid})`);
        }
      });

    const autoCheckIn = (candidate: AutoCheckInCandidate) =>
      serialized(async (): Promise<Guest | null> => {
        cleanReservations();
        if (registry.findByPath(candidate.path)) {
          return null;
        }
        if (
          [...reservations.values()].some(
            (reservation) => reservation.path === candidate.path,
          )
        ) {
          return null;
        }
        const occupied = [
          "yado",
          ...registry.list().map((guest) => guest.name),
          ...reservations.keys(),
        ];
        const name = nextAvailableName(candidate.name, occupied);
        const guest: Guest = {
          name,
          port: candidate.port,
          pid: candidate.pid,
          pgid: candidate.pgid,
          path: candidate.path,
          cmd: candidate.cmd,
          kind: "auto",
          owner: {
            tty: candidate.tty,
            label: candidate.tty ? "terminal" : "agent",
          },
          startedAt: new Date().toISOString(),
          logFile: null,
        };
        await registry.add(guest);
        mdns.advertise(guest.name);
        log(`auto checked in: ${guest.name} -> :${guest.port} (pid ${guest.pid})`);
        return guest;
      });

    await registry.load();
    const staleGuests = await registry.pruneDead();
    for (const guest of staleGuests) {
      log(`removed stale Guest: ${guest.name} (pid ${guest.pid})`);
    }

    try {
      proxyServer = Bun.serve({
        hostname: "::",
        ipv6Only: false,
        port: 80,
        ...createProxyOptions(() => registry.list(), log),
      });
    } catch (error) {
      throw new Error(
        `cannot bind yado proxy to port 80: ${errorMessage(error)}\n${port80Diagnostic()}`,
      );
    }

    await mdns.start(["yado", ...registry.list().map((guest) => guest.name)]);

    controlServer = Bun.serve({
      unix: STATE_PATHS.socketPath,
      async fetch(request): Promise<Response> {
        try {
          const url = new URL(request.url);
          if (request.method === "GET" && url.pathname === "/health") {
            return json({ ok: true, pid: process.pid });
          }
          if (request.method === "GET" && url.pathname === "/guests") {
            return json(registry.list());
          }
          if (request.method === "POST" && url.pathname === "/allocate") {
            const body = validateAllocateBody(await parseJsonBody(request));
            return await serialized(async () => {
              cleanReservations();
              const path = resolve(body.path);
              const existing = registry.findByPath(path);
              if (existing && isPidAlive(existing.pid)) {
                return json({ kind: "existing", guest: existing });
              }
              if (existing) {
                await registry.remove(existing.name);
                await mdns.withdraw(existing.name);
              }
              if (
                [...reservations.values()].some(
                  (reservation) => reservation.path === path,
                )
              ) {
                return json(
                  { error: "an allocation for this path is already in progress" },
                  409,
                );
              }

              const preferred = normalizeGuestName(
                body.name ?? basename(path),
              );
              const occupiedNames = [
                "yado",
                ...registry.list().map((guest) => guest.name),
                ...reservations.keys(),
              ];
              const name = nextAvailableName(preferred, occupiedNames);
              const excludedPorts = new Set([
                ...registry.list().map((guest) => guest.port),
                ...[...reservations.values()].map(
                  (reservation) => reservation.port,
                ),
              ]);
              const port = await allocateFreePort(excludedPorts);
              const reservation: Reservation = {
                token: crypto.randomUUID(),
                name,
                port,
                path,
                expiresAt: Date.now() + RESERVATION_TTL_MS,
              };
              reservations.set(name, reservation);
              return json({
                kind: "allocated",
                name,
                port,
                token: reservation.token,
              });
            });
          }
          if (request.method === "POST" && url.pathname === "/guests") {
            const body = validateRegisterBody(await parseJsonBody(request));
            return await serialized(async () => {
              cleanReservations();
              const reservation = reservations.get(body.guest.name);
              if (
                !reservation ||
                reservation.port !== body.guest.port ||
                reservation.path !== body.guest.path ||
                body.token !== reservation.token
              ) {
                throw new Error("Guest does not match an active allocation");
              }
              if (registry.findByPath(body.guest.path)) {
                throw new Error("this path already has a live Guest");
              }
              await registry.add(body.guest);
              reservations.delete(body.guest.name);
              mdns.advertise(body.guest.name);
              log(
                `checked in: ${body.guest.name} -> :${body.guest.port} (pid ${body.guest.pid})`,
              );
              return json(body.guest, 201);
            });
          }

          const guestMatch = /^\/guests\/([^/]+)$/.exec(url.pathname);
          if (guestMatch) {
            const name = decodeURIComponent(guestMatch[1]!);
            if (request.method === "PATCH") {
              const body = await parseJsonBody(request);
              if (
                typeof body !== "object" ||
                body === null ||
                Array.isArray(body) ||
                typeof (body as { port?: unknown }).port !== "number"
              ) {
                throw new Error("PATCH Guest requires a port");
              }
              const identity = validateGuestIdentity(body, "PATCH Guest");
              const port = (body as { port: number }).port;
              return await serialized(async () => {
                const current = registry.get(name);
                if (!current) {
                  return json({ error: "Guest not found" }, 404);
                }
                if (
                  identity.pid !== current.pid ||
                  identity.pgid !== current.pgid ||
                  identity.path !== current.path ||
                  identity.startedAt !== current.startedAt
                ) {
                  return json(
                    { error: "Guest changed while port measurement was in progress" },
                    409,
                  );
                }
                const updated = await registry.patchPort(name, port);
                return updated
                  ? json(updated)
                  : json({ error: "Guest not found" }, 404);
              });
            }
            if (request.method === "DELETE") {
              if (request.body === null) {
                throw new Error(
                  "DELETE Guest requires an identity or reservation token",
                );
              }
              const body = await parseJsonBody(request);
              if (
                typeof body !== "object" ||
                body === null ||
                Array.isArray(body)
              ) {
                throw new Error("DELETE Guest expectation must be an object");
              }
              const token =
                typeof (body as { token?: unknown }).token === "string"
                  ? (body as { token: string }).token
                  : null;
              const expected =
                token === null
                  ? validateGuestIdentity(body, "DELETE Guest")
                  : null;
              return await serialized(async () => {
                if (token !== null) {
                  const reservation = reservations.get(name);
                  if (!reservation || reservation.token !== token) {
                    return json({ error: "Reservation not found" }, 404);
                  }
                  reservations.delete(name);
                  return json({ cancelled: true });
                }
                const current = registry.get(name);
                if (
                  current &&
                  expected &&
                  (expected.pid !== current.pid ||
                    expected.pgid !== current.pgid ||
                    expected.path !== current.path ||
                    expected.startedAt !== current.startedAt)
                ) {
                  return json(
                    { error: "Guest changed while checkout was in progress" },
                    409,
                  );
                }
                const removed = current
                  ? await registry.remove(name)
                  : undefined;
                if (removed) {
                  await mdns.withdraw(name);
                  log(`checked out: ${name} (pid ${removed.pid})`);
                }
                return removed
                  ? json(removed)
                  : json({ error: "Guest not found" }, 404);
              });
            }
          }

          return json({ error: "Not found" }, 404);
        } catch (error) {
          log(`control API error: ${errorMessage(error)}`);
          return json({ error: errorMessage(error) }, 400);
        }
      },
    });
    chmodSync(STATE_PATHS.socketPath, 0o600);

    scanner = new GuestScanner({
      configPath: STATE_PATHS.configPath,
      daemonPid: process.pid,
      getGuests: () => registry.list(),
      checkIn: autoCheckIn,
      checkOut: removeGuest,
      log,
    });
    scanner.start();
    log(
      `daemon started (pid ${process.pid}, proxy :80, mDNS ${mdns.address ?? "unknown"})`,
    );

    const signal = await shutdownSignal;
    log(`daemon received ${signal}`);
  } finally {
    if (!shuttingDown) {
      shuttingDown = true;
      try {
        await scanner?.stop();
        await controlServer?.stop(true).catch(() => undefined);
        await proxyServer?.stop(true).catch(() => undefined);
        await mdns.stop();
        await mutationQueue;
        await registry.flush().catch(() => undefined);
      } finally {
        try {
          removeSocket(STATE_PATHS.socketPath);
        } catch (error) {
          log(`daemon socket cleanup failed: ${errorMessage(error)}`);
        }
        removeOwnedPidFile(STATE_PATHS.pidPath);
        log("daemon stopped");
      }
    }
  }
}

export async function runDaemon(): Promise<void> {
  let resolveShutdown!: (signal: NodeJS.Signals) => void;
  const shutdownSignal = new Promise<NodeJS.Signals>((resolveSignal) => {
    resolveShutdown = resolveSignal;
  });
  let receivedSignal: NodeJS.Signals | null = null;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (receivedSignal === null) {
      receivedSignal = signal;
      resolveShutdown(signal);
    }
  };
  const handleSigint = () => handleSignal("SIGINT");
  const handleSigterm = () => handleSignal("SIGTERM");

  // Install handlers before acquiring any daemon resource. A signal received
  // during startup is latched and observed after initialization, ensuring the
  // lifecycle's finally block owns every cleanup.
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);
  try {
    await runDaemonLifecycle(shutdownSignal);
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  }
}

if (import.meta.main) {
  if (process.argv[2] !== "run") {
    console.error("usage: bun src/daemon.ts run");
    process.exitCode = 2;
  } else {
    runDaemon().catch((error) => {
      try {
        mkdirSync(STATE_PATHS.stateDir, { recursive: true });
        createLogger(STATE_PATHS.daemonLogPath)(
          `daemon failed: ${errorMessage(error)}`,
        );
      } catch {
        // The foreground error below is the final fallback.
      }
      console.error(`yado: ${errorMessage(error)}`);
      process.exitCode = 1;
    });
  }
}
