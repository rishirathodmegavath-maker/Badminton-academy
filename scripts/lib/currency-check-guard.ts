import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
/**
 * Where the read-only currency check may look. An embedded database cannot be opened safely by a
 * second process while the development server holds it, so the check never accepts the live
 * development directory: it takes an explicit COPY (restored backup or snapshot) and says so with
 * --copy. A PostgreSQL URL is accepted as is; the check runs in a read-only transaction.
 */
export type CheckTarget =
  | { ok: true; kind: "pglite"; path: string }
  | { ok: true; kind: "postgres"; url: string }
  | { ok: false; reason: string };
const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
export function checkTarget(
  args: string[],
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
): CheckTarget {
  const at = args.indexOf("--pglite");
  if (at >= 0) {
    const raw = args[at + 1];
    if (!raw || raw.startsWith("--"))
      return { ok: false, reason: "--pglite needs the path of a COPY of an embedded database." };
    if (!args.includes("--copy"))
      return {
        ok: false,
        reason:
          "Add --copy to confirm the path is a copy (a restored backup or snapshot), never the live development database.",
      };
    const path = resolve(raw);
    const live = [resolve(repoRoot, ".data", "development")];
    if (env.LOCAL_DATABASE_PATH) live.push(resolve(repoRoot, env.LOCAL_DATABASE_PATH));
    if (live.some((dir) => inside(dir, path) || inside(path, dir)))
      return {
        ok: false,
        reason: "That is the live development database (or contains it). Point the check at a copy.",
      };
    if (!existsSync(path) || !statSync(path).isDirectory())
      return { ok: false, reason: "The copy does not exist." };
    return { ok: true, kind: "pglite", path };
  }
  if (args.includes("--copy"))
    return { ok: false, reason: "--copy is only valid with --pglite <path>." };
  if (env.DATABASE_URL) return { ok: true, kind: "postgres", url: env.DATABASE_URL };
  return {
    ok: false,
    reason:
      "Give the target explicitly: --pglite <copy-of-database> --copy, or set DATABASE_URL for PostgreSQL.",
  };
}
