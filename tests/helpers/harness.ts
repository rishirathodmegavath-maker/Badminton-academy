import { TestClient } from "./client";
import {
  FIXTURE_PASSWORD,
  USERS,
  seedFixtures,
  type FixtureUserKey,
} from "./fixtures";
import { listen, type ProxyMode, type TestServer } from "./http-server";
import { provisionTestDatabase, type TestDatabase } from "./test-database";
/**
 * One isolated application instance per test file:
 *   disposable database (migrated by the production runner) + fixtures + real HTTP server in front
 *   of the real route handlers + real Better Auth sessions.
 * Tests run in separate processes, so environment changes here cannot leak between files.
 */
export type HarnessOptions = {
  /**
   * How client addresses reach the app (default "proxy": a trusted reverse proxy, with
   * TRUSTED_PROXIES configured). "direct" leaves TRUSTED_PROXIES unset and exposes the app the way
   * `next start` does.
   */
  proxy?: ProxyMode;
  /** Run the application in production mode (secure cookies). Requires a PostgreSQL test server. */
  production?: boolean;
};
export type Harness = {
  origin: string;
  database: TestDatabase["mode"];
  /** Fresh, anonymous client (its own simulated source address). */
  anonymous(address?: string): TestClient;
  /** Signed-in client for a fixture user (signs in once over HTTP, then caches the session). */
  as(key: FixtureUserKey): Promise<TestClient>;
  stop(): Promise<void>;
};
export const TRUSTED_PROXY_ADDRESS = "192.0.2.254";
const env = process.env as Record<string, string | undefined>;
export async function startHarness(
  label: string,
  options: HarnessOptions = {},
): Promise<Harness> {
  const proxy = options.proxy ?? "proxy";
  // Throw-away secret for the disposable instance only.
  env.BETTER_AUTH_SECRET = "http-harness-secret-0123456789abcdef0123456789";
  if (options.production) env.NODE_ENV = "production";
  // The test server plays the reverse proxy. A proxy appends the CLIENT address, never its own, so
  // the trusted entry is a documentation-range address (RFC 5737) that no simulated client uses.
  if (proxy === "proxy") env.TRUSTED_PROXIES = TRUSTED_PROXY_ADDRESS;
  else delete env.TRUSTED_PROXIES;
  delete env.TRUSTED_CLIENT_IP_HEADER;
  const socket = await listen();
  // The application reads these lazily on first use, so set them before the first request.
  env.BETTER_AUTH_URL = socket.origin;
  const db = await provisionTestDatabase(label);
  let server: TestServer | undefined;
  try {
    await seedFixtures();
    const [auth, academy, training] = await Promise.all([
      import("../../src/app/api/auth/[...all]/route"),
      import("../../src/app/api/academy/[[...path]]/route"),
      import("../../src/app/api/training/[[...path]]/route"),
    ]);
    server = socket.attach({ auth, academy, training }, proxy);
  } catch (error) {
    await db.cleanup();
    throw error;
  }
  const sessions = new Map<FixtureUserKey, TestClient>();
  return {
    origin: socket.origin,
    database: db.mode,
    anonymous: (address) => new TestClient(socket.origin, address),
    async as(key) {
      const cached = sessions.get(key);
      if (cached) return cached;
      const client = new TestClient(socket.origin);
      const response = await client.signIn(USERS[key].email, FIXTURE_PASSWORD);
      if (response.status !== 200 || !client.hasSession())
        throw new Error(
          `Fixture sign-in failed for ${key}: ${response.status}`,
        );
      sessions.set(key, client);
      return client;
    },
    async stop() {
      await server?.close();
      // cleanup() closes the application's database connection exactly once (the app's
      // closeDatabase() is not idempotent) and then removes only what this harness created.
      await db.cleanup();
    },
  };
}
