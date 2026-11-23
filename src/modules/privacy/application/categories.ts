import { and, eq, inArray, sql } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Tx } from "../../academy/application/access";
import { defaultProfile } from "../../academy/application/access";
import type { SessionData } from "../../training/domain/types";
import type { EnquiryData, ProfileData } from "../../academy/domain/types";
import { ERASED_NAME, type CategoryKey } from "../domain";
/**
 * Phase 8: what each category of a player's data is made of, how to count it (non-destructive preview)
 * and how to erase or anonymise it. Everything is scoped by academy AND player, never by player alone,
 * and nothing relies on cascading deletes: each statement names the rows it touches.
 *
 * Every `erase*` function is IDEMPOTENT (running it again finds nothing left to do) and runs inside the
 * caller's transaction, which holds the academy lock.
 *
 * Re-identification: after anonymisation the retained evidence (finance, consent, audit, messages,
 * calendar) still carries the opaque player id and, for consent, the guardian's account id. It no longer
 * resolves to a name, but a person with outside knowledge could still link it. That is pseudonymisation
 * of retained evidence, not irreversible anonymisation, and is reported as such (PRIVACY_LIFECYCLE.md).
 */
type Counts = { records: number; detail: Record<string, number> };
const containsId = (column: unknown, key: string, id: string) =>
  sql`(${column} -> ${key}) @> ${JSON.stringify([id])}::jsonb`;
const touches = (d: SessionData, id: string) =>
  d.roster.some((p) => p.id === id) ||
  id in d.attendance ||
  d.observations.some((o) => o.playerId === id) ||
  d.adjustments.some((a) => a.playerId === id);
/** The session with this player's identifying text removed (null if there is nothing left to remove). */
export function scrubSession(d: SessionData, id: string): SessionData | null {
  const next: SessionData = {
    ...d,
    roster: d.roster.map((p) => (p.id === id ? { ...p, name: ERASED_NAME } : p)),
    observations: d.observations.map((o) => (o.playerId === id ? { ...o, text: "" } : o)),
    adjustments: d.adjustments.map((a) => {
      if (a.playerId !== id) return a;
      const { goalId: _goal, ...rest } = a;
      void _goal;
      return { ...rest, focus: "" };
    }),
  };
  return JSON.stringify(next) === JSON.stringify(d) ? null : next;
}
const enquiryDirty = (d: EnquiryData) =>
  d.name !== ERASED_NAME || !!(d.email || d.phone || d.notes || d.feedback);
const scrubEnquiry = (d: EnquiryData): EnquiryData => ({ ...d, name: ERASED_NAME, email: "", phone: "", notes: "", feedback: "" });
const blankProfile: ProfileData = { ...defaultProfile, status: "ARCHIVED" };
const profileDirty = (d: ProfileData) =>
  !!(d.birthDate || d.email || d.phone || d.notes || d.preferences || d.selfUserId || d.adult || d.status !== "ARCHIVED");
async function sessionsOf(tx: Tx, academyId: string, playerId: string) {
  return (await tx.select().from(t.trainingSessions).where(eq(t.trainingSessions.academyId, academyId))).filter((s) => touches(s.data, playerId));
}
async function ids(tx: Tx, academyId: string, playerId: string, table: "reports" | "plans" | "media") {
  if (table === "reports")
    return (await tx.select({ id: t.reports.id }).from(t.reports).where(and(eq(t.reports.academyId, academyId), eq(t.reports.playerId, playerId)))).map((r) => r.id);
  if (table === "plans")
    return (await tx.select({ id: t.nutritionPlans.id }).from(t.nutritionPlans).where(and(eq(t.nutritionPlans.academyId, academyId), eq(t.nutritionPlans.playerId, playerId)))).map((r) => r.id);
  return (await tx.select({ id: t.mediaAssets.id }).from(t.mediaAssets).where(and(eq(t.mediaAssets.academyId, academyId), eq(t.mediaAssets.playerId, playerId)))).map((r) => r.id);
}
const revisionRows = (tx: Tx, academyId: string, kind: string, entityIds: string[]) =>
  entityIds.length
    ? tx.select({ id: t.recordRevisions.id }).from(t.recordRevisions).where(and(eq(t.recordRevisions.academyId, academyId), eq(t.recordRevisions.kind, kind), inArray(t.recordRevisions.entityId, entityIds)))
    : Promise.resolve([] as { id: string }[]);
