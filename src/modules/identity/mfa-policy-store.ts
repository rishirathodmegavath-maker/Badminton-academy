import { eq } from "drizzle-orm";
import { database } from "../../infrastructure/database/client";
import { academyMfaPolicy } from "../../infrastructure/database/schema";
import {
  DEFAULT_REQUIRED_ROLES,
  effectiveLevel,
  mfaPolicy,
  stricterLevel,
  stricterMode,
  type Env,
  type MfaLevel,
  type MfaMode,
} from "./mfa-policy";
type Db = Pick<ReturnType<typeof database>, "select">;
export type StoredMfaPolicy = {
  mode: MfaMode;
  /** Roles the mode applies to; defaults apply when a raised mode was stored without a list. */
  roles: string[];
  warnSince: Date | null;
  updatedAt: Date;
  updatedBy: string | null;
};
/** The academy's own policy, or null (= nothing chosen = off). Read from the database every time, so every instance agrees at once. */
export async function academyMfaPolicyOf(
  academyId: string,
  db: Db = database(),
): Promise<StoredMfaPolicy | null> {
  const [row] = await db
    .select()
    .from(academyMfaPolicy)
    .where(eq(academyMfaPolicy.academyId, academyId));
  if (!row) return null;
  const mode = (["off", "warn", "enforce"] as const).includes(row.mode as MfaMode)
    ? (row.mode as MfaMode)
    : "enforce"; // unreachable (CHECK constraint); an unreadable value fails toward stricter
  return {
    mode,
    roles: row.roles.length ? row.roles : [...DEFAULT_REQUIRED_ROLES],
    warnSince: row.warnSince,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}
/**
 * What two-factor authentication asks of one signed-in person right now: the stricter of the
 * deployment policy and each academy they actively belong to, per role. A person with several
 * active memberships gets the strictest answer across them (never the weakest), so holding a
 * second membership cannot be used to escape a requirement. Called on every request, from the
 * database, so a role change, reactivation or policy change takes effect immediately.
 */
export async function mfaStanding(
  memberships: readonly { academyId: string; role: string }[],
  options: { env?: Env; db?: Db } = {},
): Promise<{ level: MfaLevel; mode: MfaMode }> {
  const system = mfaPolicy(options.env ?? process.env);
  let level: MfaLevel = "optional";
  let mode: MfaMode = system.mode;
  const seen = new Map<string, StoredMfaPolicy | null>();
  for (const m of memberships) {
    if (!seen.has(m.academyId))
      seen.set(m.academyId, await academyMfaPolicyOf(m.academyId, options.db));
    const academy = seen.get(m.academyId)!;
    level = stricterLevel(level, effectiveLevel(system, academy, m.role));
    if (academy) mode = stricterMode(mode, academy.mode);
  }
  return { level, mode };
}
