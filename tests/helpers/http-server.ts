import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
/**
 * A real HTTP server (loopback, random port) in front of the application's actual Next.js route
 * handlers. Requests travel over TCP, so headers, cookies, Origin checks, body parsing and status
 * codes behave as they do in production. Next's own runtime is not involved (the app defines no
 * middleware), which is the one thing this harness does not cover.
 *
 * How the client address reaches the application is simulated explicitly:
 *  - "proxy":  a trusted reverse proxy (nginx `$proxy_add_x_forwarded_for`): whatever
 *              X-Forwarded-For the client sent is kept on the left and the connecting peer is
 *              APPENDED on the right. The peer is the real socket address, or the value of the
 *              test-only `x-test-peer` header, which lets one process stand in for many clients.
 *  - "direct": no proxy; the app is exposed as `next start` exposes it: X-Forwarded-For is filled
 *              from the socket only when the client did not send one (base-server.js `??=`).
 */
export type ProxyMode = "proxy" | "direct";
export const TEST_PEER_HEADER = "x-test-peer";
export const NO_PEER = "none";
type RouteModule = {
  GET?: (request: Request, context: Ctx) => Promise<Response>;
  POST?: (request: Request, context: Ctx) => Promise<Response>;
};
type Ctx = { params: Promise<{ path?: string[] }> };
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding"]);
const normalisePeer = (address: string | undefined) =>
  (address ?? "").replace(/^::ffff:/, "");
async function toRequest(
  req: IncomingMessage,
  origin: string,
  mode: ProxyMode,
) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers))
    if (value !== undefined && !HOP_BY_HOP.has(key) && key !== TEST_PEER_HEADER)
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  const peerOverride = req.headers[TEST_PEER_HEADER];
  const peer =
    (typeof peerOverride === "string" && peerOverride) ||
    normalisePeer(req.socket.remoteAddress);
  if (mode === "proxy") {
    // peer "none" simulates a misbehaving proxy that forwards without adding an address.
    if (peer !== NO_PEER) {
      const forwarded = headers.get("x-forwarded-for");
      headers.set(
        "x-forwarded-for",
        forwarded ? `${forwarded}, ${peer}` : peer,
      );
    }
  } else if (!headers.has("x-forwarded-for")) {
    headers.set("x-forwarded-for", normalisePeer(req.socket.remoteAddress));
  }
  const method = req.method ?? "GET";
  const body = ["GET", "HEAD"].includes(method)
    ? undefined
    : (Readable.toWeb(req) as ReadableStream);
  return new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    body,
    // @ts-expect-error `duplex` is required by undici for streamed bodies.
    duplex: "half",
  });
}
async function send(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  // One request per connection: avoids the client reusing a socket the server has just closed.
  res.setHeader("connection", "close");
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") res.setHeader(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader("set-cookie", cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}
export type TestServer = { origin: string; close(): Promise<void> };
/** Call `listen` first; the application reads BETTER_AUTH_URL lazily, so set it from `origin`. */
export async function listen(): Promise<{
  origin: string;
  attach(
    routes: {
      auth: RouteModule;
      academy: RouteModule;
      training: RouteModule;
    },
    mode: ProxyMode,
  ): TestServer;
}> {
  let handler: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void> = async (_req, res) => {
    res.statusCode = 503;
    res.end();
  };
  const server: Server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      // Surface harness faults instead of swallowing them behind a bare 500.
      console.error(
        "[test-server]",
        error instanceof Error ? error.stack : error,
      );
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    attach(routes, mode) {
      handler = async (req, res) => {
        const request = await toRequest(req, origin, mode);
        const parts = new URL(request.url).pathname.split("/").filter(Boolean);
        const [api, area, ...path] = parts;
        const module =
          api === "api"
            ? ({
                auth: routes.auth,
                academy: routes.academy,
                training: routes.training,
              }[area] as RouteModule | undefined)
            : undefined;
        const call = request.method === "GET" ? module?.GET : module?.POST;
        if (!call || (request.method !== "GET" && request.method !== "POST"))
          return send(res, new Response("Not found", { status: 404 }));
        return send(
          res,
          await call(request, { params: Promise.resolve({ path }) }),
        );
      };
      return {
        origin,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      };
    },
  };
}