const dropRevisions = async (tx: Tx, academyId: string, kind: string, entityIds: string[]) => {
  if (!entityIds.length) return 0;
  const gone = await tx.delete(t.recordRevisions).where(and(eq(t.recordRevisions.academyId, academyId), eq(t.recordRevisions.kind, kind), inArray(t.recordRevisions.entityId, entityIds))).returning({ id: t.recordRevisions.id });
  return gone.length;
};
/** Non-destructive: how much of this category exists for the player right now. */
export async function inspect(key: CategoryKey, tx: Tx, academyId: string, playerId: string): Promise<Counts> {
  switch (key) {
    case "MEDIA": {
      const media = await ids(tx, academyId, playerId, "media");
      return { records: media.length, detail: { files: media.length, revisions: (await revisionRows(tx, academyId, "media", media)).length } };
    }
    case "REPORTS": {
      const reports = await ids(tx, academyId, playerId, "reports");
      return { records: reports.length, detail: { revisions: (await revisionRows(tx, academyId, "report", reports)).length } };
    }
    case "NUTRITION": {
      const plans = await ids(tx, academyId, playerId, "plans");
      const restrictions = await tx.select().from(t.restrictedNutrition).where(and(eq(t.restrictedNutrition.academyId, academyId), eq(t.restrictedNutrition.playerId, playerId)));
      const questions = await tx.select({ id: t.nutritionQuestions.id }).from(t.nutritionQuestions).where(and(eq(t.nutritionQuestions.academyId, academyId), eq(t.nutritionQuestions.playerId, playerId)));
      const assignments = await tx.select().from(t.nutritionAssignments).where(and(eq(t.nutritionAssignments.academyId, academyId), eq(t.nutritionAssignments.playerId, playerId)));
      const revisions = (await revisionRows(tx, academyId, "nutrition-plan", plans)).length;
      return { records: plans.length + restrictions.length + questions.length + assignments.length, detail: { plans: plans.length, revisions, restrictions: restrictions.length, questions: questions.length, assignments: assignments.length } };
    }
    case "CONVERSATIONS": {
      const rows = await tx.select({ id: t.conversations.id }).from(t.conversations).where(and(eq(t.conversations.academyId, academyId), eq(t.conversations.playerId, playerId)));
      return { records: rows.length, detail: {} };
    }
    case "GOALS_AND_HISTORY": {
      const goals = await tx.select({ id: t.goals.id }).from(t.goals).where(and(eq(t.goals.academyId, academyId), eq(t.goals.playerId, playerId)));
      const history = await tx.select({ id: t.playerHistory.id }).from(t.playerHistory).where(and(eq(t.playerHistory.academyId, academyId), eq(t.playerHistory.playerId, playerId)));
      return { records: goals.length + history.length, detail: { goals: goals.length, history: history.length } };
    }
    case "TRAINING_RECORDS": {
      const sessions = await sessionsOf(tx, academyId, playerId);
      const dirty = sessions.filter((s) => scrubSession(s.data, playerId));
      const revs = sessions.length
        ? (await tx.select().from(t.revisions).where(and(eq(t.revisions.academyId, academyId), inArray(t.revisions.sessionId, sessions.map((s) => s.id))))).filter((r) => scrubSession(r.data, playerId))
        : [];
      return { records: dirty.length + revs.length, detail: { sessions: dirty.length, revisions: revs.length } };
    }
    case "ADMISSIONS": {
      const rows = await tx.select().from(t.enquiries).where(and(eq(t.enquiries.academyId, academyId), sql`${t.enquiries.data} ->> 'playerId' = ${playerId}`));
      const dirty = rows.filter((r) => enquiryDirty(r.data));
      const revisions = (await revisionRows(tx, academyId, "enquiry", rows.map((r) => r.id))).length;
      return { records: dirty.length + revisions, detail: { enquiries: dirty.length, revisions } };
    }
    case "GUARDIAN_LINKS": {
      const links = (await tx.select().from(t.guardianLinks).where(and(eq(t.guardianLinks.academyId, academyId), eq(t.guardianLinks.playerId, playerId)))).filter((l) => l.active || l.relationship !== "Erased");
      return { records: links.length, detail: {} };
    }
    case "PLAYER_PROFILE": {
      const [player] = await tx.select().from(t.players).where(and(eq(t.players.academyId, academyId), eq(t.players.id, playerId)));
      const [profile] = await tx.select().from(t.profiles).where(and(eq(t.profiles.academyId, academyId), eq(t.profiles.playerId, playerId)));
      const revisions = (await revisionRows(tx, academyId, "player-profile", [playerId])).length;
      const dirty = (player && player.name !== ERASED_NAME ? 1 : 0) + (profile && profileDirty(profile.data) ? 1 : 0);
      return { records: dirty + revisions, detail: { identity: player && player.name !== ERASED_NAME ? 1 : 0, profile: profile && profileDirty(profile.data) ? 1 : 0, revisions } };
    }
    // ---- retained evidence: counted so the preview can say what stays and why ----
    case "FINANCE": {
      const invoices = await tx.select({ id: t.invoices.id }).from(t.invoices).where(and(eq(t.invoices.academyId, academyId), containsId(t.invoices.data, "playerIds", playerId)));
      const payments = invoices.length ? await tx.select({ id: t.payments.id }).from(t.payments).where(and(eq(t.payments.academyId, academyId), inArray(t.payments.invoiceId, invoices.map((i) => i.id)))) : [];
      const credits = await tx.select({ id: t.lessonCredits.id }).from(t.lessonCredits).where(and(eq(t.lessonCredits.academyId, academyId), eq(t.lessonCredits.playerId, playerId)));
      return { records: invoices.length + payments.length + credits.length, detail: { invoices: invoices.length, payments: payments.length, credits: credits.length } };
    }
    case "CONSENT_EVIDENCE": {
      const rows = await tx.select({ id: t.consentEvents.id }).from(t.consentEvents).where(and(eq(t.consentEvents.academyId, academyId), eq(t.consentEvents.playerId, playerId)));
      return { records: rows.length, detail: {} };
    }
    case "AUDIT_RECORDS": {
      const access = await tx.select({ id: t.accessEvents.id }).from(t.accessEvents).where(and(eq(t.accessEvents.academyId, academyId), eq(t.accessEvents.playerId, playerId)));
      const audit = await tx.select({ id: t.audit.id }).from(t.audit).where(and(eq(t.audit.academyId, academyId), eq(t.audit.entityId, playerId)));
      return { records: access.length + audit.length, detail: { access: access.length, audit: audit.length } };
    }
    case "MESSAGES_AND_CALENDAR": {
      const messages = await tx.select({ id: t.messages.id }).from(t.messages).where(and(eq(t.messages.academyId, academyId), containsId(t.messages.data, "playerIds", playerId)));
      const events = await tx.select({ id: t.calendarEvents.id }).from(t.calendarEvents).where(and(eq(t.calendarEvents.academyId, academyId), containsId(t.calendarEvents.data, "playerIds", playerId)));
      return { records: messages.length + events.length, detail: { messages: messages.length, events: events.length } };
    }
  }
}
/** Destructive: erase or anonymise one category for one player. Returns how many records it changed. */
export async function perform(key: CategoryKey, tx: Tx, academyId: string, playerId: string, requestId: string): Promise<number> {
  switch (key) {
    case "MEDIA": {
      const assets = await tx.select().from(t.mediaAssets).where(and(eq(t.mediaAssets.academyId, academyId), eq(t.mediaAssets.playerId, playerId)));
      // The file removal is recorded here, in this transaction, and carried out after it commits (outbox).
      for (const a of assets)
        await tx
          .insert(t.storageDeletions)
          .values({ id: crypto.randomUUID(), academyId, requestId, storageKey: a.storageKey })
          // The same key again (the file came back, e.g. after a restore): queue it again for this request.
          .onConflictDoUpdate({ target: [t.storageDeletions.academyId, t.storageDeletions.storageKey], set: { requestId, status: "PENDING", attempts: 0, nextAttemptAt: null, lastError: null, doneAt: null } });
      const revisions = await dropRevisions(tx, academyId, "media", assets.map((a) => a.id));
      if (assets.length) await tx.delete(t.mediaAssets).where(and(eq(t.mediaAssets.academyId, academyId), eq(t.mediaAssets.playerId, playerId)));
      return assets.length + revisions;
    }
    case "REPORTS": {
      const reports = await ids(tx, academyId, playerId, "reports");
      const revisions = await dropRevisions(tx, academyId, "report", reports);
      if (reports.length) await tx.delete(t.reports).where(and(eq(t.reports.academyId, academyId), inArray(t.reports.id, reports)));
      return reports.length + revisions;
    }
    case "NUTRITION": {
      const plans = await ids(tx, academyId, playerId, "plans");
      const revisions = await dropRevisions(tx, academyId, "nutrition-plan", plans);
      if (plans.length) await tx.delete(t.nutritionPlans).where(and(eq(t.nutritionPlans.academyId, academyId), inArray(t.nutritionPlans.id, plans)));
      const r = await tx.delete(t.restrictedNutrition).where(and(eq(t.restrictedNutrition.academyId, academyId), eq(t.restrictedNutrition.playerId, playerId))).returning({ p: t.restrictedNutrition.playerId });
      const q = await tx.delete(t.nutritionQuestions).where(and(eq(t.nutritionQuestions.academyId, academyId), eq(t.nutritionQuestions.playerId, playerId))).returning({ id: t.nutritionQuestions.id });
      const a = await tx.delete(t.nutritionAssignments).where(and(eq(t.nutritionAssignments.academyId, academyId), eq(t.nutritionAssignments.playerId, playerId))).returning({ p: t.nutritionAssignments.playerId });
      return plans.length + revisions + r.length + q.length + a.length;
    }
    case "CONVERSATIONS": {
      const gone = await tx.delete(t.conversations).where(and(eq(t.conversations.academyId, academyId), eq(t.conversations.playerId, playerId))).returning({ id: t.conversations.id });
      return gone.length;
    }
    case "GOALS_AND_HISTORY": {
      const g = await tx.delete(t.goals).where(and(eq(t.goals.academyId, academyId), eq(t.goals.playerId, playerId))).returning({ id: t.goals.id });
      const h = await tx.delete(t.playerHistory).where(and(eq(t.playerHistory.academyId, academyId), eq(t.playerHistory.playerId, playerId))).returning({ id: t.playerHistory.id });
      return g.length + h.length;
    }
    case "TRAINING_RECORDS": {
      const sessions = await sessionsOf(tx, academyId, playerId);
      let changed = 0;
      for (const s of sessions) {
        const next = scrubSession(s.data, playerId);
        if (next) {
          await tx.update(t.trainingSessions).set({ data: next }).where(and(eq(t.trainingSessions.academyId, academyId), eq(t.trainingSessions.id, s.id)));
          changed++;
        }
        // The approved wording of this player's observations is about them, too.
        const observationIds = s.data.observations.filter((o) => o.playerId === playerId).map((o) => o.id);
        if (observationIds.length) {
          const gone = await tx.delete(t.observationReviews).where(and(eq(t.observationReviews.academyId, academyId), eq(t.observationReviews.sessionId, s.id), inArray(t.observationReviews.observationId, observationIds))).returning({ id: t.observationReviews.observationId });
          changed += gone.length;
        }
      }
      if (sessions.length)
        for (const r of await tx.select().from(t.revisions).where(and(eq(t.revisions.academyId, academyId), inArray(t.revisions.sessionId, sessions.map((s) => s.id))))) {
          const next = scrubSession(r.data, playerId);
          if (next) {
            await tx.update(t.revisions).set({ data: next }).where(and(eq(t.revisions.academyId, academyId), eq(t.revisions.sessionId, r.sessionId), eq(t.revisions.version, r.version)));
            changed++;
          }
        }
      return changed;
    }
    case "ADMISSIONS": {
      const rows = await tx.select().from(t.enquiries).where(and(eq(t.enquiries.academyId, academyId), sql`${t.enquiries.data} ->> 'playerId' = ${playerId}`));
      let changed = 0;
      for (const r of rows.filter((x) => enquiryDirty(x.data))) {
        await tx.update(t.enquiries).set({ data: scrubEnquiry(r.data) }).where(and(eq(t.enquiries.academyId, academyId), eq(t.enquiries.id, r.id)));
        changed++;
      }
      return changed + (await dropRevisions(tx, academyId, "enquiry", rows.map((r) => r.id)));
    }
    case "GUARDIAN_LINKS": {
      const links = (await tx.select().from(t.guardianLinks).where(and(eq(t.guardianLinks.academyId, academyId), eq(t.guardianLinks.playerId, playerId)))).filter((l) => l.active || l.relationship !== "Erased");
      // Deactivated, not removed: the consent history refers to these links.
      for (const l of links)
        await tx.update(t.guardianLinks).set({ active: false, relationship: "Erased" }).where(and(eq(t.guardianLinks.academyId, academyId), eq(t.guardianLinks.playerId, playerId), eq(t.guardianLinks.userId, l.userId)));
      return links.length;
    }
    case "PLAYER_PROFILE": {
      let changed = 0;
      const [player] = await tx.select().from(t.players).where(and(eq(t.players.academyId, academyId), eq(t.players.id, playerId)));
      if (player && player.name !== ERASED_NAME) {
        await tx.update(t.players).set({ name: ERASED_NAME }).where(and(eq(t.players.academyId, academyId), eq(t.players.id, playerId)));
        changed++;
      }
      const [profile] = await tx.select().from(t.profiles).where(and(eq(t.profiles.academyId, academyId), eq(t.profiles.playerId, playerId)));
      if (profile && profileDirty(profile.data)) {
        await tx.update(t.profiles).set({ data: blankProfile, version: profile.version + 1 }).where(and(eq(t.profiles.academyId, academyId), eq(t.profiles.playerId, playerId)));
        changed++;
      }
      return changed + (await dropRevisions(tx, academyId, "player-profile", [playerId]));
    }
    default:
      // Fixed-retention categories are never executed.
      throw new Error("FIXED_CATEGORY");
  }
}
