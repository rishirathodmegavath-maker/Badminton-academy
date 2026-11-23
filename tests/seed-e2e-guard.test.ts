import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { runMigrations } from "../src/infrastructure/database/migrations";
import { checkSeedTarget } from "../scripts/lib/e2e-seed-guard";
import { REPO_ROOT, TEST_TIMEOUT, repoPath } from "./helpers/paths";
/**
 * Stage 3: the ADMIN and FINANCE test accounts exist only in disposable E2E databases. The rules for where
 * scripts/seed-e2e-roles.ts may write are a pure function tested here (no database is opened by those tests);
 * the script itself is exercised only against a throw-away database in the operating system's temp folder.
 */
const ok = {
  E2E_DISPOSABLE: "true",
  ALLOW_DEV_SEED: "true",
};
const roots = [REPO_ROOT, process.cwd()];
const target = (env: Record<string, string | undefined>) =>
  checkSeedTarget({ ...ok, ...env }, roots);

test("a copy outside the development database is allowed", () => {
  const copy = join(tmpdir(), "sportozen-e2e-copy", "db");
  assert.deepEqual(target({ LOCAL_DATABASE_PATH: copy }), {
    ok: true,
    kind: "embedded-copy",
  });
  assert.deepEqual(
    target({ LOCAL_DATABASE_PATH: repoPath(".data", "e2e-copy") }),
    {
      ok: true,
      kind: "embedded-copy",
    },
  );
});

test("the real development database is refused however its path is written", () => {
  const dev = repoPath(".data", "development");
  const variants = [
    ".data/development",
    ".data\\development",
    `${dev}`,
    `${dev}/`,
    `${dev}\\`,
    repoPath(".data", "..", ".data", "development"),
    repoPath(".data", "development", "base"), // inside it
    repoPath(".data", "development", "..", "development"),
  ];
  for (const path of variants) {
    const r = target({ LOCAL_DATABASE_PATH: path });
    assert.equal(r.ok, false, path);
  }
});

test(
  "on Windows (case-insensitive file system) other casings of the development path are refused too",
  { skip: process.platform !== "win32" },
  () => {
    const dev = repoPath(".data", "development");
    for (const path of [
      dev.toUpperCase(),
      repoPath(".data", "Development"),
      repoPath(".DATA", "DEVELOPMENT"),
    ])
      assert.equal(target({ LOCAL_DATABASE_PATH: path }).ok, false, path);
  },
);

test("every required switch must be set, and production is never allowed", () => {
  const copy = join(tmpdir(), "x");
  assert.equal(
    checkSeedTarget(
      { ALLOW_DEV_SEED: "true", LOCAL_DATABASE_PATH: copy },
      roots,
    ).ok,
    false,
  );
  assert.equal(
    checkSeedTarget(
      { E2E_DISPOSABLE: "true", LOCAL_DATABASE_PATH: copy },
      roots,
    ).ok,
    false,
  );
  assert.equal(
    checkSeedTarget(
      { ...ok, LOCAL_DATABASE_PATH: copy, NODE_ENV: "production" },
      roots,
    ).ok,
    false,
  );
  assert.equal(checkSeedTarget({ ...ok }, roots).ok, false, "no target at all");
  assert.equal(
    checkSeedTarget({ ...ok, LOCAL_DATABASE_PATH: "   " }, roots).ok,
    false,
  );
  for (const value of ["TRUE", "1", "yes", ""])
    assert.equal(
      checkSeedTarget(
        { ...ok, E2E_DISPOSABLE: value, LOCAL_DATABASE_PATH: copy },
        roots,
      ).ok,
      false,
      value,
    );
});

test("PostgreSQL is accepted only as a loopback database named exactly sportozen_e2e", () => {
  const good = "postgres://postgres:pw@127.0.0.1:5432/sportozen_e2e";
  assert.deepEqual(target({ DATABASE_URL: good }), {
    ok: true,
    kind: "postgres-e2e",
  });
  assert.equal(
    target({
      DATABASE_URL:
        "postgres://u:pw@localhost:5432/sportozen_e2e?sslmode=disable",
    }).ok,
    true,
  );
  for (const bad of [
    "postgres://u:pw@db.example.com:5432/sportozen_e2e",
    "postgres://u:pw@127.0.0.1:5432/sportozen",
    "postgres://u:pw@127.0.0.1:5432/sportozen_e2e_prod",
    "postgres://u:pw@127.0.0.1:5432/postgres",
    "postgres://u:pw@10.0.0.5:5432/sportozen_e2e",
  ])
    assert.equal(target({ DATABASE_URL: bad }).ok, false, bad);
  // A PostgreSQL URL wins over any local path: it can never fall through to a path check.
  assert.equal(
    target({
      DATABASE_URL: "postgres://u:pw@db.example.com/x",
      LOCAL_DATABASE_PATH: join(tmpdir(), "ok"),
    }).ok,
    false,
  );
});

