import { spawn } from "node:child_process";
import { buildServerEnv, E2eServerRefusal, type Profile } from "./lib/e2e-server-env";

/**
 * Starts a DISPOSABLE application server for browser tests with a fully specified environment (see lib/e2e-server-env.ts).
 *
 *   npm run build
 *   E2E_DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:<port>/sportozen_e2e \
 *     npx tsx scripts/e2e-server.ts --port 3480 --profile plain|fake-google
 *
 * It never reads `.env.local`, never prints a value, and refuses port 3100 and any database that is not a loopback
 * `sportozen_e2e`. The database must already be migrated (and seeded when the spec needs seeded accounts).
 */
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

try {
  const profile = (flag("profile") ?? "plain") as Profile;
  const port = Number(flag("port") ?? 3480);
  const env = buildServerEnv(process.env, {
    profile,
    port,
    databaseUrl: process.env.E2E_DATABASE_URL ?? "",
    authSecret: process.env.E2E_AUTH_SECRET || undefined,
  });
  console.log(`[e2e-server] profile=${profile} port=${port} (google ${profile === "fake-google" ? "FAKE credentials" : "off"}, no mail provider, .env.local not used for these settings)`);
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    env,
    stdio: "inherit",
  });
  const stop = () => next.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  next.on("exit", (code) => process.exit(code ?? 1));
} catch (error) {
  if (error instanceof E2eServerRefusal) {
    console.error(`[e2e-server] ${error.message}`);
    process.exit(2);
  }
  throw error;
}
