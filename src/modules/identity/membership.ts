import { and, eq } from "drizzle-orm";
import { database } from "../../infrastructure/database/client";
import { sql } from "drizzle-orm";
import { academies, memberships, user } from "../../infrastructure/database/schema";
export type ActiveMembership = {
  academyId: string;
  academyName: string;
  timezone: string;
  role: string;
  /** How THIS academy shows the person (membership.display_name); null means "use the person's own name". */
  displayName: string | null;
};
/** Active memberships of one account, read from the database (never from the request). */
export async function activeMemberships(
  userId: string,
  db: ReturnType<typeof database> = database(),
): Promise<ActiveMembership[]> {
  const rows = await db
    .select({ membership: memberships, academy: academies })
    .from(memberships)
    .innerJoin(academies, eq(academies.id, memberships.academyId))
    .where(and(eq(memberships.userId, userId), eq(memberships.active, true)));
  return rows.map(({ membership, academy }) => toActive(membership, academy));
}
export const toActive = (
  membership: typeof memberships.$inferSelect,
  academy: typeof academies.$inferSelect,
): ActiveMembership => ({
  academyId: academy.id,
  academyName: academy.name,
  timezone: academy.timezone,
  role: membership.role,
  displayName: membership.displayName,
});
/**
 * The name an academy shows for a member in its own screens and records: the academy's display name for them
 * (membership.display_name) when it set one, otherwise the person's own name. Use it in any query that already joins
 * `membership` (for the academy being read) and `user`. Never write the result back to app_user.
 */
export const shownName = sql<string>`coalesce(${memberships.displayName}, ${user.name})`;
