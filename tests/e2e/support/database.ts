import { Client } from "pg";
import { isDisposableDatabaseUrl } from "../../../scripts/lib/e2e-server-env";

/**
 * A connection to the profile's DISPOSABLE database (E2E_DATABASE_URL), for the few things a browser cannot do: planting an
 * account in a state the screens no longer create, and making a code or link expire without waiting ten minutes. It refuses any
 * database that is not a loopback `sportozen_e2e`, so it cannot reach a database anyone keeps.
 */
export async function withDisposableDatabase<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const url = process.env.E2E_DATABASE_URL ?? "";
  if (!isDisposableDatabaseUrl(url)) throw new Error("E2E_DATABASE_URL must be a loopback PostgreSQL database named sportozen_e2e.");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
