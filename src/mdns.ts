import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const ROUTE = "/sbin/route";
const IPCONFIG = "/usr/sbin/ipconfig";
const IFCONFIG = "/sbin/ifconfig";
const DNS_SD = "/usr/bin/dns-sd";

export type MdnsLogger = (message: string) => void;
type CommandText = (command: string, args: string[]) => string;

export function parseDefaultInterface(output: string): string | null {
  return output.match(/^\s*interface:\s*(\S+)\s*$/m)?.[1] ?? null;
}

export function isUsableIPv4(address: string): boolean {
  const octets = address.trim().split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  return !(octets[0] === 169 && octets[1] === 254) &&
    !(octets[0] === 192 && octets[1] === 0 && octets[2] === 0);
}

export function parseGlobalIPv6(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    if (/\bclat46\b/i.test(line)) {
      continue;
    }
    const address = line.match(/^\s*inet6\s+([0-9a-f:]+)(?:%\S+)?(?:\s|$)/i)?.[1];
    if (!address) {
      continue;
    }
    const firstHextet = Number.parseInt(address.split(":")[0] ?? "", 16);
    if (firstHextet >= 0x2000 && firstHextet <= 0x3fff) {
      return address;
    }
  }
  return null;
}

function commandText(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout);
}

export function getAdvertisingAddress(
  runCommand: CommandText = commandText,
): string {
  let ipv4Interface: string | null = null;
  let ipv4RouteFailure: unknown = null;
  try {
    ipv4Interface = requireDefaultInterface(
      runCommand(ROUTE, ["-n", "get", "default"]),
    );
  } catch (error) {
    ipv4RouteFailure = error;
  }

  if (ipv4Interface) {
    let ipv4 = "";
    try {
      ipv4 = runCommand(IPCONFIG, ["getifaddr", ipv4Interface]).trim();
    } catch {
      // An interface without IPv4 is expected on IPv6-only networks.
    }
    if (isUsableIPv4(ipv4)) {
      return ipv4;
    }
  }

  let ipv6Interface: string | null = null;
  let ipv6RouteFailure: unknown = null;
  try {
    ipv6Interface = requireDefaultInterface(
      runCommand(ROUTE, ["-n", "get", "-inet6", "default"]),
    );
  } catch (error) {
    ipv6RouteFailure = error;
  }

  if (ipv6Interface) {
    if (!ipv4Interface) {
      let ipv4 = "";
      try {
        ipv4 = runCommand(IPCONFIG, ["getifaddr", ipv6Interface]).trim();
      } catch {
        // Preserve a usable IPv4 address on an IPv6-only route lookup path.
      }
      if (isUsableIPv4(ipv4)) {
        return ipv4;
      }
    }

    let ipv6 = "";
    try {
      ipv6 = parseGlobalIPv6(runCommand(IFCONFIG, [ipv6Interface])) ?? "";
    } catch (error) {
      throw new Error(
        `failed to inspect IPv6 default interface ${ipv6Interface}: ${errorMessage(error)}`,
      );
    }
    if (ipv6) {
      return ipv6;
    }
    throw new Error(
      `no IPv6 GUA was found on IPv6 default interface ${ipv6Interface}`,
    );
  }

  // Some networks expose IPv6 addresses on the IPv4 default-route interface
  // without installing a separate IPv6 default route.
  if (ipv4Interface) {
    try {
      const ipv6 = parseGlobalIPv6(runCommand(IFCONFIG, [ipv4Interface]));
      if (ipv6) {
        return ipv6;
      }
    } catch {
      // The combined diagnostic below is more useful than the raw ifconfig error.
    }
    throw new Error(
      `no usable IPv4 or IPv6 GUA was found on default interface ${ipv4Interface} (IPv6 route: ${errorMessage(ipv6RouteFailure)})`,
    );
  }

  throw new Error(
    `default route interface was not found (IPv4: ${errorMessage(ipv4RouteFailure)}; IPv6: ${errorMessage(ipv6RouteFailure)})`,
  );
}

function requireDefaultInterface(output: string): string {
  const interfaceName = parseDefaultInterface(output);
  if (!interfaceName) {
    throw new Error("response did not contain an interface");
  }
  return interfaceName;
}

type Advertisement = {
  child: ChildProcess;
  intentional: boolean;
  closed: Promise<void>;
  resolveClosed: () => void;
  termination: Promise<void> | null;
};

type SpawnDnsSd = (
  command: string,
  args: string[],
  options: { stdio: "ignore" },
) => ChildProcess;

export interface MdnsSupervisorOptions {
  getAddress?: () => string;
  spawnProcess?: SpawnDnsSd;
  refreshIntervalMs?: number;
  restartDelayMs?: number;
  terminationGraceMs?: number;
}

export class MdnsSupervisor {
  readonly #desired = new Set<string>();
  readonly #children = new Map<string, Advertisement>();
  readonly #restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #log: MdnsLogger;
  readonly #getAddress: () => string;
  readonly #spawnProcess: SpawnDnsSd;
  readonly #refreshIntervalMs: number;
  readonly #restartDelayMs: number;
  readonly #terminationGraceMs: number;
  #address: string | null = null;
  #refreshTimer: ReturnType<typeof setInterval> | null = null;
  #stopping = false;

