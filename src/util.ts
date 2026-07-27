import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Guest } from "./registry";

export const DNS_LABEL_MAX_LENGTH = 63;

export interface StatePaths {
  stateDir: string;
  registryPath: string;
  socketPath: string;
  pidPath: string;
  daemonLogPath: string;
  logsDir: string;
  configPath: string;
}

export type HostResolution =
  | { kind: "status" }
  | { kind: "guest"; guest: Guest }
  | { kind: "unknown" };

export class InvalidGuestNameError extends Error {
  constructor(input: string) {
    super(`Guest name "${input}" does not contain any valid characters`);
    this.name = "InvalidGuestNameError";
  }
}

export function getStatePaths(
  homeDirectory = homedir(),
  stateDirectory = process.env.YADO_STATE_DIR,
): StatePaths {
  const stateDir =
    stateDirectory === undefined
      ? join(homeDirectory, ".local", "state", "yado")
      : resolve(stateDirectory);

  return {
    stateDir,
    registryPath: join(stateDir, "registry.json"),
    socketPath: join(stateDir, "daemon.sock"),
    pidPath: join(stateDir, "daemon.pid"),
    daemonLogPath: join(stateDir, "daemon.log"),
    logsDir: join(stateDir, "logs"),
    configPath: join(stateDir, "config.json"),
  };
}

export const STATE_PATHS = getStatePaths();

export function normalizeGuestName(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, DNS_LABEL_MAX_LENGTH)
    .replace(/-+$/g, "");

  if (normalized.length === 0) {
    throw new InvalidGuestNameError(input);
  }

  return normalized;
}

export function nextAvailableName(
  preferredName: string,
  occupiedNames: Iterable<string>,
): string {
  const base = normalizeGuestName(preferredName);
  const occupied = new Set(
    Array.from(occupiedNames, (name) => name.toLowerCase()),
  );

  if (!occupied.has(base)) {
    return base;
  }

  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `-${suffix}`;
    const prefix = base
      .slice(0, DNS_LABEL_MAX_LENGTH - suffixText.length)
      .replace(/-+$/g, "");
    const candidate = `${prefix}${suffixText}`;
    if (!occupied.has(candidate)) {
      return candidate;
    }
  }
}

export function normalizeHostHeader(host: string | null): string | null {
  if (host === null) {
    return null;
  }

  let normalized = host.trim().toLowerCase();
  if (normalized.length === 0 || normalized.startsWith("[")) {
    return null;
  }

  normalized = normalized.replace(/:\d+$/, "").replace(/\.$/, "");
  if (normalized.length === 0 || normalized.includes(":")) {
    return null;
  }

  return normalized;
}

export function guestNameFromHost(host: string | null): string | null {
  const normalizedHost = normalizeHostHeader(host);
  if (normalizedHost === null) {
    return null;
  }

  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.local$/.exec(normalizedHost);
  return match?.[1] ?? null;
}

export function resolveHost(
  host: string | null,
  guests: readonly Guest[],
): HostResolution {
  const normalizedHost = normalizeHostHeader(host);
  if (normalizedHost === "yado.local") {
    return { kind: "status" };
  }

  const guestName = guestNameFromHost(normalizedHost);
  if (guestName === null) {
    return { kind: "unknown" };
  }

  const guest = guests.find(
    (candidate) => candidate.name.toLowerCase() === guestName,
  );

  return guest === undefined
    ? { kind: "unknown" }
    : { kind: "guest", guest };
}

export function expandHomePath(
  path: string,
  homeDirectory = homedir(),
): string {
  if (path === "~") {
    return homeDirectory;
  }
  if (path.startsWith("~/")) {
    return join(homeDirectory, path.slice(2));
  }
  return path;
}

export function isPathInside(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

export function assertValidPort(port: number): void {
  if (!isValidPort(port)) {
    throw new RangeError(`Invalid TCP port: ${port}`);
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

export function formatCommand(argv: readonly string[]): string {
  return argv
    .map((argument) => {
      if (/^[a-zA-Z0-9_./:=@%+,-]+$/.test(argument)) {
        return argument;
      }
      return `'${argument.replace(/'/g, "'\\''")}'`;
    })
    .join(" ");
}
