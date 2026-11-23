import { TEST_PEER_HEADER } from "./http-server";
/**
 * HTTP client with a cookie jar. Each client presents its own simulated connecting address
 * (`x-test-peer`, consumed by the test server and never seen by the application), standing in
 * for a distinct machine. Forwarding headers a hostile client might forge go through `headers`.
 */
let addressCounter = 0;
export const nextTestAddress = () =>
  `198.51.100.${(++addressCounter % 250) + 1}`;
/** Replace one character so the value is guaranteed to differ (never a no-op). */
export const corrupt = (value: string, at = 0) =>
  value.slice(0, at) + (value[at] === "x" ? "y" : "x") + value.slice(at + 1);
export class TestClient {
  private jar = new Map<string, string>();
  /** Raw Set-Cookie headers from the most recent response, for attribute assertions. */
  lastSetCookies: string[] = [];
  constructor(
    readonly origin: string,
    readonly address = nextTestAddress(),
  ) {}
  get cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get sessionCookie() {
    return [...this.jar].find(([k]) => k.endsWith("session_token"));
  }
  hasSession() {
    return !!this.sessionCookie;
  }
  /** Copy of this client's session, for "same cookie after sign-out" style checks. */
  clone(address = this.address) {
    const copy = new TestClient(this.origin, address);
    this.jar.forEach((v, k) => copy.jar.set(k, v));
    return copy;
  }
  private store(response: Response) {
    this.lastSetCookies = response.headers.getSetCookie();
    for (const raw of this.lastSetCookies) {
      const [pair, ...attributes] = raw.split(";").map((s) => s.trim());
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      const expired = attributes.some(
        (a) => /^max-age=0$/i.test(a) || /^max-age=-/i.test(a),
      );
      if (!value || expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  async request(
    path: string,
    init: {
      method?: "GET" | "POST";
      body?: unknown;
      origin?: string | null;
      headers?: Record<string, string>;
      raw?: string;
      /** Send no simulated peer: the server falls back to the real socket address. */
      noPeer?: boolean;
    } = {},
  ) {
    const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
    const headers: Record<string, string> = { ...init.headers };
    if (!init.noPeer) headers[TEST_PEER_HEADER] = this.address;
    if (this.cookieHeader && !("cookie" in headers))
      headers.cookie = this.cookieHeader;
    if (method === "POST") {
      headers["content-type"] = "application/json";
      if (init.origin !== null) headers.origin = init.origin ?? this.origin;
    }
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers,
      body:
        method === "POST"
          ? (init.raw ?? JSON.stringify(init.body ?? {}))
          : undefined,
      redirect: "manual",
    });
    this.store(response);
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body (PDF, empty) */
    }
    return {
      status: response.status,
      json,
      text,
      headers: response.headers,
      setCookies: this.lastSetCookies,
    };
  }
  get(path: string, init: Parameters<TestClient["request"]>[1] = {}) {
    return this.request(path, { ...init, method: "GET" });
  }
  post(
    path: string,
    body: unknown = {},
    init: Parameters<TestClient["request"]>[1] = {},
  ) {
    return this.request(path, { ...init, method: "POST", body });
  }
  /** Real Better Auth sign-in; the session cookie is kept in the jar. */
  signIn(
    email: string,
    password: string,
    init: Parameters<TestClient["request"]>[1] = {},
  ) {
    return this.post("/api/auth/sign-in/email", { email, password }, init);
  }
  signOut() {
    return this.post("/api/auth/sign-out");
  }
}
