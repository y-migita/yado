import { describe, expect, test } from "bun:test";

import {
  createForwardHeaders,
  createProxyOptions,
  getRequestHost,
  isWebSocketUpgrade,
  parseWebSocketProtocols,
  renderStatusPage,
  renderUnknownHostPage,
  sanitizeWebSocketCloseCode,
  sanitizeWebSocketCloseReason,
  stripHopByHopHeaders,
  type BackendFetch,
  type ProxyWebSocketData,
} from "../src/proxy";
import type { Guest } from "../src/registry";

function guest(overrides: Partial<Guest> = {}): Guest {
  return {
    name: "morimiru",
    port: 43123,
    pid: 1234,
    pgid: 1234,
    path: "/tmp/morimiru",
    cmd: "bun run dev",
    kind: "managed",
    owner: { tty: "ttys001", label: "terminal" },
    startedAt: "2026-07-28T00:00:00.000Z",
    logFile: "/tmp/morimiru.log",
    ...overrides,
  };
}

function fakeServer(
  overrides: Partial<Bun.Server<ProxyWebSocketData>> = {},
): Bun.Server<ProxyWebSocketData> {
  return {
    requestIP: () => null,
    upgrade: () => false,
    ...overrides,
  } as unknown as Bun.Server<ProxyWebSocketData>;
}

class FakeBackendWebSocket extends EventTarget {
  protocol: string;
  binaryType: BinaryType = "blob";
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  constructor(protocol = "") {
    super();
    this.protocol = protocol;
  }

