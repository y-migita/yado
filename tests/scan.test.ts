import { describe, expect, test } from "bun:test";

import {
  parseGlobalIPv6,
  isUsableIPv4,
  parseDefaultInterface,
} from "../src/mdns";
import {
  dedicatedProcessGroupId,
  parseLsofCwd,
  parseLsofListeners,
  parseProcessGroup,
  parseTty,
  probeHttpPort,
  runTextAsync,
} from "../src/scan";

describe("lsof parsing", () => {
  test("parses IPv4, IPv6, wildcard, and loopback listeners", () => {
    const output = `COMMAND   PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
bun      1234  me  12u IPv4 0x1 0t0 TCP *:3000 (LISTEN)
bun      1234  me  13u IPv6 0x2 0t0 TCP *:3000 (LISTEN)
node     5678  me  14u IPv6 0x3 0t0 TCP [::1]:5173 (LISTEN)
python   9999  me  15u IPv4 0x4 0t0 TCP 127.0.0.1:8000 (LISTEN)`;

    expect(parseLsofListeners(output)).toEqual([
      { command: "bun", pid: 1234, port: 3000 },
      { command: "node", pid: 5678, port: 5173 },
      { command: "python", pid: 9999, port: 8000 },
    ]);
  });

  test("ignores headers, malformed rows, and non-listening sockets", () => {
    expect(
      parseLsofListeners(`COMMAND PID USER FD TYPE NAME
bun nope me 1u IPv4 TCP *:3000 (LISTEN)
bun 123 me 2u IPv4 TCP localhost:3000->localhost:4000 (ESTABLISHED)
garbage`),
    ).toEqual([]);
  });

  test("parses cwd field output", () => {
    expect(parseLsofCwd("p123\nfcwd\nn/Users/me/project\n")).toBe(
      "/Users/me/project",
    );
    expect(parseLsofCwd("p123\n")).toBeNull();
  });
});

describe("ps parsing", () => {
  test("parses process groups and terminal ownership", () => {
    expect(parseProcessGroup("  4321\n")).toBe(4321);
    expect(parseProcessGroup("")).toBeNull();
    expect(parseTty(" ttys002\n")).toBe("ttys002");
    expect(parseTty(" ??\n")).toBeNull();
  });

  test("retains only a dedicated process group led by the listener pid", () => {
    expect(dedicatedProcessGroupId(4_321, 4_321)).toBe(4_321);
    expect(dedicatedProcessGroupId(4_321, 1_234)).toBeNull();
    expect(dedicatedProcessGroupId(4_321, null)).toBeNull();
  });
});

describe("async process inspection", () => {
  test("collects stdout without blocking the event loop", async () => {
    let timerRan = false;
    const outputPromise = runTextAsync("/bin/sh", [
      "-c",
      "sleep 0.05; printf async-output",
    ]);
    setTimeout(() => {
      timerRan = true;
    }, 0);

    expect(await outputPromise).toBe("async-output");
    expect(timerRan).toBe(true);
  });

  test("settles spawn errors and preserves useful nonzero-exit stdout", async () => {
    expect(
      await runTextAsync("/definitely/not/a/yado-command", []),
    ).toBeNull();
    expect(
      await runTextAsync("/bin/sh", ["-c", "printf retained; exit 7"]),
    ).toBe("retained");
  });
});

describe("HTTP port probing", () => {
  test("probes both loopback families in parallel and accepts either response", async () => {
    const urls: string[] = [];
    const signals: AbortSignal[] = [];
    let rejectIpv4!: (reason: unknown) => void;
    const ipv4Result = new Promise<Response>((_resolve, reject) => {
      rejectIpv4 = reject;
    });
    const fetchImpl = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      urls.push(String(input));
      if (init?.signal instanceof AbortSignal) {
        signals.push(init.signal);
      }
      return String(input).includes("127.0.0.1")
        ? ipv4Result
        : Promise.resolve(new Response("unavailable", { status: 503 }));
    }) as typeof globalThis.fetch;

    const result = probeHttpPort(5_173, fetchImpl);
    await Promise.resolve();

    expect(urls).toEqual([
      "http://127.0.0.1:5173/",
      "http://[::1]:5173/",
    ]);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);

    rejectIpv4(new Error("IPv4 connection refused"));
    expect(await result).toBe(true);
  });

  test("returns false only when both loopback probes fail", async () => {
    const urls: string[] = [];
    const fetchImpl = ((input: string | URL | Request) => {
      urls.push(String(input));
      return Promise.reject(new Error("connection refused"));
    }) as typeof globalThis.fetch;

    expect(await probeHttpPort(4_321, fetchImpl)).toBe(false);
    expect(urls).toEqual([
      "http://127.0.0.1:4321/",
      "http://[::1]:4321/",
    ]);
  });
});

describe("mDNS address parsing", () => {
  test("finds the default interface", () => {
    expect(
      parseDefaultInterface("gateway: 192.168.1.1\n interface: en0\n"),
    ).toBe("en0");
    expect(parseDefaultInterface("gateway: 192.168.1.1\n")).toBeNull();
  });

  test("rejects link-local and CLAT46 IPv4", () => {
    expect(isUsableIPv4("192.168.1.24")).toBe(true);
    expect(isUsableIPv4("169.254.4.2")).toBe(false);
    expect(isUsableIPv4("192.0.0.2")).toBe(false);
    expect(isUsableIPv4("not-an-address")).toBe(false);
  });

  test("selects an IPv6 GUA and ignores link-local/CLAT46 rows", () => {
    const output = `inet6 fe80::1%en0 prefixlen 64
inet6 240a:61:1::10 prefixlen 64 autoconf secured
inet6 240a:61:1::20 prefixlen 64 clat46`;
    expect(parseGlobalIPv6(output)).toBe("240a:61:1::10");
    expect(parseGlobalIPv6("inet6 fd00::1 prefixlen 64")).toBeNull();
  });
});
