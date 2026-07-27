import { describe, expect, test } from "bun:test";

import {
  type AdvertiserProcess,
  getAdvertisingAddress,
  MdnsSupervisor,
  type MdnsSupervisorOptions,
  parseOrphanedAdvertiserPids,
  sweepOrphanedAdvertisers,
} from "../src/mdns";

class FakeChild implements AdvertiserProcess {
  readonly pid = 4242;
  readonly signals: Array<NodeJS.Signals | number> = [];
  readonly exited: Promise<number>;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  onKill: ((signal: NodeJS.Signals | number) => void) | null = null;
  #resolveExited!: (code: number) => void;

  constructor() {
    this.exited = new Promise<number>((resolve) => {
      this.#resolveExited = resolve;
    });
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): void {
    this.signals.push(signal);
    this.onKill?.(signal);
  }

  close(
    code: number | null = null,
    signal: NodeJS.Signals | null = null,
  ): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.#resolveExited(code ?? 0);
  }
}

function makeSupervisor(
  children: FakeChild[],
  overrides: Partial<MdnsSupervisorOptions> = {},
  logs: string[] = [],
): MdnsSupervisor {
  return new MdnsSupervisor((message) => logs.push(message), {
    getAddress: () => "192.168.1.24",
    refreshIntervalMs: 60_000,
    restartDelayMs: 5,
    terminationGraceMs: 5,
    spawnProcess: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    ...overrides,
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 300,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for test condition");
    }
    await Bun.sleep(2);
  }
}

describe("parseOrphanedAdvertiserPids", () => {
  const psOutput = [
    "  123     1 /usr/bin/dns-sd -P yado _http._tcp local 80 yado.local 240a:61:220b:7b13::1",
    "  456 98519 /usr/bin/dns-sd -P yado _http._tcp local 80 yado.local 240a:61:11b:eaa::1",
    "  789     1 /usr/bin/dns-sd -P my-app _http._tcp local 80 my-app.local 192.168.1.24",
    " 1000     1 /usr/bin/dns-sd -B _http._tcp local",
    " 2000     1 /usr/local/bin/other-tool dns-sd -P x _http._tcp local 80 x.local 1.2.3.4",
  ].join("\n");

  test("selects only launchd-reparented yado advertisements", () => {
    expect(parseOrphanedAdvertiserPids(psOutput)).toEqual([123, 789]);
  });

  test("returns an empty list when nothing matches", () => {
    expect(parseOrphanedAdvertiserPids("  1  0 /sbin/launchd\n")).toEqual([]);
  });
});

describe("sweepOrphanedAdvertisers", () => {
  test("kills each orphan and logs the sweep", () => {
    const killed: number[] = [];
    const logs: string[] = [];
    sweepOrphanedAdvertisers(
      (message) => logs.push(message),
      () =>
        "  123     1 /usr/bin/dns-sd -P yado _http._tcp local 80 yado.local 1.2.3.4\n",
      (pid) => killed.push(pid),
    );
    expect(killed).toEqual([123]);
    expect(logs).toEqual(["killed orphaned dns-sd advertiser (pid 123)"]);
  });

  test("survives a ps failure and a kill on an exited process", () => {
    const logs: string[] = [];
    sweepOrphanedAdvertisers(
      (message) => logs.push(message),
      () => {
        throw new Error("ps unavailable");
      },
      () => {
        throw new Error("kill should not be called");
      },
    );
    expect(logs).toEqual(["orphaned dns-sd sweep failed: ps unavailable"]);

    sweepOrphanedAdvertisers(
      (message) => logs.push(message),
      () =>
        "  123     1 /usr/bin/dns-sd -P yado _http._tcp local 80 yado.local 1.2.3.4\n",
      () => {
        const error = new Error("no such process") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      },
    );
    expect(logs).toEqual(["orphaned dns-sd sweep failed: ps unavailable"]);
  });
});

