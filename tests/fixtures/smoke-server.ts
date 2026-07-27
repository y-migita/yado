const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT is required");
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request, bunServer) {
    const url = new URL(request.url);
    if (
      (url.pathname === "/ws" ||
        url.pathname === "/_next/webpack-hmr") &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      if (request.headers.has("origin")) {
        return new Response("cross-site websocket origin rejected", {
          status: 403,
        });
      }
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((protocol) => protocol.trim())
        .filter(Boolean);
      const headers = new Headers();
      if (protocols.includes("vite-hmr")) {
        headers.set("sec-websocket-protocol", "vite-hmr");
      }
      if (bunServer.upgrade(request, { headers })) {
        return undefined;
      }
      return new Response("upgrade failed", { status: 400 });
    }
    return new Response("smoke-ok\n");
  },
  websocket: {
    message(ws, message) {
      if (message === "close-me") {
        ws.close(4_001, "backend-close");
        return;
      }
      ws.send(message);
    },
    close(_ws, code, reason) {
      console.log(`backend-close ${code} ${reason}`);
    },
    idleTimeout: 0,
  },
});

console.log(`smoke backend listening on ${server.hostname}:${server.port}`);