test("the production seed scripts do not contain the ADMIN/FINANCE test accounts", () => {
  for (const file of ["scripts/seed.ts", "scripts/seed-operations.ts"]) {
    const text = readFileSync(repoPath(file), "utf8");
    assert.ok(
      !/admin2@|finance@|"FINANCE"|'FINANCE'|"ADMIN"|'ADMIN'/.test(text),
      file,
    );
  }
  const e2e = readFileSync(repoPath("scripts/seed-e2e-roles.ts"), "utf8");
  assert.match(e2e, /checkSeedTarget/);
  assert.ok(
    !/console\.log\([^)]*password/i.test(e2e),
    "the seed never prints the password",
  );
});

function run(script: string, path: string, extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of [
    "DATABASE_URL",
    "TEST_POSTGRES_ADMIN_URL",
    "NODE_ENV",
    "E2E_DISPOSABLE",
  ])
    delete env[k];
  return spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...env,
      BETTER_AUTH_SECRET: "seed-guard-test-secret-0123456789abcdef0123456789",
      BETTER_AUTH_URL: "http://127.0.0.1:3100",
      LOCAL_DATABASE_PATH: path,
      ALLOW_DEV_SEED: "true",
      DEV_SEED_PASSWORD: "Throwaway-Seed-Pa55word",
      ...extra,
    } as unknown as NodeJS.ProcessEnv,
  });
}

test(
  "the E2E role seed is safe to repeat: ADMIN and FINANCE are added once, existing credentials are left alone, nothing is printed",
  { timeout: TEST_TIMEOUT },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-seed-guard-"));
    const path = resolve(dir, "db");
    try {
      await runMigrations({ target: { kind: "pglite", path } });
      const base = run("scripts/seed.ts", path);
      assert.equal(base.status, 0, base.stderr);
      // Refused without the explicit disposable switch, and in production, even with a harmless temp path.
      const noSwitch = run("scripts/seed-e2e-roles.ts", path);
      assert.notEqual(noSwitch.status, 0);
      assert.match(noSwitch.stderr, /Refusing/);
      const prod = run("scripts/seed-e2e-roles.ts", path, {
        E2E_DISPOSABLE: "true",
        NODE_ENV: "production",
      });
      assert.notEqual(prod.status, 0);
      const snapshot = async () => {
        const db = new PGlite(path);
        try {
          const members = (
            await db.query<{ email: string; role: string }>(
              `select u.email, m.role from membership m join app_user u on u.id = m.user_id
               where u.email in ('admin2@greenfield.example','finance@greenfield.example') order by 1`,
            )
          ).rows;
          const hashes = (
            await db.query<{ user_id: string; password: string }>(
              `select user_id, password from auth_account where user_id in ('academy-green-admin','academy-green-finance') order by 1`,
            )
          ).rows;
          const total = (
            await db.query<{ n: number }>(
              `select count(*)::int n from membership`,
            )
          ).rows[0].n;
          return { members, hashes, total };
        } finally {
          await db.close();
        }
      };
      const none = await snapshot();
      assert.deepEqual(
        none.members,
        [],
        "the standard seed has no ADMIN or FINANCE",
      );
      const first = run("scripts/seed-e2e-roles.ts", path, {
        E2E_DISPOSABLE: "true",
      });
      assert.equal(first.status, 0, first.stderr);
      const one = await snapshot();
      assert.deepEqual(one.members, [
        { email: "admin2@greenfield.example", role: "ADMIN" },
        { email: "finance@greenfield.example", role: "FINANCE" },
      ]);
      // Second run with a DIFFERENT password: nothing is added and existing credentials are not reset.
      const second = run("scripts/seed-e2e-roles.ts", path, {
        E2E_DISPOSABLE: "true",
        DEV_SEED_PASSWORD: "Different-Throwaway-Pa55word",
      });
      assert.equal(second.status, 0, second.stderr);
      const two = await snapshot();
      assert.deepEqual(two.members, one.members);
      assert.equal(two.total, one.total, "no extra memberships");
      assert.deepEqual(
        two.hashes,
        one.hashes,
        "passwords of existing accounts are not rewritten",
      );
      for (const out of [first, second, base]) {
        assert.ok(
          !(out.stdout + out.stderr).includes("Throwaway"),
          "no password is printed",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
