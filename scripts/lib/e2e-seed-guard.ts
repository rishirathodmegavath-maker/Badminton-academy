import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Where scripts/seed-e2e-roles.ts may write. The script adds the ADMIN and FINANCE test accounts that the
 * development seed deliberately does not create, so it must be impossible to aim it at the real development
 * database or at production. This is a pure function (no database is opened) so the rules are tested directly.
 *
 * Allowed targets:
 *   - an embedded database COPY: LOCAL_DATABASE_PATH that is not, and is not inside, the development
 *     database. Paths are compared after resolving to an absolute path, following links when the path exists,
 *     and (on Windows, whose file system ignores case) ignoring case, so `.data/Development`, `.data\development\`
 *     or `./.data/../.data/development` are all recognised as the development database;
 *   - a loopback PostgreSQL database named exactly `sportozen_e2e`.
 * Always required: NODE_ENV is not production, E2E_DISPOSABLE=true and ALLOW_DEV_SEED=true.
 */
export type SeedEnv = Readonly<Record<string, string | undefined>>;
export type SeedTarget =
  | { ok: true; kind: "embedded-copy" | "postgres-e2e" }
  | { ok: false; reason: string };

const canonical = (path: string) => {
  let absolute = resolve(path);
  try {
    if (existsSync(absolute)) absolute = realpathSync.native(absolute);
  } catch {
    // keep the resolved path
  }
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};
const within = (child: string, parent: string) =>
  child === parent ||
  child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

const LOOPBACK_E2E =
  /^postgres(ql)?:\/\/[^@/]*@(127\.0\.0\.1|localhost|\[::1\]):\d+\/sportozen_e2e(\?.*)?$/;

/** `roots` are the folders whose `.data/development` is the real development database (cwd and the repository). */
export function checkSeedTarget(
  env: SeedEnv,
  roots: readonly string[],
): SeedTarget {
  if (env.NODE_ENV === "production")
    return { ok: false, reason: "never runs in production" };
  if (env.E2E_DISPOSABLE !== "true")
    return { ok: false, reason: "E2E_DISPOSABLE=true is required" };
  if (env.ALLOW_DEV_SEED !== "true")
    return { ok: false, reason: "ALLOW_DEV_SEED=true is required" };
  const url = env.DATABASE_URL;
  if (url)
    return LOOPBACK_E2E.test(url)
      ? { ok: true, kind: "postgres-e2e" }
      : {
          ok: false,
          reason:
            "DATABASE_URL must be a loopback PostgreSQL database named sportozen_e2e",
        };
  const path = env.LOCAL_DATABASE_PATH;
  if (!path?.trim())
    return { ok: false, reason: "LOCAL_DATABASE_PATH (a copy) is required" };
  const target = canonical(path);
  for (const root of roots) {
    const development = canonical(resolve(root, ".data", "development"));
    if (within(target, development))
      return {
        ok: false,
        reason: "the target is the real development database (or inside it)",
      };
  }
  return { ok: true, kind: "embedded-copy" };
}