describe("getAdvertisingAddress", () => {
  test("uses the IPv4 default route when it is available", () => {
    const calls: string[] = [];
    const address = getAdvertisingAddress((command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "/sbin/route") {
        return "interface: en0\n";
      }
      if (command === "/usr/sbin/ipconfig") {
        return "192.168.1.24\n";
      }
      throw new Error(`unexpected command: ${command}`);
    });

    expect(address).toBe("192.168.1.24");
    expect(calls).toEqual([
      "/sbin/route -n get default",
      "/usr/sbin/ipconfig getifaddr en0",
    ]);
  });

  test("looks up the IPv6 default route when the IPv4 lookup fails", () => {
    const calls: string[] = [];
    const address = getAdvertisingAddress((command, args) => {
      const invocation = `${command} ${args.join(" ")}`;
      calls.push(invocation);
      if (invocation === "/sbin/route -n get default") {
        throw new Error("not in table");
      }
      if (invocation === "/sbin/route -n get -inet6 default") {
        return "interface: en7\n";
      }
      if (command === "/usr/sbin/ipconfig") {
        throw new Error("no IPv4");
      }
      if (command === "/sbin/ifconfig") {
        return "inet6 240a:61:1::10 prefixlen 64 autoconf secured\n";
      }
      throw new Error(`unexpected command: ${invocation}`);
    });

    expect(address).toBe("240a:61:1::10");
    expect(calls).toEqual([
      "/sbin/route -n get default",
      "/sbin/route -n get -inet6 default",
      "/usr/sbin/ipconfig getifaddr en7",
      "/sbin/ifconfig en7",
    ]);
  });

  test("uses the IPv6 default route when IPv4 default address is unusable", () => {
    const calls: string[] = [];
    const address = getAdvertisingAddress((command, args) => {
      const invocation = `${command} ${args.join(" ")}`;
      calls.push(invocation);
      if (invocation === "/sbin/route -n get default") {
        return "interface: en0\n";
      }
      if (invocation === "/usr/sbin/ipconfig getifaddr en0") {
        return "192.0.0.7\n";
      }
      if (invocation === "/sbin/route -n get -inet6 default") {
        return "interface: en7\n";
      }
      if (invocation === "/sbin/ifconfig en7") {
        return "inet6 240a:61:1::10 prefixlen 64 autoconf secured\n";
      }
      throw new Error(`unexpected command: ${invocation}`);
    });

    expect(address).toBe("240a:61:1::10");
    expect(calls).toEqual([
      "/sbin/route -n get default",
      "/usr/sbin/ipconfig getifaddr en0",
      "/sbin/route -n get -inet6 default",
      "/sbin/ifconfig en7",
    ]);
  });

  test("also falls back when an IPv4 route response has no interface", () => {
    const address = getAdvertisingAddress((command, args) => {
      const invocation = `${command} ${args.join(" ")}`;
      if (invocation === "/sbin/route -n get default") {
        return "gateway: 192.168.1.1\n";
      }
      if (invocation === "/sbin/route -n get -inet6 default") {
        return "interface: en9\n";
      }
      if (command === "/usr/sbin/ipconfig") {
        return "";
      }
      if (command === "/sbin/ifconfig") {
        return "inet6 2001:db8::10 prefixlen 64\n";
      }
      throw new Error(`unexpected command: ${invocation}`);
    });

    expect(address).toBe("2001:db8::10");
  });
});

