const url = process.argv[2];
if (!url) {
  throw new Error("WebSocket URL is required");
}

export {};

const PublicWebSocket = WebSocket as unknown as new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

function connect(): WebSocket {
  const publicUrl = new URL(url);
  publicUrl.protocol = "http:";
  return new PublicWebSocket(url, {
    protocols: ["vite-hmr"],
    headers: { origin: publicUrl.origin },
  });
}

function connectWithoutProtocol(): WebSocket {
  const nextUrl = new URL(url);
  nextUrl.pathname = "/_next/webpack-hmr";
  nextUrl.search = "?transport=websocket";
  const publicUrl = new URL(nextUrl);
  publicUrl.protocol = "http:";
  return new PublicWebSocket(nextUrl.toString(), {
    headers: { origin: publicUrl.origin },
  });
}

function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("WebSocket smoke timeout")),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

await timeout(
  new Promise<void>((resolve, reject) => {
    const socket = connect();
    socket.binaryType = "arraybuffer";
    let textEcho = false;
    let binaryEcho = false;

    socket.addEventListener("open", () => {
      if (socket.protocol !== "vite-hmr") {
        reject(new Error(`unexpected protocol: ${socket.protocol}`));
        socket.close();
        return;
      }
      socket.send("hmr-ping");
      socket.send(new Uint8Array([1, 2, 3, 4]));
    });
    socket.addEventListener("message", (event) => {
      if (event.data === "hmr-ping") {
        textEcho = true;
      } else if (
        event.data instanceof ArrayBuffer &&
        new Uint8Array(event.data).join(",") === "1,2,3,4"
      ) {
        binaryEcho = true;
      }
      if (textEcho && binaryEcho) {
        socket.send("close-me");
      }
    });
    socket.addEventListener("close", (event) => {
      if (event.code !== 4_001 || event.reason !== "backend-close") {
        reject(
          new Error(
            `backend close was not propagated: ${event.code} ${event.reason}`,
          ),
        );
        return;
      }
      resolve();
    });
    socket.addEventListener("error", () => {
      reject(new Error("first WebSocket connection failed"));
    });
  }),
  8_000,
);

await timeout(
  new Promise<void>((resolve, reject) => {
    const socket = connect();
    socket.addEventListener("open", () => {
      socket.close(4_002, "frontend-close");
    });
    socket.addEventListener("close", () => resolve());
    socket.addEventListener("error", () => {
      reject(new Error("second WebSocket connection failed"));
    });
  }),
  8_000,
);

await timeout(
  new Promise<void>((resolve, reject) => {
    const socket = connectWithoutProtocol();
    socket.addEventListener("open", () => {
      if (socket.protocol !== "") {
        reject(new Error(`unexpected Next-style protocol: ${socket.protocol}`));
        socket.close();
        return;
      }
      socket.send("next-hmr-ping");
    });
    socket.addEventListener("message", (event) => {
      if (event.data === "next-hmr-ping") {
        socket.close(1_000, "next-close");
      }
    });
    socket.addEventListener("close", (event) => {
      if (event.code === 1_000) {
        resolve();
      } else {
        reject(new Error(`Next-style close failed: ${event.code}`));
      }
    });
    socket.addEventListener("error", () => {
      reject(new Error("Next-style WebSocket connection failed"));
    });
  }),
  8_000,
);

console.log(
  "WebSocket Vite/Next-style text/binary/close propagation passed",
);
