import { and, eq } from "drizzle-orm";
import type { database } from "../../infrastructure/database/client";
import * as t from "../../infrastructure/database/schema";
import { DomainError } from "../training/domain/rules";
import type { Actor } from "./access";
import { MEMBERSHIP_MESSAGES } from "./membership-messages";
type Tx = Parameters<Parameters<ReturnType<typeof database>["transaction"]>[0]>[0];
/**
 * RC-2 (AUTHORIZATION_SECURITY_ARCHITECTURE.md section 3): re-validates, INSIDE the transaction that
 * is about to write, the membership the request was authorised against.
 *
 * `resolveActor` decided the role before the transaction began. A member's role or active flag can
 * change in between (an owner demotes or deactivates them while their request waits for the academy
 * lock), and without this check the waiting request would then write with authority it no longer
 * has. The row is read with FOR SHARE: it conflicts with the FOR UPDATE that member changes take
 * (`lockedMembership` in saveMember), so either the change commits first and is seen here, or this
 * transaction commits first and the change waits for it.
 *
 *  - membership missing or inactive  -> 403 MEMBERSHIP_INACTIVE (nothing is written)
 *  - stored role differs             -> 409 ACCESS_CHANGED (the request must be re-evaluated)
 *
 * Every authorization decision made earlier in the request was a function of (academy, user, role),
 * and resolveActor guarantees the academy and user; confirming the role and active flag here
 * therefore makes all of those decisions current for the rest of the transaction.
 */
export async function lockActor(tx: Tx, a: Pick<Actor, "id" | "academyId" | "role">) {
  const [current] = await tx
    .select({ role: t.memberships.role, active: t.memberships.active })
    .from(t.memberships)
    .where(and(eq(t.memberships.academyId, a.academyId), eq(t.memberships.userId, a.id)))
    .for("share");
  if (!current || !current.active)
    throw new DomainError(MEMBERSHIP_MESSAGES.MEMBERSHIP_INACTIVE, 403, "MEMBERSHIP_INACTIVE");
  if (current.role !== a.role)
    throw new DomainError(
      "Your access changed while this request was being processed. Nothing was saved. Reload the page and try again.",
      409,
      "ACCESS_CHANGED",
    );
}
