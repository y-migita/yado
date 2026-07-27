import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { assertValidPort, isPidAlive } from "./util";

export type GuestKind = "managed" | "auto";

export interface GuestOwner {
  tty: string | null;
  label: string;
}

export interface Guest {
  name: string;
  port: number;
  pid: number;
  pgid: number | null;
  path: string;
  cmd: string;
  kind: GuestKind;
  owner: GuestOwner;
  startedAt: string;
  logFile: string | null;
}

export type ProcessLivenessCheck = (
  pid: number,
) => boolean | Promise<boolean>;

export class RegistryFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RegistryFormatError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isIso8601(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

export function isGuest(value: unknown): value is Guest {
  if (!isRecord(value) || !isRecord(value.owner)) {
    return false;
  }

  const validName =
    typeof value.name === "string" &&
    value.name.length <= 63 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name);
  const validPort =
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65_535;
  const validPgid = value.pgid === null || isPositiveInteger(value.pgid);
  const validKind = value.kind === "managed" || value.kind === "auto";
  const validOwner =
    (value.owner.tty === null || typeof value.owner.tty === "string") &&
    typeof value.owner.label === "string" &&
    value.owner.label.length > 0;
  const validLogFile =
    (value.kind === "managed" && typeof value.logFile === "string") ||
    (value.kind === "auto" && value.logFile === null);

  return (
    validName &&
    validPort &&
    isPositiveInteger(value.pid) &&
    validPgid &&
    typeof value.path === "string" &&
    isAbsolute(value.path) &&
    typeof value.cmd === "string" &&
    validKind &&
    validOwner &&
    isIso8601(value.startedAt) &&
    validLogFile
  );
}

function cloneGuest(guest: Guest): Guest {
  return {
    name: guest.name,
    port: guest.port,
    pid: guest.pid,
    pgid: guest.pgid,
    path: guest.path,
    cmd: guest.cmd,
    kind: guest.kind,
    owner: {
      tty: guest.owner.tty,
      label: guest.owner.label,
    },
    startedAt: guest.startedAt,
    logFile: guest.logFile,
  };
}

function assertGuest(value: unknown, context = "Guest"): asserts value is Guest {
  if (!isGuest(value)) {
    throw new RegistryFormatError(`${context} does not match the Guest schema`);
  }
}

export function parseRegistryJson(source: string): Guest[] {
  let value: unknown;

  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new RegistryFormatError("registry.json contains invalid JSON", {
      cause: error,
    });
  }

  if (!Array.isArray(value)) {
    throw new RegistryFormatError("registry.json must contain a Guest array");
  }

  return value.map((guest, index) => {
    assertGuest(guest, `registry.json entry ${index}`);
    return cloneGuest(guest);
  });
}

export function serializeRegistry(guests: readonly Guest[]): string {
  const snapshot = guests.map((guest, index) => {
    assertGuest(guest, `Guest at index ${index}`);
    return cloneGuest(guest);
  });

  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export async function readRegistryFile(filePath: string): Promise<Guest[]> {
  try {
    return parseRegistryJson(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function writeRegistryFile(
  filePath: string,
  guests: readonly Guest[],
): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });

  try {
    await writeFile(temporaryPath, serializeRegistry(guests), "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export class RegistryStore {
  readonly filePath: string;

  #guests: Guest[] = [];
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get size(): number {
    return this.#guests.length;
  }

  async load(): Promise<Guest[]> {
    return this.#enqueue(async () => {
      const guests = await readRegistryFile(this.filePath);
      this.#guests = guests;
      return this.list();
    });
  }

  list(): Guest[] {
    return this.#guests.map(cloneGuest);
  }

  get(name: string): Guest | undefined {
    const guest = this.#guests.find((candidate) => candidate.name === name);
    return guest === undefined ? undefined : cloneGuest(guest);
  }

  findByPath(path: string): Guest | undefined {
    const guest = this.#guests.find((candidate) => candidate.path === path);
    return guest === undefined ? undefined : cloneGuest(guest);
  }

  async add(guest: Guest): Promise<void> {
    assertGuest(guest);
    await this.#mutate((guests) => {
      if (guests.some((candidate) => candidate.name === guest.name)) {
        throw new Error(`Guest "${guest.name}" already exists`);
      }
      return {
        guests: [...guests, cloneGuest(guest)],
        result: undefined,
      };
    });
  }

  async upsert(guest: Guest): Promise<void> {
    assertGuest(guest);
    await this.#mutate((guests) => {
      const index = guests.findIndex(
        (candidate) => candidate.name === guest.name,
      );
      const updated = guests.map(cloneGuest);

      if (index === -1) {
        updated.push(cloneGuest(guest));
      } else {
        updated[index] = cloneGuest(guest);
      }

      return { guests: updated, result: undefined };
    });
  }

  async patchPort(name: string, port: number): Promise<Guest | undefined> {
    assertValidPort(port);
    return this.#mutate((guests) => {
      const index = guests.findIndex((candidate) => candidate.name === name);
      if (index === -1) {
        return { result: undefined };
      }

      const updatedGuest = { ...guests[index]!, port };
      const updatedGuests = guests.map(cloneGuest);
      updatedGuests[index] = updatedGuest;
      return {
        guests: updatedGuests,
        result: cloneGuest(updatedGuest),
      };
    });
  }

  async remove(name: string): Promise<Guest | undefined> {
    return this.#mutate((guests) => {
      const index = guests.findIndex((candidate) => candidate.name === name);
      if (index === -1) {
        return { result: undefined };
      }

      const removed = guests[index]!;
      return {
        guests: guests.filter((_, candidateIndex) => candidateIndex !== index),
        result: cloneGuest(removed),
      };
    });
  }

  async pruneDead(
    isAlive: ProcessLivenessCheck = isPidAlive,
  ): Promise<Guest[]> {
    return this.#mutate(async (guests) => {
      const liveness = await Promise.all(
        guests.map((guest) => isAlive(guest.pid)),
      );
      const removed = guests.filter((_, index) => !liveness[index]);
      if (removed.length === 0) {
        return { result: [] };
      }

      return {
        guests: guests.filter((_, index) => liveness[index]),
        result: removed.map(cloneGuest),
      };
    });
  }

  async flush(): Promise<void> {
    await this.#mutationQueue;
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const pending = this.#mutationQueue.then(operation);
    this.#mutationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  #mutate<Result>(
    mutation: (
      guests: Guest[],
    ) =>
      | { guests?: Guest[]; result: Result }
      | Promise<{ guests?: Guest[]; result: Result }>,
  ): Promise<Result> {
    return this.#enqueue(async () => {
      const { guests, result } = await mutation(this.list());
      if (guests !== undefined) {
        await writeRegistryFile(this.filePath, guests);
        this.#guests = guests.map(cloneGuest);
      }
      return result;
    });
  }
}
