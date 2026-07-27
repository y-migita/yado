import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { Guest } from "../src/registry";
import {
  InvalidGuestNameError,
  assertValidPort,
  chooseMeasuredPort,
  expandHomePath,
  formatCommand,
  getStatePaths,
  guestNameFromHost,
  isPathInside,
  isValidPort,
  nextAvailableName,
  normalizeGuestName,
  normalizeHostHeader,
  resolveHost,
} from "../src/util";

const guest: Guest = {
  name: "example",
  port: 4_321,
  pid: 123,
  pgid: 123,
  path: "/tmp/example",
  cmd: "bun run dev",
  kind: "managed",
  owner: { tty: "ttys001", label: "terminal" },
  startedAt: "2026-07-28T00:00:00.000Z",
  logFile: "/tmp/example.log",
};

describe("normalizeGuestName", () => {
  test("lowercases, replaces invalid runs, compresses hyphens, and trims", () => {
    expect(normalizeGuestName("  My_APP---Preview!!  ")).toBe(
      "my-app-preview",
    );
  });

  test("keeps only the useful ASCII portion of a mixed name", () => {
    expect(normalizeGuestName("宿 Example 開発")).toBe("example");
  });

  test("rejects a name with no valid characters", () => {
    expect(() => normalizeGuestName("日本語")).toThrow(InvalidGuestNameError);
  });

  test("keeps the DNS label within 63 ASCII bytes", () => {
    expect(normalizeGuestName("a".repeat(80))).toBe("a".repeat(63));
    expect(normalizeGuestName(`${"a".repeat(62)}-suffix`)).toBe(
      "a".repeat(62),
    );
  });
});

describe("nextAvailableName", () => {
  test("uses the normalized base when it is free", () => {
    expect(nextAvailableName("My App", ["other"])).toBe("my-app");
  });

  test("uses the first available numeric suffix starting at 2", () => {
    expect(
      nextAvailableName("example", [
        "example",
        "example-2",
        "example-4",
      ]),
    ).toBe("example-3");
  });

  test("compares occupied names case-insensitively", () => {
    expect(nextAvailableName("Example", ["EXAMPLE"])).toBe("example-2");
  });

  test("reserves space for a collision suffix within the DNS label limit", () => {
    const base = "a".repeat(63);
    const candidate = nextAvailableName(base, [base]);
    expect(candidate).toBe(`${"a".repeat(61)}-2`);
    expect(candidate.length).toBe(63);
  });
});

describe("Host resolution", () => {
  test("normalizes case, a numeric port, and a trailing dot", () => {
    expect(normalizeHostHeader(" EXAMPLE.Local.:80 ")).toBe("example.local");
    expect(guestNameFromHost("EXAMPLE.local.:80")).toBe("example");
  });

  test("resolves yado.local to the status page", () => {
    expect(resolveHost("YADO.LOCAL.:80", [guest])).toEqual({
      kind: "status",
    });
  });

  test("resolves a Guest case-insensitively", () => {
    expect(resolveHost("EXAMPLE.local:80", [guest])).toEqual({
      kind: "guest",
      guest,
    });
  });

  test("rejects unknown, nested, and malformed hosts", () => {
    expect(resolveHost("missing.local", [guest])).toEqual({
      kind: "unknown",
    });
    expect(resolveHost("foo.example.local", [guest])).toEqual({
      kind: "unknown",
    });
    expect(resolveHost("example.local:not-a-port", [guest])).toEqual({
      kind: "unknown",
    });
    expect(resolveHost(null, [guest])).toEqual({ kind: "unknown" });
  });
});

describe("path helpers", () => {
  test("builds every state path below the requested home", () => {
    const paths = getStatePaths("/Users/tester", undefined);
    expect(paths).toEqual({
      stateDir: "/Users/tester/.local/state/yado",
      registryPath: "/Users/tester/.local/state/yado/registry.json",
      socketPath: "/Users/tester/.local/state/yado/daemon.sock",
      pidPath: "/Users/tester/.local/state/yado/daemon.pid",
      daemonLogPath: "/Users/tester/.local/state/yado/daemon.log",
      logsDir: "/Users/tester/.local/state/yado/logs",
      configPath: "/Users/tester/.local/state/yado/config.json",
    });
  });

  test("expands only a leading home shorthand", () => {
    expect(expandHomePath("~/Documents/GitHub", "/Users/tester")).toBe(
      join("/Users/tester", "Documents", "GitHub"),
    );
    expect(expandHomePath("~", "/Users/tester")).toBe("/Users/tester");
    expect(expandHomePath("/tmp/~", "/Users/tester")).toBe("/tmp/~");
  });

  test("does not confuse a sibling prefix with a child path", () => {
    expect(isPathInside("/work/repos", "/work/repos")).toBe(true);
    expect(isPathInside("/work/repos/yado", "/work/repos")).toBe(true);
    expect(isPathInside("/work/repos-other/yado", "/work/repos")).toBe(false);
    expect(isPathInside("/work/repos/../secret", "/work/repos")).toBe(false);
  });
});

describe("chooseMeasuredPort", () => {
  test("always keeps the allocated port when it responds", () => {
    expect(chooseMeasuredPort(62312, [62312, 62320], false)).toBe(62312);
    expect(chooseMeasuredPort(62312, [62320, 62312], true)).toBe(62312);
  });

  test("waits for the allocated port before correcting to another one", () => {
    // next-server opens an auxiliary localhost listener before the app socket;
    // committing to it immediately would correct the registry to a 404 port.
    expect(chooseMeasuredPort(62312, [62320], false)).toBeNull();
    expect(chooseMeasuredPort(62312, [62320, 62330], true)).toBe(62320);
  });

  test("keeps polling while nothing responds", () => {
    expect(chooseMeasuredPort(62312, [], false)).toBeNull();
    expect(chooseMeasuredPort(62312, [], true)).toBeNull();
  });
});

describe("small validation and display helpers", () => {
  test("validates the TCP port range", () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(65_535)).toBe(true);
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(65_536)).toBe(false);
    expect(isValidPort(1.5)).toBe(false);
    expect(() => assertValidPort(0)).toThrow(RangeError);
  });

  test("quotes display arguments without changing argv", () => {
    expect(formatCommand(["bun", "run", "my script", "it's-ready"])).toBe(
      "bun run 'my script' 'it'\\''s-ready'",
    );
  });
});
