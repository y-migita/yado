import type { Guest } from "./registry";
import { resolveHost } from "./util";

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

const WEBSOCKET_HANDSHAKE_HEADERS = [
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
] as const;

const OPEN = 1;
const CLOSING = 2;
const INTERNAL_ERROR_CLOSE_CODE = 1011;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const UPSTREAM_CONNECT_TIMEOUT_MS = 5_000;
const IPV4_LOOPBACK = "127.0.0.1";
const IPV6_LOOPBACK = "[::1]";

type MaybePromise<T> = T | Promise<T>;
type BridgeMessage = string | ArrayBuffer;
type LoopbackHost = typeof IPV4_LOOPBACK | typeof IPV6_LOOPBACK;
type BunWebSocketConstructor = new (
  url: string | URL,
  options: Bun.WebSocketOptions,
) => WebSocket;
export type BackendWebSocketFactory = (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;
export type BackendFetch = (
  input: string | URL | Request,
  init?: BunFetchRequestInit,
) => Promise<Response>;

// lib.dom's global constructor declaration does not expose Bun's options
// overload even though Bun implements it at runtime and in Bun.WebSocketOptions.
const BunWebSocketClient = WebSocket as unknown as BunWebSocketConstructor;
const createBackendWebSocket: BackendWebSocketFactory = (url, options) =>
  new BunWebSocketClient(url, options);
const defaultBackendFetch: BackendFetch = (input, init) => fetch(input, init);

export type ProxyLogger = (message: string) => void;
export type GuestProvider = () => MaybePromise<readonly Guest[]>;

export interface ForwardHeaderOptions {
  originalHost: string;
  clientAddress: string | null;
  websocket?: boolean;
}

interface PendingClose {
  code: number;
  reason: string;
}

interface BackendTarget {
  host: LoopbackHost;
  url: string;
}

type BackendConnectResult =
  | { kind: "connected" }
  | { kind: "retryable-failure"; reason: string }
  | { kind: "aborted"; reason: string };

export interface ProxyWebSocketData {
  backend: WebSocket | null;
  frontend: Bun.ServerWebSocket<ProxyWebSocketData> | null;
  pendingToBackend: BridgeMessage[];
  pendingToFrontend: BridgeMessage[];
  pendingToBackendBytes: number;
  pendingToFrontendBytes: number;
  downstreamProtocol: string | null;
  pendingFrontendClose: PendingClose | null;
  finished: boolean;
  log: ProxyLogger;
}

function connectionHeaderTokens(headers: Headers): string[] {
  return (headers.get("connection") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

function alternateLoopback(host: LoopbackHost): LoopbackHost {
  return host === IPV4_LOOPBACK ? IPV6_LOOPBACK : IPV4_LOOPBACK;
}

function cachedLoopback(
  cache: Map<string, LoopbackHost>,
  guestName: string,
): LoopbackHost {
  const cached = cache.get(guestName);
  if (cached !== undefined) {
    return cached;
  }
  cache.set(guestName, IPV4_LOOPBACK);
  return IPV4_LOOPBACK;
}

/**
 * Remove both the standard hop-by-hop headers and extension headers named by
 * the incoming Connection header. The input Headers object is not mutated.
 */
export function stripHopByHopHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  const connectionTokens = connectionHeaderTokens(headers);

  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }
  for (const header of connectionTokens) {
    headers.delete(header);
  }

  return headers;
}

export function createForwardHeaders(
  input: Headers,
  options: ForwardHeaderOptions,
): Headers {
  const headers = stripHopByHopHeaders(input);

  // The upstream authority is a loopback address plus the Guest port. Let
  // fetch/WebSocket synthesize Host and preserve the public host in XFHost.
  headers.delete("host");

  if (options.websocket) {
    for (const header of WEBSOCKET_HANDSHAKE_HEADERS) {
      headers.delete(header);
    }
    // Next.js rejects the browser's public <name>.local Origin when the
    // upstream authority is loopback. Remove only that same public origin;
    // preserve genuinely cross-origin values for the backend's CSWSH policy.
    const origin = headers.get("origin");
    if (origin !== null) {
      try {
        const publicOrigin = new URL(`http://${options.originalHost}`).origin;
        if (new URL(origin).origin === publicOrigin) {
          headers.delete("origin");
        }
      } catch {
        // Preserve malformed/opaque origins so the backend can reject them.
      }
    }
  }

  const existingForwardedFor = headers.get("x-forwarded-for");
  if (options.clientAddress !== null) {
    headers.set(
      "x-forwarded-for",
      existingForwardedFor === null || existingForwardedFor.length === 0
        ? options.clientAddress
        : `${existingForwardedFor}, ${options.clientAddress}`,
    );
  }
  headers.set("x-forwarded-host", options.originalHost);
  headers.set("x-forwarded-proto", "http");

  return headers;
}

export function parseWebSocketProtocols(value: string | null): string[] {
  if (value === null) {
    return [];
  }

  const seen = new Set<string>();
  const protocols: string[] = [];
  for (const part of value.split(",")) {
    const protocol = part.trim();
    if (protocol.length > 0 && !seen.has(protocol)) {
      seen.add(protocol);
      protocols.push(protocol);
    }
  }
  return protocols;
}

export function isWebSocketUpgrade(request: Request): boolean {
  if (request.headers.get("upgrade")?.trim().toLowerCase() !== "websocket") {
    return false;
  }
  return connectionHeaderTokens(request.headers).includes("upgrade");
}

export function sanitizeWebSocketCloseCode(
  code: number,
  fallback = INTERNAL_ERROR_CLOSE_CODE,
): number {
  if (!Number.isInteger(code)) {
    return fallback;
  }

  if (code >= 3000 && code <= 4999) {
    return code;
  }

  if (
    code >= 1000 &&
    code <= 1014 &&
    code !== 1004 &&
    code !== 1005 &&
    code !== 1006
  ) {
    return code;
  }

  return fallback;
}

export function sanitizeWebSocketCloseReason(reason: string): string {
  const bytes = Buffer.from(reason);
  if (bytes.byteLength <= 123) {
    return reason;
  }

  let end = 123;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

export function getRequestHost(request: Request): string {
  return request.headers.get("host") ?? new URL(request.url).host;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function guestLinks(guests: readonly Guest[]): string {
  if (guests.length === 0) {
    return "<p>No Guests are checked in.</p>";
  }

  const items = guests
    .map((guest) => {
      const name = escapeHtml(guest.name);
      return `<li><a href="http://${name}.local/">http://${name}.local/</a> → :${guest.port}</li>`;
    })
    .join("");
  return `<ul>${items}</ul>`;
}

export function renderStatusPage(guests: readonly Guest[]): string {
  const rows = guests
    .map((guest) => {
      const name = escapeHtml(guest.name);
      return `<tr><td><a href="http://${name}.local/">${name}</a></td><td>${guest.port}</td><td>${escapeHtml(guest.owner.label)}</td><td>${guest.kind}</td><td>${escapeHtml(guest.path)}</td></tr>`;
    })
    .join("");

  const contents =
    rows.length === 0
      ? "<p>No Guests are checked in.</p>"
      : `<table><thead><tr><th>Guest</th><th>Port</th><th>Owner</th><th>Kind</th><th>Path</th></tr></thead><tbody>${rows}</tbody></table>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>yado</title></head><body><main><h1>yado</h1>${contents}</main></body></html>`;
}

export function renderUnknownHostPage(
  host: string,
  guests: readonly Guest[],
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Guest not found - yado</title></head><body><main><h1>Guest not found</h1><p>No Guest matches <code>${escapeHtml(host)}</code>.</p><h2>Current Guests</h2>${guestLinks(guests)}</main></body></html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messageByteLength(message: BridgeMessage): number {
  return typeof message === "string"
    ? Buffer.byteLength(message)
    : message.byteLength;
}

function copyBridgeMessage(message: unknown): BridgeMessage {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return message.slice(0);
  }
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(
      message.buffer,
      message.byteOffset,
      message.byteLength,
    ).slice().buffer;
  }
  throw new TypeError("Unsupported WebSocket message type");
}

function queueMessage(
  bridge: ProxyWebSocketData,
  direction: "backend" | "frontend",
  message: BridgeMessage,
): boolean {
  const size = messageByteLength(message);
  const current =
    direction === "backend"
      ? bridge.pendingToBackendBytes
      : bridge.pendingToFrontendBytes;
  if (current + size > MAX_PENDING_BYTES) {
    failBridge(bridge, 1009, "WebSocket proxy queue exceeded 16 MiB");
    return false;
  }

  if (direction === "backend") {
    bridge.pendingToBackend.push(message);
    bridge.pendingToBackendBytes += size;
  } else {
    bridge.pendingToFrontend.push(message);
    bridge.pendingToFrontendBytes += size;
  }
  return true;
}

function closeFrontend(
  bridge: ProxyWebSocketData,
  code: number,
  reason: string,
): void {
  const safeCode = sanitizeWebSocketCloseCode(code);
  const safeReason = sanitizeWebSocketCloseReason(reason);
  const frontend = bridge.frontend;
  if (frontend === null) {
    bridge.pendingFrontendClose = { code: safeCode, reason: safeReason };
    return;
  }
  if (frontend.readyState >= CLOSING) {
    return;
  }

  try {
    frontend.close(safeCode, safeReason);
  } catch (error) {
    bridge.log(`WebSocket frontend close failed: ${describeError(error)}`);
    try {
      frontend.terminate();
    } catch {
      // The socket is already gone.
    }
  }
}

function closeBackend(
  bridge: ProxyWebSocketData,
  code: number,
  reason: string,
): void {
  const backend = bridge.backend;
  if (backend === null || backend.readyState >= CLOSING) {
    return;
  }

  try {
    // Bun 1.3.14 can drop downstream-to-upstream close reasons at the client WebSocket boundary.
    backend.close(
      sanitizeWebSocketCloseCode(code),
      sanitizeWebSocketCloseReason(reason),
    );
  } catch (error) {
    bridge.log(`WebSocket backend close failed: ${describeError(error)}`);
    const terminable = backend as WebSocket & { terminate?: () => void };
    try {
      terminable.terminate?.();
    } catch {
      // The socket is already gone.
    }
  }
}

function finishBridge(
  bridge: ProxyWebSocketData,
  source: "frontend" | "backend" | "error",
  code: number,
  reason: string,
): void {
  if (bridge.finished) {
    return;
  }
  bridge.finished = true;
  bridge.pendingToBackend.length = 0;
  bridge.pendingToFrontend.length = 0;
  bridge.pendingToBackendBytes = 0;
  bridge.pendingToFrontendBytes = 0;

  if (source !== "frontend") {
    closeFrontend(bridge, code, reason);
  }
  if (source !== "backend") {
    closeBackend(bridge, code, reason);
  }
}

function failBridge(
  bridge: ProxyWebSocketData,
  code: number,
  reason: string,
): void {
  bridge.log(`WebSocket proxy failed: ${reason}`);
  finishBridge(bridge, "error", code, reason);
}

function sendToBackend(
  bridge: ProxyWebSocketData,
  message: BridgeMessage,
): void {
  const backend = bridge.backend;
  if (bridge.finished) {
    return;
  }
  if (backend === null || backend.readyState < OPEN) {
    queueMessage(bridge, "backend", message);
    return;
  }
  if (backend.readyState !== OPEN) {
    // Let the upstream close event carry its actual code and reason.
    return;
  }

  try {
    if (
      backend.bufferedAmount + messageByteLength(message) >
      MAX_PENDING_BYTES
    ) {
      failBridge(bridge, 1009, "Upstream WebSocket queue exceeded 16 MiB");
      return;
    }
    backend.send(message);
    if (backend.bufferedAmount > MAX_PENDING_BYTES) {
      failBridge(bridge, 1009, "Upstream WebSocket queue exceeded 16 MiB");
    }
  } catch (error) {
    failBridge(
      bridge,
      INTERNAL_ERROR_CLOSE_CODE,
      `Upstream WebSocket send failed: ${describeError(error)}`,
    );
  }
}

function sendToFrontend(
  bridge: ProxyWebSocketData,
  message: BridgeMessage,
): void {
  const frontend = bridge.frontend;
  if (bridge.finished) {
    return;
  }
  if (frontend === null || frontend.readyState < OPEN) {
    queueMessage(bridge, "frontend", message);
    return;
  }
  if (frontend.readyState !== OPEN) {
    // A late upstream message can race the downstream close callback. Drop
    // it and let that callback propagate the real close code to the backend.
    return;
  }

  try {
    const result = frontend.send(message);
    if (result === 0) {
      failBridge(
        bridge,
        INTERNAL_ERROR_CLOSE_CODE,
        "Downstream WebSocket dropped a message",
      );
    }
  } catch (error) {
    failBridge(
      bridge,
      INTERNAL_ERROR_CLOSE_CODE,
      `Downstream WebSocket send failed: ${describeError(error)}`,
    );
  }
}

function flushToBackend(bridge: ProxyWebSocketData): void {
  const pending = bridge.pendingToBackend.splice(0);
  bridge.pendingToBackendBytes = 0;
  for (const message of pending) {
    if (bridge.finished) {
      break;
    }
    sendToBackend(bridge, message);
  }
}

function flushToFrontend(bridge: ProxyWebSocketData): void {
  const pending = bridge.pendingToFrontend.splice(0);
  bridge.pendingToFrontendBytes = 0;
  for (const message of pending) {
    if (bridge.finished) {
      break;
    }
    sendToFrontend(bridge, message);
  }
}

function connectBackendAttempt(
  bridge: ProxyWebSocketData,
  url: string,
  protocols: string[],
  headers: Headers,
  signal: AbortSignal,
  createWebSocket: BackendWebSocketFactory,
): Promise<BackendConnectResult> {
  return new Promise<BackendConnectResult>((resolveAttempt) => {
    let settled = false;
    let opened = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backend: WebSocket | null = null;

    const settle = (result: BackendConnectResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      signal.removeEventListener("abort", onAbort);
      backend?.removeEventListener("open", onOpen);

      if (result.kind !== "connected" && backend !== null) {
        backend.removeEventListener("message", onMessage);
        backend.removeEventListener("close", onClose);
        backend.removeEventListener("error", onError);
        if (bridge.backend === backend) {
          bridge.backend = null;
        }
        if (backend.readyState < CLOSING) {
          try {
            backend.close();
          } catch {
            // The failed connection is already closing.
          }
        }
      }

      resolveAttempt(result);
    };

    const onAbort = () => {
      settle({
        kind: "aborted",
        reason: "Downstream WebSocket request was aborted",
      });
    };

    const onOpen = () => {
      if (bridge.finished || backend === null) {
        settle({
          kind: "aborted",
          reason: "Downstream WebSocket closed before the upstream opened",
        });
        return;
      }
      opened = true;
      bridge.downstreamProtocol = backend.protocol || null;
      flushToBackend(bridge);
      settle({ kind: "connected" });
    };

    const onMessage = (event: MessageEvent) => {
      try {
        sendToFrontend(bridge, copyBridgeMessage(event.data));
      } catch (error) {
        failBridge(
          bridge,
          INTERNAL_ERROR_CLOSE_CODE,
          `Upstream WebSocket message failed: ${describeError(error)}`,
        );
      }
    };

    const onClose = (event: CloseEvent) => {
      if (!opened) {
        settle({
          kind: "retryable-failure",
          reason: "Upstream WebSocket closed before opening",
        });
        return;
      }
      const code = sanitizeWebSocketCloseCode(event.code);
      const reason =
        event.code === code && event.reason.length > 0
          ? event.reason
          : event.code === 1000
            ? ""
            : "Upstream WebSocket closed";
      finishBridge(bridge, "backend", code, reason);
    };

    const onError = () => {
      if (!opened) {
        settle({
          kind: "retryable-failure",
          reason: "Upstream WebSocket connection failed",
        });
        return;
      }
      failBridge(
        bridge,
        INTERNAL_ERROR_CLOSE_CODE,
        "Upstream WebSocket error",
      );
    };

    try {
      backend = createWebSocket(url, {
        protocols,
        headers: headersToRecord(headers),
      });
      bridge.backend = backend;
      backend.binaryType = "arraybuffer";

      backend.addEventListener("open", onOpen);
      backend.addEventListener("message", onMessage);
      backend.addEventListener("close", onClose);
      backend.addEventListener("error", onError);

      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      timer = setTimeout(() => {
        settle({
          kind: "retryable-failure",
          reason: "Upstream WebSocket connection timed out",
        });
      }, UPSTREAM_CONNECT_TIMEOUT_MS);
      timer.unref();
    } catch (error) {
      settle({
        kind: "retryable-failure",
        reason: `Upstream WebSocket connection failed: ${describeError(error)}`,
      });
    }
  });
}

async function connectBackend(
  bridge: ProxyWebSocketData,
  targets: readonly BackendTarget[],
  protocols: string[],
  headers: Headers,
  signal: AbortSignal,
  createWebSocket: BackendWebSocketFactory,
): Promise<LoopbackHost | null> {
  let failureReason = "Upstream WebSocket connection failed";

  for (const target of targets) {
    if (signal.aborted || bridge.finished) {
      failureReason = "Downstream WebSocket request was aborted";
      break;
    }
    const result = await connectBackendAttempt(
      bridge,
      target.url,
      protocols,
      headers,
      signal,
      createWebSocket,
    );
    if (result.kind === "connected") {
      return target.host;
    }
    failureReason = result.reason;
    if (result.kind === "aborted") {
      break;
    }
  }

  failBridge(bridge, INTERNAL_ERROR_CLOSE_CODE, failureReason);
  return null;
}

async function proxyHttp(
  request: Request,
  server: Bun.Server<ProxyWebSocketData>,
  guest: Guest,
  originalHost: string,
  log: ProxyLogger,
  loopbackByGuest: Map<string, LoopbackHost>,
  fetchBackend: BackendFetch,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const clientAddress = server.requestIP(request)?.address ?? null;
  const headers = createForwardHeaders(request.headers, {
    originalHost,
    clientAddress,
  });
  const init: BunFetchRequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: request.signal,
    // A reverse proxy must preserve the encoded bytes and Content-Encoding.
    decompress: false,
  };
  const canHaveBody =
    request.method !== "GET" && request.method !== "HEAD";
  // Bun locks the current body branch when Request.clone() tees it, so clone
  // before first reading request.body.
  const retryRequest = canHaveBody ? request.clone() : null;
  const firstBody = retryRequest === null ? null : request.body;
  const retryBody = retryRequest?.body ?? null;
  const preferredHost = cachedLoopback(loopbackByGuest, guest.name);
  const fallbackHost = alternateLoopback(preferredHost);

  const fetchFrom = (
    host: LoopbackHost,
    body: ReadableStream<Uint8Array> | null,
  ) => {
    const attemptInit: BunFetchRequestInit = { ...init };
    if (body !== null) {
      attemptInit.body = body;
    }
    const upstreamUrl = `http://${host}:${guest.port}${incomingUrl.pathname}${incomingUrl.search}`;
    return fetchBackend(upstreamUrl, attemptInit);
  };

  const toResponse = (upstream: Response) =>
    new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: stripHopByHopHeaders(upstream.headers),
    });

  const discardRetryBody = () => {
    if (retryBody !== null) {
      void retryBody.cancel().catch(() => undefined);
    }
  };

  try {
    const upstream = await fetchFrom(preferredHost, firstBody);
    loopbackByGuest.set(guest.name, preferredHost);
    discardRetryBody();
    return toResponse(upstream);
  } catch (firstError) {
    if (request.signal.aborted) {
      discardRetryBody();
      log(
        `HTTP proxy to ${guest.name} (:${guest.port}) failed: ${describeError(firstError)}`,
      );
      return new Response("Bad Gateway\n", {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    try {
      const upstream = await fetchFrom(fallbackHost, retryBody);
      loopbackByGuest.set(guest.name, fallbackHost);
      return toResponse(upstream);
    } catch (fallbackError) {
      log(
        `HTTP proxy to ${guest.name} (:${guest.port}) failed: ${describeError(fallbackError)}`,
      );
      return new Response("Bad Gateway\n", {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  }
}

async function proxyWebSocket(
  request: Request,
  server: Bun.Server<ProxyWebSocketData>,
  guest: Guest,
  originalHost: string,
  log: ProxyLogger,
  createWebSocket: BackendWebSocketFactory,
  loopbackByGuest: Map<string, LoopbackHost>,
): Promise<Response | undefined> {
  const incomingUrl = new URL(request.url);
  const protocols = parseWebSocketProtocols(
    request.headers.get("sec-websocket-protocol"),
  );
  const clientAddress = server.requestIP(request)?.address ?? null;
  const upstreamHeaders = createForwardHeaders(request.headers, {
    originalHost,
    clientAddress,
    websocket: true,
  });
  const bridge: ProxyWebSocketData = {
    backend: null,
    frontend: null,
    pendingToBackend: [],
    pendingToFrontend: [],
    pendingToBackendBytes: 0,
    pendingToFrontendBytes: 0,
    downstreamProtocol: null,
    pendingFrontendClose: null,
    finished: false,
    log,
  };

  const preferredHost = cachedLoopback(loopbackByGuest, guest.name);
  const fallbackHost = alternateLoopback(preferredHost);
  const targets = [preferredHost, fallbackHost].map((host) => ({
    host,
    url: `ws://${host}:${guest.port}${incomingUrl.pathname}${incomingUrl.search}`,
  }));
  const connectedHost = await connectBackend(
    bridge,
    targets,
    protocols,
    upstreamHeaders,
    request.signal,
    createWebSocket,
  );
  if (connectedHost === null) {
    return new Response("WebSocket upstream connection failed\n", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  loopbackByGuest.set(guest.name, connectedHost);

  const responseHeaders = new Headers();
  if (bridge.downstreamProtocol !== null) {
    responseHeaders.set(
      "sec-websocket-protocol",
      bridge.downstreamProtocol,
    );
  }
  if (!server.upgrade(request, { data: bridge, headers: responseHeaders })) {
    failBridge(
      bridge,
      INTERNAL_ERROR_CLOSE_CODE,
      "Downstream WebSocket upgrade failed",
    );
    return new Response("WebSocket upgrade failed\n", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return undefined;
}

export function createProxyOptions(
  getGuests: GuestProvider,
  log: ProxyLogger = () => {},
  createWebSocket: BackendWebSocketFactory = createBackendWebSocket,
  fetchBackend: BackendFetch = defaultBackendFetch,
) {
  const loopbackByGuest = new Map<string, LoopbackHost>();

  return {
    async fetch(
      request: Request,
      server: Bun.Server<ProxyWebSocketData>,
    ): Promise<Response | undefined> {
      const guests = await getGuests();
      const originalHost = getRequestHost(request);
      const resolution = resolveHost(originalHost, guests);

      if (resolution.kind === "status") {
        return htmlResponse(renderStatusPage(guests));
      }
      if (resolution.kind === "unknown") {
        return htmlResponse(renderUnknownHostPage(originalHost, guests), 404);
      }

      if (isWebSocketUpgrade(request)) {
        return await proxyWebSocket(
          request,
          server,
          resolution.guest,
          originalHost,
          log,
          createWebSocket,
          loopbackByGuest,
        );
      }
      return proxyHttp(
        request,
        server,
        resolution.guest,
        originalHost,
        log,
        loopbackByGuest,
        fetchBackend,
      );
    },
    websocket: {
      data: {} as ProxyWebSocketData,
      idleTimeout: 0,
      open(ws: Bun.ServerWebSocket<ProxyWebSocketData>): void {
        const bridge = ws.data;
        bridge.frontend = ws;
        ws.binaryType = "arraybuffer";

        if (bridge.pendingFrontendClose !== null) {
          const pendingClose = bridge.pendingFrontendClose;
          bridge.pendingFrontendClose = null;
          closeFrontend(bridge, pendingClose.code, pendingClose.reason);
          return;
        }
        flushToFrontend(bridge);
      },
      message(
        ws: Bun.ServerWebSocket<ProxyWebSocketData>,
        message: string | Buffer,
      ): void {
        try {
          sendToBackend(ws.data, copyBridgeMessage(message));
        } catch (error) {
          failBridge(
            ws.data,
            INTERNAL_ERROR_CLOSE_CODE,
            `Downstream WebSocket message failed: ${describeError(error)}`,
          );
        }
      },
      close(
        ws: Bun.ServerWebSocket<ProxyWebSocketData>,
        code: number,
        reason: string,
      ): void {
        finishBridge(
          ws.data,
          "frontend",
          sanitizeWebSocketCloseCode(code),
          reason,
        );
      },
      error(
        ws: Bun.ServerWebSocket<ProxyWebSocketData>,
        error: Error,
      ): void {
        failBridge(
          ws.data,
          INTERNAL_ERROR_CLOSE_CODE,
          `Downstream WebSocket error: ${describeError(error)}`,
        );
      },
      drain(ws: Bun.ServerWebSocket<ProxyWebSocketData>): void {
        // Bun already queues a send that returns -1. The hook is deliberately
        // present so future bounded flow-control changes have one lifecycle
        // point and so no queued application message is resent accidentally.
        if (ws.data.finished) {
          return;
        }
      },
    // Bun 1.3.14 reads and invokes this documented `error` hook, while its
    // bundled WebSocketHandler declaration omits the property.
    } as Bun.WebSocketHandler<ProxyWebSocketData> & {
      error(
        ws: Bun.ServerWebSocket<ProxyWebSocketData>,
        error: Error,
      ): void;
    },
  };
}