describe("MdnsSupervisor child lifecycle", () => {
  test("uses the exact dns-sd -P advertisement arguments", async () => {
    const children: FakeChild[] = [];
    let invocation:
      | { command: string; args: string[]; stdio: string }
      | undefined;
    const supervisor = makeSupervisor(children, {
      spawnProcess: (command, args, options) => {
        invocation = { command, args, stdio: options.stdio };
        const child = new FakeChild();
        child.onKill = () => {
          queueMicrotask(() => child.close(null, "SIGTERM"));
        };
        children.push(child);
        return child;
      },
    });

    await supervisor.start(["guest"]);
    expect(invocation).toEqual({
      command: "/usr/bin/dns-sd",
      args: [
        "-P",
        "guest",
        "_http._tcp",
        "local",
        "80",
        "guest.local",
        "192.168.1.24",
      ],
      stdio: "ignore",
    });
    await supervisor.stop();
  });

  test("withdraw waits for the dns-sd close event", async () => {
    const children: FakeChild[] = [];
    const supervisor = makeSupervisor(children);
    await supervisor.start(["guest"]);

    let settled = false;
    const withdrawing = supervisor.withdraw("guest").then(() => {
      settled = true;
    });
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
    await Bun.sleep(1);
    expect(settled).toBe(false);

    children[0]?.close(null, "SIGTERM");
    await withdrawing;
    expect(settled).toBe(true);
    await supervisor.stop();
  });

  test("uses SIGKILL after a bounded SIGTERM grace period", async () => {
    const children: FakeChild[] = [];
    const supervisor = makeSupervisor(children);
    await supervisor.start(["guest"]);
    children[0]!.onKill = (signal) => {
      if (signal === "SIGKILL") {
        queueMicrotask(() => children[0]?.close(null, "SIGKILL"));
      }
    };

    await supervisor.withdraw("guest");

    expect(children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await supervisor.stop();
  });

  test("stop waits for every advertised child to close", async () => {
    const children: FakeChild[] = [];
    const supervisor = makeSupervisor(children, {
      terminationGraceMs: 200,
    });
    await supervisor.start(["one", "two"]);

    let settled = false;
    const stopping = supervisor.stop().then(() => {
      settled = true;
    });
    expect(children.map((child) => child.signals)).toEqual([
      ["SIGTERM"],
      ["SIGTERM"],
    ]);
    children[0]?.close(null, "SIGTERM");
    await Bun.sleep(1);
    expect(settled).toBe(false);

    children[1]?.close(null, "SIGTERM");
    await stopping;
    expect(settled).toBe(true);
  });

  test("address refresh does not replace a child before it closes", async () => {
    const children: FakeChild[] = [];
    let address = "192.168.1.24";
    const supervisor = makeSupervisor(children, {
      getAddress: () => address,
      refreshIntervalMs: 5,
      terminationGraceMs: 200,
    });
    await supervisor.start(["guest"]);
    address = "192.168.1.25";

    await waitFor(() => children[0]?.signals[0] === "SIGTERM");
    expect(children).toHaveLength(1);
    children[0]?.close(null, "SIGTERM");
    await waitFor(() => children.length === 2);

    children[1]!.onKill = () => {
      queueMicrotask(() => children[1]?.close(null, "SIGTERM"));
    };
    await supervisor.stop();
  });

  test("an unexpected exit schedules exactly one restart", async () => {
    const children: FakeChild[] = [];
    const logs: string[] = [];
    const supervisor = makeSupervisor(children, {}, logs);
    await supervisor.start(["guest"]);

    children[0]?.close(1, null);
    await waitFor(() => children.length === 2);
    await Bun.sleep(15);
    expect(children).toHaveLength(2);
    expect(
      logs.filter(
        (line) =>
          line ===
          "dns-sd guest exited unexpectedly (code=1, signal=null); restarting",
      ),
    ).toHaveLength(1);

    children[1]!.onKill = () => {
      queueMicrotask(() => children[1]?.close(null, "SIGTERM"));
    };
    await supervisor.stop();
  });

  test("a synchronous spawn failure is retried without escaping start", async () => {
    const children: FakeChild[] = [];
    const logs: string[] = [];
    let attempts = 0;
    const supervisor = makeSupervisor(
      children,
      {
        spawnProcess: () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("synchronous spawn failure");
          }
          const child = new FakeChild();
          child.onKill = () => {
            queueMicrotask(() => child.close(null, "SIGTERM"));
          };
          children.push(child);
          return child;
        },
      },
      logs,
    );

    await expect(supervisor.start(["guest"])).resolves.toBeUndefined();
    await waitFor(() => attempts === 2);
    expect(children).toHaveLength(1);
    expect(logs).toContain(
      "dns-sd guest spawn failed: synchronous spawn failure",
    );
    await supervisor.stop();
  });
});