  send(message: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(message);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(message: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }

  remoteClose(code: number, reason: string): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  fail(): void {
    this.dispatchEvent(new Event("error"));
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

function fakeFrontend(bridge: ProxyWebSocketData) {
  const sent: Array<string | ArrayBuffer | Buffer> = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  let readyState: number = WebSocket.OPEN;
  const socket = {
    data: bridge,
    binaryType: "arraybuffer",
    get readyState() {
      return readyState;
    },
    send(message: string | ArrayBuffer | Buffer) {
      sent.push(message);
      return 1;
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
      readyState = WebSocket.CLOSING;
    },
    terminate() {
      readyState = WebSocket.CLOSED;
    },
  } as unknown as Bun.ServerWebSocket<ProxyWebSocketData>;
  return { socket, sent, closes };
}

async function connectedBridge(backend: FakeBackendWebSocket) {
  let bridge: ProxyWebSocketData | null = null;
  const server = fakeServer({
    upgrade(_request, options) {
      bridge = (options as { data: ProxyWebSocketData }).data;
      return true;
    },
  });
  const options = createProxyOptions(
    () => [guest()],
    () => {},
    () => {
      queueMicrotask(() => backend.open());
      return backend.asWebSocket();
    },
  );
  const response = await options.fetch(
    new Request("http://morimiru.local/ws", {
      headers: {
        host: "morimiru.local",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": "vite-hmr",
      },
    }),
    server,
  );
  expect(response).toBeUndefined();
  if (bridge === null) {
    throw new Error("test server did not receive bridge data");
  }
  return { options, bridge: bridge as ProxyWebSocketData };
}

describe("stripHopByHopHeaders", () => {
  test("removes the fixed hop-by-hop set without mutating the input", () => {
    const input = new Headers({
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      "proxy-authenticate": "Basic",
      "proxy-authorization": "Basic abc",
      "proxy-connection": "keep-alive",
      te: "trailers",
      trailer: "Digest",
      "transfer-encoding": "chunked",
      upgrade: "websocket",
      "x-end-to-end": "kept",
    });

    const output = stripHopByHopHeaders(input);

    expect([...output]).toEqual([["x-end-to-end", "kept"]]);
    expect(input.get("connection")).toBe("keep-alive");
    expect(input.get("upgrade")).toBe("websocket");
  });

  test("also removes every header nominated by Connection tokens", () => {
    const output = stripHopByHopHeaders(
      new Headers({
        connection: " X-Remove-One, x-remove-two , Upgrade ",
        "x-remove-one": "one",
        "X-Remove-Two": "two",
        "x-stays": "yes",
      }),
    );

    expect(output.get("x-remove-one")).toBeNull();
    expect(output.get("x-remove-two")).toBeNull();
    expect(output.get("x-stays")).toBe("yes");
    expect(output.get("connection")).toBeNull();
  });
});

describe("createForwardHeaders", () => {
  test("rewrites authority metadata and appends the client to XFF", () => {
    const headers = createForwardHeaders(
      new Headers({
        host: "morimiru.local",
        connection: "keep-alive, x-private-hop",
        "x-private-hop": "remove me",
        "x-forwarded-for": "10.0.0.1",
        cookie: "session=abc",
      }),
      {
        originalHost: "morimiru.local:80",
        clientAddress: "192.168.1.20",
      },
    );

    expect(headers.get("host")).toBeNull();
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("x-private-hop")).toBeNull();
    expect(headers.get("cookie")).toBe("session=abc");
    expect(headers.get("x-forwarded-for")).toBe(
      "10.0.0.1, 192.168.1.20",
    );
    expect(headers.get("x-forwarded-host")).toBe("morimiru.local:80");
    expect(headers.get("x-forwarded-proto")).toBe("http");
  });

  test("removes client handshake fields before Bun creates the upstream WS handshake", () => {
    const headers = createForwardHeaders(
      new Headers({
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "key",
        "sec-websocket-version": "13",
        "sec-websocket-protocol": "vite-hmr",
        "sec-websocket-extensions": "permessage-deflate",
        origin: "http://morimiru.local",
      }),
      {
        originalHost: "morimiru.local",
        clientAddress: null,
        websocket: true,
      },
    );

    expect(headers.get("connection")).toBeNull();
    expect(headers.get("upgrade")).toBeNull();
    expect(headers.get("sec-websocket-key")).toBeNull();
    expect(headers.get("sec-websocket-version")).toBeNull();
    expect(headers.get("sec-websocket-protocol")).toBeNull();
    expect(headers.get("sec-websocket-extensions")).toBeNull();
    expect(headers.get("origin")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
  });

  test("preserves a genuinely cross-origin WebSocket Origin", () => {
    const headers = createForwardHeaders(
      new Headers({ origin: "https://evil.example" }),
      {
        originalHost: "morimiru.local",
        clientAddress: null,
        websocket: true,
      },
    );

    expect(headers.get("origin")).toBe("https://evil.example");
  });
});

describe("WebSocket request parsing", () => {
  test("recognizes case-insensitive Upgrade and a tokenized Connection header", () => {
    const request = new Request("http://morimiru.local/hmr", {
      headers: {
        connection: "keep-alive, UpGrAdE",
        upgrade: "WebSocket",
      },
    });

    expect(isWebSocketUpgrade(request)).toBe(true);
  });

  test("does not treat an Upgrade header without Connection: upgrade as WS", () => {
    const request = new Request("http://morimiru.local/hmr", {
      headers: { upgrade: "websocket" },
    });

    expect(isWebSocketUpgrade(request)).toBe(false);
  });

  test("preserves protocol order while trimming and deduplicating", () => {
    expect(
      parseWebSocketProtocols(" vite-hmr, graphql-ws, vite-hmr "),
    ).toEqual(["vite-hmr", "graphql-ws"]);
    expect(parseWebSocketProtocols(null)).toEqual([]);
  });
});

describe("sanitizeWebSocketCloseCode", () => {
  test("passes through wire-safe standard and application codes", () => {
    for (const code of [1000, 1001, 1002, 1003, 1007, 1011, 1014, 3000, 4999]) {
      expect(sanitizeWebSocketCloseCode(code)).toBe(code);
    }
  });

  test("maps reserved, invalid, and abnormal-only codes to 1011", () => {
    for (const code of [0, 999, 1004, 1005, 1006, 1015, 2999, 5000, NaN]) {
      expect(sanitizeWebSocketCloseCode(code)).toBe(1011);
    }
  });
});

describe("sanitizeWebSocketCloseReason", () => {
  test("limits close reasons to 123 UTF-8 bytes without splitting a character", () => {
    expect(sanitizeWebSocketCloseReason("a".repeat(124))).toBe("a".repeat(123));
    const reason = `${"a".repeat(121)}あ`;
    const sanitized = sanitizeWebSocketCloseReason(reason);
    expect(Buffer.byteLength(sanitized)).toBeLessThanOrEqual(123);
    expect(sanitized).toBe("a".repeat(121));
    expect(sanitizeWebSocketCloseReason("normal")).toBe("normal");
  });
});

describe("upstream loopback fallback", () => {
  test("retries HTTP on IPv6 after an IPv4 connection failure and caches it", async () => {
    const urls: string[] = [];
    const fetchBackend: BackendFetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("127.0.0.1")) {
        throw new Error("IPv4 connection refused");
      }
      return new Response(url.includes("/first") ? "first" : "second");
    };
    const options = createProxyOptions(
      () => [guest()],
      () => {},
      undefined,
      fetchBackend,
    );

    const first = await options.fetch(
      new Request("http://morimiru.local/first?value=1", {
        headers: { host: "morimiru.local" },
      }),
      fakeServer(),
    );
    const second = await options.fetch(
      new Request("http://morimiru.local/second", {
        headers: { host: "morimiru.local" },
      }),
      fakeServer(),
    );

    expect(await first!.text()).toBe("first");
    expect(await second!.text()).toBe("second");
    expect(urls).toEqual([
      "http://127.0.0.1:43123/first?value=1",
      "http://[::1]:43123/first?value=1",
      "http://[::1]:43123/second",
    ]);
  });

  test("preserves a request body for the HTTP fallback attempt", async () => {
    const bodies: string[] = [];
    const fetchBackend: BackendFetch = async (input, init) => {
      bodies.push(await new Response(init?.body as BodyInit).text());
      if (String(input).includes("127.0.0.1")) {
        throw new Error("IPv4 connection refused");
      }
      return new Response("ok");
    };
    const options = createProxyOptions(
      () => [guest()],
      () => {},
      undefined,
      fetchBackend,
    );

    const response = await options.fetch(
      new Request("http://morimiru.local/submit", {
        method: "POST",
        headers: { host: "morimiru.local" },
        body: "payload",
      }),
      fakeServer(),
    );

    expect(response?.status).toBe(200);
    expect(bodies).toEqual(["payload", "payload"]);
  });

  test("does not retry HTTP responses with error status codes", async () => {
    const urls: string[] = [];
    const fetchBackend: BackendFetch = async (input) => {
      urls.push(String(input));
      return new Response("backend unavailable", { status: 503 });
    };
    const options = createProxyOptions(
      () => [guest()],
      () => {},
      undefined,
      fetchBackend,
    );

    const response = await options.fetch(
      new Request("http://morimiru.local/", {
        headers: { host: "morimiru.local" },
      }),
      fakeServer(),
    );

    expect(response?.status).toBe(503);
    expect(await response!.text()).toBe("backend unavailable");
    expect(urls).toEqual(["http://127.0.0.1:43123/"]);
  });

  test("retries WebSocket before open and caches the successful family", async () => {
    const urls: string[] = [];
    const sockets: FakeBackendWebSocket[] = [];
    const createWebSocket = (url: string): WebSocket => {
      const socket = new FakeBackendWebSocket("vite-hmr");
      urls.push(url);
      sockets.push(socket);
      queueMicrotask(() => {
        if (url.includes("127.0.0.1")) {
          socket.fail();
        } else {
          socket.open();
        }
      });
      return socket.asWebSocket();
    };
    const options = createProxyOptions(
      () => [guest()],
      () => {},
      createWebSocket,
    );
    const server = fakeServer({ upgrade: () => true });
    const request = () =>
      new Request("http://morimiru.local/@vite/client", {
        headers: {
          host: "morimiru.local",
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-protocol": "vite-hmr",
        },
      });

    expect(await options.fetch(request(), server)).toBeUndefined();
    expect(urls).toEqual([
      "ws://127.0.0.1:43123/@vite/client",
      "ws://[::1]:43123/@vite/client",
    ]);

    sockets[1]!.fail();
    expect(urls).toHaveLength(2);

    expect(await options.fetch(request(), server)).toBeUndefined();
    expect(urls).toEqual([
      "ws://127.0.0.1:43123/@vite/client",
      "ws://[::1]:43123/@vite/client",
      "ws://[::1]:43123/@vite/client",
    ]);
  });

  test("shares a successful HTTP family with WebSocket connections", async () => {
    const websocketUrls: string[] = [];
    const fetchBackend: BackendFetch = async (input) => {
      if (String(input).includes("127.0.0.1")) {
        throw new Error("IPv4 connection refused");
      }
      return new Response("ok");
    };
    const createWebSocket = (url: string): WebSocket => {
      websocketUrls.push(url);
      const socket = new FakeBackendWebSocket();
      queueMicrotask(() => socket.open());
      return socket.asWebSocket();
    };
    const options = createProxyOptions(
      () => [guest()],
      () => {},
      createWebSocket,
      fetchBackend,
    );

    await options.fetch(
      new Request("http://morimiru.local/", {
        headers: { host: "morimiru.local" },
      }),
      fakeServer(),
    );
    await options.fetch(
      new Request("http://morimiru.local/ws", {
        headers: {
          host: "morimiru.local",
          connection: "Upgrade",
          upgrade: "websocket",
        },
      }),
      fakeServer({ upgrade: () => true }),
    );

    expect(websocketUrls).toEqual(["ws://[::1]:43123/ws"]);
  });
});

describe("Host routing and HTML responses", () => {
  test("prefers the actual Host header over the Request URL authority", () => {
    const request = new Request("http://fallback.invalid/", {
      headers: { host: "MORIMIRU.local:80" },
    });
    expect(getRequestHost(request)).toBe("MORIMIRU.local:80");
  });

  test("serves the yado.local status page without external assets", async () => {
    const options = createProxyOptions(() => [guest()]);
    const response = await options.fetch(
      new Request("http://irrelevant.invalid/", {
        headers: { host: "YADO.LOCAL:80" },
      }),
      fakeServer(),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    const body = await response!.text();
    expect(body).toContain("http://morimiru.local/");
    expect(body).not.toMatch(/<(?:script|link)\b/i);
  });

  test("returns 404 with escaped unknown Host and current Guest links", async () => {
    const options = createProxyOptions(() => [guest()]);
    const response = await options.fetch(
      new Request("http://irrelevant.invalid/", {
        headers: { host: "<unknown>.local" },
      }),
      fakeServer(),
    );

    expect(response?.status).toBe(404);
    const body = await response!.text();
    expect(body).toContain("&lt;unknown&gt;.local");
    expect(body).not.toContain("<unknown>");
    expect(body).toContain("http://morimiru.local/");
  });

  test("resolves a Guest and returns the protocol selected by the upstream", async () => {
    let upgradeOptions:
      | { data: ProxyWebSocketData; headers?: HeadersInit }
      | undefined;
    let offeredProtocols: string[] = [];
    const createWebSocket = (
      _url: string,
      options: Bun.WebSocketOptions,
    ): WebSocket => {
      const offeredOptions = options as {
        protocols?: string | string[];
        protocol?: string;
      };
      const offered = offeredOptions.protocols ?? offeredOptions.protocol;
      offeredProtocols =
        offered === undefined
          ? []
          : typeof offered === "string"
            ? [offered]
            : [...offered];
      const socket = new EventTarget() as WebSocket;
      let readyState: number = WebSocket.CONNECTING;
      Object.defineProperties(socket, {
        protocol: { get: () => "fallback" },
        readyState: { get: () => readyState },
        bufferedAmount: { get: () => 0 },
        binaryType: { value: "blob", writable: true },
        send: { value: () => undefined },
        close: {
          value: () => {
            readyState = WebSocket.CLOSED;
          },
        },
      });
      queueMicrotask(() => {
        readyState = WebSocket.OPEN;
        socket.dispatchEvent(new Event("open"));
      });
      return socket;
    };
    const server = fakeServer({
      upgrade(_request, options) {
        upgradeOptions = options as {
          data: ProxyWebSocketData;
          headers?: HeadersInit;
        };
        return false;
      },
    });
    const options = createProxyOptions(
      async () => [guest()],
      () => {},
      createWebSocket,
    );
    const response = await options.fetch(
      new Request("http://irrelevant.invalid/@vite/client", {
        headers: {
          host: "MORIMIRU.LOCAL:80",
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-protocol": "vite-hmr, fallback",
        },
      }),
      server,
    );

    expect(response?.status).toBe(400);
    expect(offeredProtocols).toEqual(["vite-hmr", "fallback"]);
    expect(upgradeOptions?.data.downstreamProtocol).toBe("fallback");
    expect(new Headers(upgradeOptions?.headers).get("sec-websocket-protocol")).toBe(
      "fallback",
    );
  });

  test("escapes registry-controlled values in both HTML templates", () => {
    const hostile = guest({
      owner: { tty: null, label: "<script>alert(1)</script>" },
      path: "/tmp/<img src=x>",
    });

    expect(renderStatusPage([hostile])).not.toContain("<script>alert(1)</script>");
    expect(renderStatusPage([hostile])).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(renderUnknownHostPage("<bad>", [hostile])).toContain(
      "&lt;bad&gt;",
    );
  });
});

test("createProxyOptions disables the Bun server-side WS idle timeout", () => {
  expect(createProxyOptions(() => []).websocket.idleTimeout).toBe(0);
});

describe("WebSocket lifecycle propagation", () => {
  test("forwards frontend text/binary and close to the backend", async () => {
    const backend = new FakeBackendWebSocket("vite-hmr");
    const { options, bridge } = await connectedBridge(backend);
    const frontend = fakeFrontend(bridge);
    options.websocket.open!(frontend.socket);

    options.websocket.message(frontend.socket, "hello");
    options.websocket.message(frontend.socket, Buffer.from([1, 2, 3]));
    expect(backend.sent[0]).toBe("hello");
    expect(new Uint8Array(backend.sent[1] as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    options.websocket.close!(frontend.socket, 4_002, "frontend-close");
    expect(backend.closes).toEqual([
      { code: 4_002, reason: "frontend-close" },
    ]);
  });

  test("forwards backend messages, close, and error to the frontend", async () => {
    const backend = new FakeBackendWebSocket("vite-hmr");
    const first = await connectedBridge(backend);
    const frontend = fakeFrontend(first.bridge);
    first.options.websocket.open!(frontend.socket);
    backend.receive("update");
    backend.receive(new Uint8Array([4, 5]).buffer);
    expect(frontend.sent).toEqual([
      "update",
      new Uint8Array([4, 5]).buffer,
    ]);
    backend.remoteClose(4_001, "backend-close");
    expect(frontend.closes).toEqual([
      { code: 4_001, reason: "backend-close" },
    ]);

    const failingBackend = new FakeBackendWebSocket("vite-hmr");
    const second = await connectedBridge(failingBackend);
    const failingFrontend = fakeFrontend(second.bridge);
    second.options.websocket.open!(failingFrontend.socket);
    failingBackend.fail();
    expect(failingFrontend.closes[0]?.code).toBe(1_011);
  });

  test("forwards a frontend transport error to the backend", async () => {
    const backend = new FakeBackendWebSocket("vite-hmr");
    const { options, bridge } = await connectedBridge(backend);
    const frontend = fakeFrontend(bridge);
    options.websocket.open!(frontend.socket);

    options.websocket.error(frontend.socket, new Error("downstream failed"));
    expect(backend.closes[0]?.code).toBe(1_011);
    expect(backend.closes[0]?.reason).toContain("downstream failed");
  });
});
