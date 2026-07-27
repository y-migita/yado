import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Guest,
  RegistryFormatError,
  RegistryStore,
  isGuest,
  parseRegistryJson,
  readRegistryFile,
  serializeRegistry,
} from "../src/registry";

function makeGuest(overrides: Partial<Guest> = {}): Guest {
  return {
    name: "example",
    port: 4_321,
    pid: 101,
    pgid: 101,
    path: "/tmp/example",
    cmd: "bun run dev",
    kind: "managed",
    owner: { tty: "ttys001", label: "terminal" },
    startedAt: "2026-07-28T00:00:00.000Z",
    logFile: "/tmp/example.log",
    ...overrides,
  };
}

async function withRegistry(
  callback: (store: RegistryStore, filePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "yado-registry-"));
  const filePath = join(directory, "state", "registry.json");
  try {
    await callback(new RegistryStore(filePath), filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Guest schema and JSON", () => {
  test("round-trips the exact Guest array schema", () => {
    const guests = [
      makeGuest(),
      makeGuest({
        name: "auto-guest",
        pid: 202,
        pgid: null,
        kind: "auto",
        logFile: null,
      }),
    ];

    expect(parseRegistryJson(serializeRegistry(guests))).toEqual(guests);
  });

  test("rejects invalid JSON, a non-array root, and malformed Guests", () => {
    expect(() => parseRegistryJson("{")).toThrow(RegistryFormatError);
    expect(() => parseRegistryJson("{}")).toThrow(RegistryFormatError);
    expect(() =>
      parseRegistryJson(JSON.stringify([makeGuest({ port: 0 })])),
    ).toThrow(RegistryFormatError);
  });

  test("enforces managed/auto log file semantics and absolute paths", () => {
    expect(isGuest(makeGuest())).toBe(true);
    expect(
      isGuest(
        makeGuest({
          kind: "auto",
          pgid: null,
          logFile: null,
        }),
      ),
    ).toBe(true);
    expect(isGuest(makeGuest({ kind: "auto" }))).toBe(false);
    expect(isGuest(makeGuest({ path: "relative/path" }))).toBe(false);
    expect(isGuest(makeGuest({ startedAt: "July 28, 2026" }))).toBe(false);
    expect(isGuest(makeGuest({ name: "a".repeat(64) }))).toBe(false);
  });
});

describe("RegistryStore", () => {
  test("loads a missing registry as an empty array", async () => {
    await withRegistry(async (store, filePath) => {
      expect(await store.load()).toEqual([]);
      expect(await readRegistryFile(filePath)).toEqual([]);
    });
  });

  test("persists add, patch, and remove through tmp+rename", async () => {
    await withRegistry(async (store, filePath) => {
      await store.add(makeGuest());
      expect(await readRegistryFile(filePath)).toEqual([makeGuest()]);

      expect(await store.patchPort("example", 5_678)).toEqual(
        makeGuest({ port: 5_678 }),
      );
      expect(await readRegistryFile(filePath)).toEqual([
        makeGuest({ port: 5_678 }),
      ]);

      expect(await store.remove("example")).toEqual(
        makeGuest({ port: 5_678 }),
      );
      expect(await readRegistryFile(filePath)).toEqual([]);
      expect(
        await readFile(`${filePath}.tmp`, "utf8").catch(
          (error: { code?: string }) => error.code,
        ),
      ).toBe("ENOENT");
    });
  });

  test("serializes concurrent writes in mutation order", async () => {
    await withRegistry(async (store, filePath) => {
      const first = makeGuest();
      const second = makeGuest({
        name: "second",
        pid: 202,
        pgid: 202,
        path: "/tmp/second",
      });

      await Promise.all([store.add(first), store.add(second)]);
      expect(await readRegistryFile(filePath)).toEqual([first, second]);
    });
  });

  test("keeps committed memory and disk state when persistence fails", async () => {
    await withRegistry(async (store, filePath) => {
      const original = makeGuest();
      await store.add(original);

      await mkdir(`${filePath}.tmp`);
      await expect(store.patchPort("example", 5_678)).rejects.toThrow();

      expect(store.get("example")).toEqual(original);
      expect(await readRegistryFile(filePath)).toEqual([original]);

      await rm(`${filePath}.tmp`, { recursive: true });
      expect(await store.patchPort("example", 6_789)).toEqual(
        makeGuest({ port: 6_789 }),
      );
      expect(store.get("example")).toEqual(makeGuest({ port: 6_789 }));
    });
  });

  test("does not write for unknown patch/remove operations", async () => {
    await withRegistry(async (store, filePath) => {
      expect(await store.patchPort("missing", 4_321)).toBeUndefined();
      expect(await store.remove("missing")).toBeUndefined();
      expect(
        await readFile(filePath, "utf8").catch(
          (error: { code?: string }) => error.code,
        ),
      ).toBe("ENOENT");
    });
  });

  test("prunes only dead pids and persists once", async () => {
    await withRegistry(async (store, filePath) => {
      const live = makeGuest();
      const dead = makeGuest({
        name: "dead",
        pid: 202,
        pgid: 202,
        path: "/tmp/dead",
      });
      await store.add(live);
      await store.add(dead);

      expect(await store.pruneDead((pid) => pid === live.pid)).toEqual([dead]);
      expect(await readRegistryFile(filePath)).toEqual([live]);
    });
  });

  test("returns defensive copies and rejects duplicate adds", async () => {
    await withRegistry(async (store) => {
      await store.add(makeGuest());

      const snapshot = store.list();
      snapshot[0]!.port = 6_000;
      snapshot[0]!.owner.label = "changed";
      expect(store.get("example")).toEqual(makeGuest());

      await expect(store.add(makeGuest())).rejects.toThrow("already exists");
    });
  });

  test("fails loudly when an existing registry is malformed", async () => {
    await withRegistry(async (store, filePath) => {
      await store.add(makeGuest());
      await writeFile(filePath, "{broken");

      await expect(store.load()).rejects.toThrow(RegistryFormatError);
    });
  });
});
