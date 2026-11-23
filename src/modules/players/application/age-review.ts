import { z } from "zod";
import { and, eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import { unit, requirePlayer, expectVersion, history } from "../../academy/application/access";
import { ageState, isCalendarDay, daysBetween, type AgeDecision } from "../domain/age";
import { academyToday } from "./age-rules";

/**
 * The owner's decision about a player who has turned 18. Only an owner or administrator (members.manage) decides.
 *   ARCHIVE (accept): the player leaves the academy's active list. The record, history and reports are kept, and the profile
 *     can be restored by an owner later.
 *   KEEP (reject): the player stays, but only with a written reason and a day to look at it again (at most a year ahead).
 *     When that day passes the decision is asked for again.
 * Nothing else records this decision: editing the profile cannot set, change or clear it.
 */
const MAX_KEEP_DAYS = 366;
export async function reviewAge(a: Actor, input: unknown) {
  requireCapability(a, "members.manage");
  const v = z
    .object({
      playerId: z.string().min(1).max(200),
      version: z.number().int(),
      decision: z.enum(["ARCHIVE", "KEEP"]),
      reason: z.string().trim().max(500).default(""),
      recheckOn: z.string().max(10).optional(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    await requirePlayer(a, v.playerId, tx);
    const [old] = await tx
      .select()
      .from(t.profiles)
      .where(and(eq(t.profiles.academyId, a.academyId), eq(t.profiles.playerId, v.playerId)));
    if (!old) throw new DomainError("Player not found.", 404);
    expectVersion(old.version, v.version);
    const today = await academyToday(tx, a.academyId);
    const state = ageState(old.data, today);
    if (state.kind !== "DECIDE" && state.kind !== "KEPT")
      throw new DomainError("This player does not need an age decision.", 409, "NO_AGE_DECISION_NEEDED");
    let data = old.data;
    if (v.decision === "ARCHIVE") {
      data = { ...old.data, status: "ARCHIVED", ageDecision: null };
    } else {
      if (v.reason.length < 10) throw new DomainError("Write why this player stays (at least 10 characters).", 422, "REASON_REQUIRED");
      const recheckOn = v.recheckOn ?? "";
      if (!isCalendarDay(recheckOn) || recheckOn <= today || daysBetween(today, recheckOn) > MAX_KEEP_DAYS)
        throw new DomainError("Choose a day to look at this again: after today and within a year.", 422, "RECHECK_DAY_INVALID");
      const decision: AgeDecision = { decision: "KEEP", reason: v.reason, decidedBy: a.id, decidedAt: new Date().toISOString(), recheckOn };
      data = { ...old.data, ageDecision: decision };
    }
    const version = old.version + 1;
    await tx
      .update(t.profiles)
      .set({ version, data })
      .where(and(eq(t.profiles.academyId, a.academyId), eq(t.profiles.playerId, v.playerId)));
    await history(tx, a, "player-profile", v.playerId, version, { ageReview: v.decision, ...data });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: v.playerId,
      action: v.decision === "ARCHIVE" ? "age-review-archive" : "age-review-keep",
      version,
      detail: v.decision === "KEEP" ? { recheckOn: data.ageDecision?.recheckOn } : {},
    });
    return { id: v.playerId, version, status: data.status, ageDecision: data.ageDecision ?? null };
  });
}