  constructor(
    log: MdnsLogger = () => {},
    options: MdnsSupervisorOptions = {},
  ) {
    this.#log = log;
    this.#getAddress = options.getAddress ?? getAdvertisingAddress;
    this.#spawnProcess =
      options.spawnProcess ??
      ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.#refreshIntervalMs = options.refreshIntervalMs ?? 15_000;
    this.#restartDelayMs = options.restartDelayMs ?? 1_000;
    this.#terminationGraceMs = options.terminationGraceMs ?? 1_000;
  }

  get address(): string | null {
    return this.#address;
  }

  async start(names: Iterable<string>): Promise<void> {
    this.#address = this.#getAddress();
    for (const name of names) {
      this.#desired.add(name);
    }
    for (const name of this.#desired) {
      this.#spawn(name);
    }
    this.#refreshTimer = setInterval(() => {
      void this.#refreshAddress();
    }, this.#refreshIntervalMs);
  }

  advertise(name: string): void {
    this.#desired.add(name);
    if (this.#address && !this.#children.has(name)) {
      this.#spawn(name);
    }
  }

  async withdraw(name: string): Promise<void> {
    this.#desired.delete(name);
    const restartTimer = this.#restartTimers.get(name);
    if (restartTimer) {
      clearTimeout(restartTimer);
      this.#restartTimers.delete(name);
    }
    await this.#stopChild(name);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#refreshTimer) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    for (const timer of this.#restartTimers.values()) {
      clearTimeout(timer);
    }
    this.#restartTimers.clear();
    await Promise.all(
      [...this.#children.keys()].map((name) => this.#stopChild(name)),
    );
    this.#desired.clear();
  }

  async #refreshAddress(): Promise<void> {
    if (this.#stopping) {
      return;
    }
    try {
      const nextAddress = this.#getAddress();
      if (nextAddress === this.#address) {
        return;
      }
      this.#log(`mDNS address changed: ${this.#address ?? "(none)"} -> ${nextAddress}`);
      this.#address = nextAddress;
      for (const timer of this.#restartTimers.values()) {
        clearTimeout(timer);
      }
      this.#restartTimers.clear();
      await Promise.all(
        [...this.#children.keys()].map((name) => this.#stopChild(name)),
      );
      if (this.#stopping) {
        return;
      }
      for (const name of this.#desired) {
        this.#spawn(name);
      }
    } catch (error) {
      this.#log(`mDNS address refresh failed: ${errorMessage(error)}`);
    }
  }

  #spawn(name: string): void {
    if (
      this.#stopping ||
      !this.#address ||
      !this.#desired.has(name) ||
      this.#children.has(name)
    ) {
      return;
    }
    const pendingRestart = this.#restartTimers.get(name);
    if (pendingRestart) {
      clearTimeout(pendingRestart);
      this.#restartTimers.delete(name);
    }

    let child: ChildProcess;
    try {
      child = this.#spawnProcess(
        DNS_SD,
        ["-P", name, "_http._tcp", "local", "80", `${name}.local`, this.#address],
        { stdio: "ignore" },
      );
    } catch (error) {
      this.#log(`dns-sd ${name} spawn failed: ${errorMessage(error)}`);
      this.#scheduleRestart(name);
      return;
    }

    let resolveClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const advertisement: Advertisement = {
      child,
      intentional: false,
      closed,
      resolveClosed,
      termination: null,
    };
    this.#children.set(name, advertisement);
    this.#log(`mDNS advertised: ${name}.local -> ${this.#address}:80`);

    child.once("error", (error) => {
      this.#log(`dns-sd ${name} error: ${error.message}`);
    });
    child.once("close", (code, signal) => {
      advertisement.resolveClosed();
      if (this.#children.get(name) !== advertisement) {
        return;
      }
      this.#children.delete(name);
      if (advertisement.intentional || this.#stopping || !this.#desired.has(name)) {
        return;
      }
      this.#log(
        `dns-sd ${name} exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}); restarting`,
      );
      this.#scheduleRestart(name);
    });
  }

  #scheduleRestart(name: string): void {
    if (
      this.#stopping ||
      !this.#address ||
      !this.#desired.has(name) ||
      this.#restartTimers.has(name)
    ) {
      return;
    }
    const timer = setTimeout(() => {
      this.#restartTimers.delete(name);
      this.#spawn(name);
    }, this.#restartDelayMs);
    this.#restartTimers.set(name, timer);
  }

  async #stopChild(name: string): Promise<void> {
    const advertisement = this.#children.get(name);
    if (!advertisement) {
      return;
    }
    advertisement.intentional = true;
    if (advertisement.termination) {
      return advertisement.termination;
    }

    advertisement.termination = this.#terminateChild(name, advertisement);
    await advertisement.termination;
  }

  async #terminateChild(
    name: string,
    advertisement: Advertisement,
  ): Promise<void> {
    signalChild(advertisement.child, "SIGTERM", (error) => {
      this.#log(`dns-sd ${name} SIGTERM failed: ${errorMessage(error)}`);
    });
    if (
      await settlesWithin(advertisement.closed, this.#terminationGraceMs)
    ) {
      return;
    }

    this.#log(`dns-sd ${name} did not stop after SIGTERM; sending SIGKILL`);
    signalChild(advertisement.child, "SIGKILL", (error) => {
      this.#log(`dns-sd ${name} SIGKILL failed: ${errorMessage(error)}`);
    });
    await advertisement.closed;
  }
}

function signalChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  onError: (error: unknown) => void,
): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill(signal);
  } catch (error) {
    onError(error);
  }
}

async function settlesWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = promise.then(() => true as const);
  const result = await Promise.race([settled, timedOut]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
