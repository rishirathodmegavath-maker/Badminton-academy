import type { Client } from "pg";
import type { FixtureName } from "./e2e-profiles";

/**
 * Data a browser-test profile needs beyond the seeds. Each fixture is applied to the profile's own DISPOSABLE database before the
 * specs run and removed afterwards (and the database itself is dropped after that), and every step is verified, so a fixture can
 * never leak into another profile or into a database anyone keeps.
 *
 * `client` is connected to the disposable `sportozen_e2e` database; the runner refuses any other.
 */
type Fixture = {
  describe: string;
  apply: (client: Client) => Promise<void>;
  remove: (client: Client) => Promise<void>;
  present: (client: Client) => Promise<boolean>;
};

const OWNER_EMAIL = "admin@greenfield.example";
const SECOND_ACADEMY = "academy-blue";

const FIXTURES: Record<FixtureName, Fixture> = {
  // multi-academy.spec.ts: "the seeded owner of Greenfield, admin@greenfield.example, has also been given a HEAD_COACH membership at Bluebird".
  "owner-at-bluebird": {
    describe: "the seeded Greenfield owner also holds a head-coach membership at Bluebird",
    async apply(client) {
      const owner = await client.query<{ id: string }>("select id from app_user where email = $1", [OWNER_EMAIL]);
      if (owner.rowCount !== 1) throw new Error("fixture owner-at-bluebird: the seeded owner account was not found");
      const academy = await client.query("select 1 from academy where id = $1", [SECOND_ACADEMY]);
      if (academy.rowCount !== 1) throw new Error("fixture owner-at-bluebird: the seeded second academy was not found");
      await client.query(
        `insert into membership (user_id, academy_id, role, active)
         select $1, $2, 'HEAD_COACH', true
         where not exists (select 1 from membership where user_id = $1 and academy_id = $2)`,
        [owner.rows[0].id, SECOND_ACADEMY],
      );
    },
    async remove(client) {
      await client.query(
        "delete from membership where academy_id = $2 and user_id = (select id from app_user where email = $1)",
        [OWNER_EMAIL, SECOND_ACADEMY],
      );
    },
    async present(client) {
      const r = await client.query(
        "select 1 from membership m join app_user u on u.id = m.user_id where u.email = $1 and m.academy_id = $2",
        [OWNER_EMAIL, SECOND_ACADEMY],
      );
      return (r.rowCount ?? 0) > 0;
    },
  },
};

export const describeFixture = (name: FixtureName) => FIXTURES[name].describe;
export const applyFixture = (client: Client, name: FixtureName) => FIXTURES[name].apply(client);
export const removeFixture = (client: Client, name: FixtureName) => FIXTURES[name].remove(client);
export const fixtureIsPresent = (client: Client, name: FixtureName) => FIXTURES[name].present(client);
