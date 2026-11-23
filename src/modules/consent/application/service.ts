import { z } from "zod";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { shownName } from "../../identity/membership";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { can, requireCapability } from "../../identity/authority";
import { recordSecurityEvent } from "../../identity/security-events";
import type { SecurityEventName } from "../../identity/security-events";
import { DomainError } from "../../training/domain/rules";
import { denialAudited, recordAccess } from "../../audit/application/record";
import {
  requirePlayer,
  unit,
  type Tx,
} from "../../academy/application/access";
import {
  CATEGORY_LABEL,
  CONSENT_CATEGORIES,
  FLAG_KEY,
  STAFF_METHODS,
  isGranted,
  statusOf,
  type ConsentCategory,
  type ConsentDecision,
  type ConsentMethod,
} from "../domain";
/**
 * Consent management (Phase 5).
 *
 * Model: every decision is appended to `consent_event` (never updated or deleted; the database refuses
 * both) together with the exact policy version presented. `guardian_link.consent` stays as the derived
 * CURRENT state that messaging is gated on, and is changed in the same transaction as the event that
 * explains it, by `recordConsentChanges` below: the only writer of either. `unit()` locks the academy
 * row for every write, so concurrent decisions are serialised; the (subject, category, sequence)
 * uniqueness and the optional `basedOn` precondition are the backstops.
 *
 * Authority (least privilege, decided here and nowhere in the UI):
 *   GUARDIAN      their own link only, active link, children they are linked to; never another family;
 *                 never a player who is an adult managing their own consent.
 *   ADULT_PLAYER  their own record only.
 *   OWNER, ADMIN  read the history of any player of their academy; record a decision on a linked
 *                 person's behalf (method + evidence required for grants); publish consent documents.
 *   everyone else no access (coaches, head coaches, finance, nutrition professionals).
 */
type Reader = Tx | ReturnType<typeof database>;
type Link = typeof t.guardianLinks.$inferSelect;
type Version = typeof t.consentPolicyVersions.$inferSelect;
type EventRow = typeof t.consentEvents.$inferSelect;
const CATEGORY = z.enum(CONSENT_CATEGORIES);
const E = (message: string, status = 422, code?: string) =>
  new DomainError(message, status, code);
const denied = () => E("Your role cannot perform this action.", 403);
function requireConsentRole(a: Actor, extra: readonly string[] = []) {
  if (!can(a, "consent.admin") && !can(a, "consent.self") && !extra.includes(a.role)) throw denied();
}
const isAdmin = (a: Actor) => can(a, "consent.admin");
// ---------- reading ----------
/** The version of each category currently in force (the highest published one). */
export async function currentVersions(academyId: string, tx: Reader) {
  const rows = await tx
    .select()
    .from(t.consentPolicyVersions)
    .where(
      and(
        eq(t.consentPolicyVersions.academyId, academyId),
        eq(t.consentPolicyVersions.status, "PUBLISHED"),
      ),
    )
    .orderBy(desc(t.consentPolicyVersions.version));
  const map = new Map<ConsentCategory, Version>();
  for (const row of rows)
    if (!map.has(row.category as ConsentCategory))
      map.set(row.category as ConsentCategory, row);
  return map;
}
/** The most recent event of every (player, subject, category), optionally limited to some players. */
async function latestEvents(
  academyId: string,
  tx: Reader,
  where: { playerId?: string } = {},
) {
  const rows = await tx
    .select()
    .from(t.consentEvents)
    .where(
      and(
        eq(t.consentEvents.academyId, academyId),
        where.playerId ? eq(t.consentEvents.playerId, where.playerId) : undefined,
        sql`${t.consentEvents.sequence} = (select max(e2.sequence) from consent_event e2 where e2.academy_id = ${t.consentEvents.academyId} and e2.player_id = ${t.consentEvents.playerId} and e2.subject_user_id = ${t.consentEvents.subjectUserId} and e2.category = ${t.consentEvents.category})`,
      ),
    );
  const map = new Map<string, EventRow>();
  for (const row of rows)
    map.set(`${row.playerId}|${row.subjectUserId}|${row.category}`, row);
  return map;
}
/** The one person whose consent counts for an adult player who manages their own record, else null. */
export async function adultAuthority(academyId: string, playerId: string, tx: Reader) {
  const [profile] = await tx
    .select()
    .from(t.profiles)
    .where(
      and(eq(t.profiles.academyId, academyId), eq(t.profiles.playerId, playerId)),
    );
  return profile?.data.adult && profile.data.selfUserId
    ? profile.data.selfUserId
    : null;
}
const names = async (academyId: string, ids: string[], tx: Reader) => {
  if (!ids.length) return new Map<string, string>();
  const rows = await tx
    .select({ id: t.user.id, name: shownName })
    .from(t.memberships)
    .innerJoin(t.user, eq(t.user.id, t.memberships.userId))
    .where(
      and(
        eq(t.memberships.academyId, academyId),
        inArray(t.memberships.userId, ids),
      ),
    );
  return new Map(rows.map((r) => [r.id, r.name]));
};
const publicVersion = (v: Version) => ({
  id: v.id,
  category: v.category,
  version: v.version,
  title: v.title,
  body: v.body,
  publishedAt: v.publishedAt?.toISOString() ?? null,
  requireRenewal: v.requireRenewal,
});
const encodeCursor = (at: Date, id: string) =>
  Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
function decodeCursor(value: string) {
  const [iso, id, ...rest] = Buffer.from(value, "base64url")
    .toString("utf8")
    .split("|");
  const at = new Date(iso ?? "");
  if (rest.length || !id || Number.isNaN(at.getTime()))
    throw E("That page reference is not valid.", 400);
  return { at, id };
}
/**
 * One player's consent: for each visible person (the signed-in family member only, or every linked
 * person for an owner/admin) the status per category, the policy versions in force, and the history.
 */
/**
 * Phase 7: one VIEW event per consent history read (fail-closed: no event, no data); a refusal is
 * recorded as DENIED. The event names the player and counts people, never decisions or evidence.
 */
export async function consentForPlayer(a: Actor, playerId: string, query: unknown) {
  const descriptor = { category: "CONSENT", operation: "VIEW", resourceId: playerId, playerId } as const;
  return denialAudited(a, descriptor, async () => {
    const result = await consentForPlayerRead(a, playerId, query);
    await recordAccess(database(), a, {
      ...descriptor,
      context: { count: (result as { subjects?: unknown[] }).subjects?.length ?? 0 },
    });
    return result;
  });
}
async function consentForPlayerRead(a: Actor, playerId: string, query: unknown) {
  requireConsentRole(a);
  const q = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: z.string().max(300).optional(),
    })
    .parse(query ?? {});
  const db = database();
  const player = await requirePlayer(a, playerId, db);
  const authority = await adultAuthority(a.academyId, playerId, db);
  if (a.role === "GUARDIAN" && authority) throw E("Player not found.", 404);
  const links = await db
    .select()
    .from(t.guardianLinks)
    .where(
      and(
        eq(t.guardianLinks.academyId, a.academyId),
        eq(t.guardianLinks.playerId, playerId),
        isAdmin(a) ? undefined : eq(t.guardianLinks.userId, a.id),
        isAdmin(a) ? undefined : eq(t.guardianLinks.active, true),
      ),
    );
  // An adult who manages their own record: only their own consent is theirs to decide or see.
  const visible = links.filter((l) => !authority || l.userId === authority || isAdmin(a));
  const versions = await currentVersions(a.academyId, db);
  const latest = await latestEvents(a.academyId, db, { playerId });
  const subjectIds = visible.map((l) => l.userId);
  const nameOf = await names(a.academyId, [...subjectIds], db);
  const events = subjectIds.length
    ? await db
        .select()
        .from(t.consentEvents)
        .where(
          and(
            eq(t.consentEvents.academyId, a.academyId),
            eq(t.consentEvents.playerId, playerId),
            inArray(t.consentEvents.subjectUserId, subjectIds),
            q.cursor
              ? (() => {
                  const c = decodeCursor(q.cursor!);
                  return or(
                    lt(t.consentEvents.recordedAt, c.at),
                    and(
                      eq(t.consentEvents.recordedAt, c.at),
                      lt(t.consentEvents.id, c.id),
                    ),
                  );
                })()
              : undefined,
          ),
        )
        .orderBy(desc(t.consentEvents.recordedAt), desc(t.consentEvents.id))
        .limit(q.limit + 1)
    : [];
  const page = events.slice(0, q.limit);
  const versionById = new Map(
    (
      await db
        .select()
        .from(t.consentPolicyVersions)
        .where(eq(t.consentPolicyVersions.academyId, a.academyId))
    ).map((v) => [v.id, v]),
  );
  const actorNames = isAdmin(a)
    ? await names(
        a.academyId,
        [...new Set(page.map((e) => e.actorId).filter(Boolean) as string[])],
        db,
      )
    : new Map<string, string>();
  // An adult's first decision creates their own link; until then show their (empty) record.
  const subjectLinks: Link[] =
    a.role === "ADULT_PLAYER" && !visible.length
      ? [
          {
            academyId: a.academyId,
            playerId,
            userId: a.id,
            active: true,
            relationship: "Adult self",
            consent: { portal: false, email: false, whatsapp: false },
          },
        ]
      : visible;
  if (subjectLinks !== visible) nameOf.set(a.id, a.name);
  const subjects = subjectLinks.map((link) => ({
    userId: link.userId,
    name: nameOf.get(link.userId) ?? "Linked person",
    relationship: link.relationship,
    active: link.active,
    categories: CONSENT_CATEGORIES.map((category) => {
      const last = latest.get(`${playerId}|${link.userId}|${category}`) ?? null;
      const current = versions.get(category) ?? null;
      const granted = link.consent[FLAG_KEY[category]];
      return {
        category,
        label: CATEGORY_LABEL[category],
        granted,
        status: statusOf(last, current?.id ?? null, granted),
        // The sequence a decision is based on (echo it back as `basedOn` to detect concurrent change).
        sequence: last?.sequence ?? 0,
        version: last?.policyVersionId
          ? (versionById.get(last.policyVersionId)?.version ?? null)
          : null,
        since: last?.recordedAt.toISOString() ?? null,
        // Granted by someone else on this person's behalf and not yet confirmed by them, or
        // imported from before history existed.
        recordedBy:
          last && last.decision !== "WITHDRAWN" && last.decision !== "LAPSED"
            ? last.method
            : null,
      };
    }),
  }));
  return {
    player: { id: player.id, name: player.name },
    adultManagesOwnConsent: !!authority,
    canRecordOnBehalf: isAdmin(a),
    policies: CONSENT_CATEGORIES.flatMap((c) => {
      const v = versions.get(c);
      return v ? [publicVersion(v)] : [];
    }),
    subjects,
    events: page.map((e) => ({
      id: e.id,
      subjectUserId: e.subjectUserId,
      category: e.category,
      decision: e.decision,
      sequence: e.sequence,
      version: e.policyVersionId
        ? (versionById.get(e.policyVersionId)?.version ?? null)
        : null,
      method: e.method,
      actorRole: e.actorRole,
      // Staff names only for administrators; a family member is told the capacity, not the person.
      actorName: e.actorId ? (actorNames.get(e.actorId) ?? null) : null,
      authority: e.authority,
      evidenceRef: isAdmin(a) ? e.evidenceRef : null,
      reason: e.reason,
      effectiveAt: e.effectiveAt?.toISOString() ?? null,
      recordedAt: e.recordedAt.toISOString(),
      legacy: e.method === "IMPORT_LEGACY",
    })),
    nextCursor:
      events.length > q.limit && page.length
        ? encodeCursor(
            page[page.length - 1].recordedAt,
            page[page.length - 1].id,
          )
        : null,
  };
}
// ---------- writing decisions ----------
type Change = {
  category: ConsentCategory;
  action: "GRANT" | "WITHDRAW";
  versionId?: string | null;
  reason?: string | null;
};
const EVENT_NAME: Record<string, SecurityEventName> = {
  GRANTED: "CONSENT_GRANTED",
  RENEWED: "CONSENT_RENEWED",
  WITHDRAWN: "CONSENT_WITHDRAWN",
};
/**
 * The single writer of consent history and of the derived flags. Must run inside `unit()` with the
 * link already authorised by the caller. Duplicate submissions (granting what is already granted on
 * the same version, withdrawing what is not granted) are no-ops and produce no event.
 */
export async function recordConsentChanges(
  tx: Tx,
  a: Actor,
  link: Link,
  input: {
    changes: Change[];
    method: ConsentMethod;
    evidenceRef?: string | null;
    effectiveAt?: Date | null;
    basedOn?: Partial<Record<ConsentCategory, number>>;
  },
) {
  const now = new Date();
  const versions = await currentVersions(link.academyId, tx);
  const latest = await latestEvents(link.academyId, tx, { playerId: link.playerId });
  const flags = { ...link.consent };
  const done: { category: ConsentCategory; decision: ConsentDecision; eventId: string }[] = [];
  for (const change of input.changes) {
    const category = change.category;
    const last = latest.get(`${link.playerId}|${link.userId}|${category}`) ?? null;
    const expected = input.basedOn?.[category];
    if (expected !== undefined && expected !== (last?.sequence ?? 0))
      throw E(
        "This consent record changed since you opened it. Reload it and review the current state before deciding.",
        409,
        "CONSENT_CONFLICT",
      );
    const granted = flags[FLAG_KEY[category]];
    const current = versions.get(category) ?? null;
    let decision: ConsentDecision;
    let versionId: string | null;
    if (change.action === "GRANT") {
      if (current) {
        if (!change.versionId)
          throw E(
            `Present the current ${CATEGORY_LABEL[category]} document (version ${current.version}) and record which version was accepted.`,
            422,
            "VERSION_REQUIRED",
          );
        if (change.versionId !== current.id)
          throw E(
            "A newer version of this document has been published. Review it before accepting.",
            409,
            "STALE_VERSION",
          );
      } else if (change.versionId)
        throw E("No published version exists for that category.", 422, "NO_SUCH_VERSION");
      versionId = current?.id ?? null;
      const sameAsRecorded =
        !!last && isGranted(last.decision) && (last.policyVersionId ?? null) === versionId;
      // A repeat of the same decision is a duplicate submission and records nothing. The one exception
      // is the person themself confirming consent that staff recorded for them (or that was imported
      // from before history existed): that confirmation is a decision of its own and is recorded.
      const confirmsSomeoneElsesRecord =
        input.method === "PORTAL_SELF" && last?.method !== "PORTAL_SELF";
      if (granted && sameAsRecorded && !confirmsSomeoneElsesRecord) continue;
      decision = granted ? "RENEWED" : "GRANTED";
    } else {
      if (!granted) continue; // nothing to withdraw
      decision = "WITHDRAWN";
      versionId = last?.policyVersionId ?? null;
    }
    const staffMethod = (STAFF_METHODS as readonly string[]).includes(input.method);
    const effective =
      input.effectiveAt && input.effectiveAt.getTime() <= now.getTime()
        ? input.effectiveAt
        : now;
    const [event] = await tx
      .insert(t.consentEvents)
      .values({
        id: crypto.randomUUID(),
        academyId: link.academyId,
        playerId: link.playerId,
        subjectUserId: link.userId,
        category,
        sequence: (last?.sequence ?? 0) + 1,
        decision,
        policyVersionId: versionId,
        actorId: a.id,
        actorRole: a.role,
        authority: link.relationship,
        method: input.method,
        evidenceRef: staffMethod ? (input.evidenceRef?.trim() || null) : null,
        reason: change.reason?.trim() || null,
        effectiveAt: effective,
        recordedAt: now,
        previousEventId: last?.id ?? null,
        previousDecision: last?.decision ?? null,
      })
      .returning({ id: t.consentEvents.id });
    flags[FLAG_KEY[category]] = isGranted(decision);
    done.push({ category, decision, eventId: event.id });
    await recordSecurityEvent(tx, {
      event: EVENT_NAME[decision],
      academyId: link.academyId,
      actorId: a.id,
      targetUserId: link.userId,
      // Identifiers and the kind of decision only: no child's name, no document text.
      detail: {
        category,
        method: input.method,
        ref: event.id,
        ...(current && decision !== "WITHDRAWN" ? { version: current.version } : {}),
      },
    });
  }
  if (done.length)
    await tx
      .update(t.guardianLinks)
      .set({ consent: flags })
      .where(
        and(
          eq(t.guardianLinks.academyId, link.academyId),
          eq(t.guardianLinks.playerId, link.playerId),
          eq(t.guardianLinks.userId, link.userId),
        ),
      );
  return done;
}
/**
 * Family self-service by target flags (the long-standing `players/consent` shape): the person says
 * which channels they want on or off and the difference from their current state is recorded as
 * individual, versioned decisions. Unchanged channels record nothing.
 */
export async function decideFlagTargets(a: Actor, input: unknown) {
  const v = z
    .object({
      playerId: z.string().min(1).max(200),
      consent: z.object({
        portal: z.boolean(),
        email: z.boolean(),
        whatsapp: z.boolean(),
      }),
      // The document version shown for each channel being switched on (required once one is published).
      versions: z
        .object({
          portal: z.string().nullable().optional(),
          email: z.string().nullable().optional(),
          whatsapp: z.string().nullable().optional(),
        })
        .optional(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    const link = await authorisedLink(a, tx, v.playerId, undefined);
    const changes: Change[] = [];
    for (const category of CONSENT_CATEGORIES) {
      const key = FLAG_KEY[category];
      if (v.consent[key] === link.consent[key]) {
        // Switching on something already on may still be a renewal onto a newer document.
        if (!(v.consent[key] && v.versions?.[key])) continue;
      }
      changes.push(
        v.consent[key]
          ? { category, action: "GRANT", versionId: v.versions?.[key] ?? null }
          : { category, action: "WITHDRAW" },
      );
    }
    const done = await recordConsentChanges(tx, a, link, {
      changes,
      method: "PORTAL_SELF",
    });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: v.playerId,
      action: "guardian-consent",
      version: 1,
      detail: { changes: done.map((d) => `${d.category}:${d.decision}`) },
    });
    return { ok: true };
  });
}
const decideSchema = z.object({
  playerId: z.string().min(1).max(200),
  // Staff only: whose consent is being recorded. Family members always act for themselves.
  subjectUserId: z.string().min(1).max(200).optional(),
  decisions: z
    .array(
      z.object({
        category: CATEGORY,
        action: z.enum(["GRANT", "WITHDRAW"]),
        versionId: z.string().min(1).max(200).nullable().optional(),
        reason: z.string().trim().max(500).nullable().optional(),
      }),
    )
    .min(1)
    .max(CONSENT_CATEGORIES.length)
    .refine(
      (list) => new Set(list.map((d) => d.category)).size === list.length,
      "Each category may appear once.",
    ),
  method: z.enum(STAFF_METHODS).optional(),
  evidenceRef: z.string().trim().max(500).optional(),
  effectiveAt: z.iso.datetime().optional(),
  basedOn: z
    .object({
      PORTAL: z.number().int().min(0).optional(),
      EMAIL: z.number().int().min(0).optional(),
      WHATSAPP: z.number().int().min(0).optional(),
    })
    .optional(),
});
/** Locks and returns the link a decision is about, after every authorisation check. */
async function authorisedLink(
  a: Actor,
  tx: Tx,
  playerId: string,
  subjectUserId: string | undefined,
) {
  await requirePlayer(a, playerId, tx);
  const authority = await adultAuthority(a.academyId, playerId, tx);
  let subject: string;
  if (isAdmin(a)) {
    if (!subjectUserId) throw E("Choose whose consent is being recorded.");
    subject = subjectUserId;
  } else {
    // A forged subject is not an error to explain: family members only ever act for themselves.
    if (subjectUserId && subjectUserId !== a.id) throw denied();
    subject = a.id;
  }
  if (authority) {
    // The adult decides for themself; a guardian (or staff naming one) cannot stand in for them.
    if (a.role === "GUARDIAN") throw E("Player not found.", 404);
    if (subject !== authority)
      throw E("This player manages their own consent.", 403);
  }
  const [existing] = await tx
    .select()
    .from(t.guardianLinks)
    .where(
      and(
        eq(t.guardianLinks.academyId, a.academyId),
        eq(t.guardianLinks.playerId, playerId),
        eq(t.guardianLinks.userId, subject),
      ),
    )
    .for("update");
  if (existing) {
    if (!existing.active) throw E("Guardian link not found.", 404);
    return existing;
  }
  if (a.role === "ADULT_PLAYER" && subject === a.id) {
    // First decision of an adult managing their own record: their own link, with nothing granted.
    const [created] = await tx
      .insert(t.guardianLinks)
      .values({
        academyId: a.academyId,
        playerId,
        userId: a.id,
        active: true,
        relationship: "Adult self",
        consent: { portal: false, email: false, whatsapp: false },
      })
      .returning();
    return created;
  }
  throw E("Guardian link not found.", 404);
}
/** Grant, renew or withdraw consent for one or more categories (the API behind the consent panel). */
export async function decideConsent(a: Actor, input: unknown) {
  requireConsentRole(a);
  const v = decideSchema.parse(input);
  const staff = isAdmin(a);
  if (staff) {
    if (!v.method)
      throw E("Say how the decision was received (written or verbal).", 422, "METHOD_REQUIRED");
    if (v.decisions.some((d) => d.action === "GRANT") && !v.evidenceRef)
      throw E(
        "Recording consent on someone's behalf needs a reference to the evidence (for example a form number).",
        422,
        "EVIDENCE_REQUIRED",
      );
  } else if (v.method || v.evidenceRef || v.effectiveAt)
    throw E("Consent given through the portal is recorded as given by you.", 422);
  return unit(a, async (tx) => {
    const link = await authorisedLink(a, tx, v.playerId, v.subjectUserId);
    const done = await recordConsentChanges(tx, a, link, {
      changes: v.decisions,
      method: staff ? (v.method as ConsentMethod) : "PORTAL_SELF",
      evidenceRef: v.evidenceRef,
      effectiveAt: v.effectiveAt ? new Date(v.effectiveAt) : null,
      basedOn: v.basedOn,
    });
    if (done.length)
      await tx.insert(t.audit).values({
        id: crypto.randomUUID(),
        academyId: a.academyId,
        actorId: a.id,
        entityId: v.playerId,
        action: "consent-decision",
        version: 1,
        // Categories and kinds only.
        detail: { changes: done.map((d) => `${d.category}:${d.decision}`) },
      });
    return { ok: true, changes: done.map(({ category, decision }) => ({ category, decision })) };
  });
}
// ---------- consent documents ----------
const versionInput = z.object({
  id: z.string().min(1).max(200).optional(),
  category: CATEGORY,
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(20).max(20000),
});
/** Create the open draft of a category's next version, or edit that draft. Published text is frozen. */
export async function saveConsentVersion(a: Actor, input: unknown) {
  requireCapability(a, "consent.admin");
  const v = versionInput.parse(input);
  return unit(a, async (tx) => {
    const [draft] = await tx
      .select()
      .from(t.consentPolicyVersions)
      .where(
        and(
          eq(t.consentPolicyVersions.academyId, a.academyId),
          eq(t.consentPolicyVersions.category, v.category),
          eq(t.consentPolicyVersions.status, "DRAFT"),
        ),
      );
    if (v.id) {
      const [target] = await tx
        .select()
        .from(t.consentPolicyVersions)
        .where(
          and(
            eq(t.consentPolicyVersions.academyId, a.academyId),
            eq(t.consentPolicyVersions.id, v.id),
          ),
        );
      if (!target) throw E("Consent version not found.", 404);
      if (target.status !== "DRAFT")
        throw E(
          "A published version cannot be changed. Create a new version instead.",
          409,
          "VERSION_PUBLISHED",
        );
      if (target.category !== v.category) throw E("A version's category cannot change.");
      await tx
        .update(t.consentPolicyVersions)
        .set({ title: v.title, body: v.body })
        .where(eq(t.consentPolicyVersions.id, target.id));
      await recordSecurityEvent(tx, {
        event: "CONSENT_VERSION_SAVED",
        academyId: a.academyId,
        actorId: a.id,
        detail: { category: v.category, version: target.version, ref: target.id },
      });
      return { id: target.id, version: target.version };
    }
    if (draft)
      throw E(
        "A draft already exists for this category. Edit it or publish it first.",
        409,
        "DRAFT_EXISTS",
      );
    const [last] = await tx
      .select({ version: t.consentPolicyVersions.version })
      .from(t.consentPolicyVersions)
      .where(
        and(
          eq(t.consentPolicyVersions.academyId, a.academyId),
          eq(t.consentPolicyVersions.category, v.category),
        ),
      )
      .orderBy(desc(t.consentPolicyVersions.version))
      .limit(1);
    const id = crypto.randomUUID();
    const version = (last?.version ?? 0) + 1;
    await tx.insert(t.consentPolicyVersions).values({
      id,
      academyId: a.academyId,
      category: v.category,
      version,
      title: v.title,
      body: v.body,
      createdBy: a.id,
    });
    await recordSecurityEvent(tx, {
      event: "CONSENT_VERSION_SAVED",
      academyId: a.academyId,
      actorId: a.id,
      detail: { category: v.category, version, ref: id },
    });
    return { id, version };
  });
}
/**
 * Publish a draft. It becomes the version in force immediately. Nobody is treated as having accepted
 * it: people whose consent rests on an earlier (or no recorded) version are shown as "renewal
 * requested", and when `requireRenewal` is chosen their earlier consent LAPSES through explicit,
 * attributed events until they accept the new text.
 */
export async function publishConsentVersion(a: Actor, input: unknown) {
  requireCapability(a, "consent.admin");
  const v = z
    .object({
      id: z.string().min(1).max(200),
      requireRenewal: z.boolean(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    const [draft] = await tx
      .select()
      .from(t.consentPolicyVersions)
      .where(
        and(
          eq(t.consentPolicyVersions.academyId, a.academyId),
          eq(t.consentPolicyVersions.id, v.id),
        ),
      );
    if (!draft) throw E("Consent version not found.", 404);
    if (draft.status !== "DRAFT")
      throw E("This version is already published.", 409, "VERSION_PUBLISHED");
    const now = new Date();
    await tx
      .update(t.consentPolicyVersions)
      .set({
        status: "PUBLISHED",
        requireRenewal: v.requireRenewal,
        publishedBy: a.id,
        publishedAt: now,
        effectiveAt: now,
      })
      .where(eq(t.consentPolicyVersions.id, draft.id));
    let lapsed = 0;
    if (v.requireRenewal) {
      const category = draft.category as ConsentCategory;
      const latest = await latestEvents(a.academyId, tx);
      const links = await tx
        .select()
        .from(t.guardianLinks)
        .where(eq(t.guardianLinks.academyId, a.academyId));
      for (const link of links) {
        if (!link.consent[FLAG_KEY[category]]) continue;
        const last = latest.get(`${link.playerId}|${link.userId}|${category}`) ?? null;
        await tx.insert(t.consentEvents).values({
          id: crypto.randomUUID(),
          academyId: a.academyId,
          playerId: link.playerId,
          subjectUserId: link.userId,
          category,
          sequence: (last?.sequence ?? 0) + 1,
          decision: "LAPSED",
          policyVersionId: draft.id,
          actorId: a.id,
          actorRole: a.role,
          authority: link.relationship,
          method: "SYSTEM_POLICY",
          reason: `Version ${draft.version} requires renewed consent.`,
          effectiveAt: now,
          recordedAt: now,
          previousEventId: last?.id ?? null,
          previousDecision: last?.decision ?? null,
        });
        await tx
          .update(t.guardianLinks)
          .set({ consent: { ...link.consent, [FLAG_KEY[category]]: false } })
          .where(
            and(
              eq(t.guardianLinks.academyId, link.academyId),
              eq(t.guardianLinks.playerId, link.playerId),
              eq(t.guardianLinks.userId, link.userId),
            ),
          );
        lapsed++;
      }
    }
    await recordSecurityEvent(tx, {
      event: "CONSENT_VERSION_PUBLISHED",
      academyId: a.academyId,
      actorId: a.id,
      detail: {
        category: draft.category,
        version: draft.version,
        requireRenewal: v.requireRenewal,
        lapsed,
        ref: draft.id,
      },
    });
    return { id: draft.id, version: draft.version, lapsed };
  });
}
// ---------- administration views ----------
/** Consent documents and who is affected by them (owner/admin; family members get the current texts). */
export async function consentPolicies(a: Actor) {
  requireConsentRole(a);
  const db = database();
  const versions = await currentVersions(a.academyId, db);
  const current = CONSENT_CATEGORIES.flatMap((c) => {
    const v = versions.get(c);
    return v ? [publicVersion(v)] : [];
  });
  if (!isAdmin(a)) return { current, versions: [], drafts: [] };
  const all = await db
    .select()
    .from(t.consentPolicyVersions)
    .where(eq(t.consentPolicyVersions.academyId, a.academyId))
    .orderBy(asc(t.consentPolicyVersions.category), desc(t.consentPolicyVersions.version));
  return {
    current,
    versions: all
      .filter((v) => v.status === "PUBLISHED")
      .map((v) => ({
        ...publicVersion(v),
        publishedBy: v.publishedBy,
      })),
    drafts: all
      .filter((v) => v.status === "DRAFT")
      .map((v) => ({
        id: v.id,
        category: v.category,
        version: v.version,
        title: v.title,
        body: v.body,
      })),
  };
}
/** Owner/admin report: how many people are in each state per category, and who needs to renew. */
export async function consentReport(a: Actor) {
  return denialAudited(a, { category: "CONSENT", operation: "BULK" }, async () => {
    const result = await consentReportRead(a);
    await recordAccess(database(), a, {
      category: "CONSENT",
      operation: "BULK",
      context: { count: result.renewals.length },
    });
    return result;
  });
}
async function consentReportRead(a: Actor) {
  requireCapability(a, "consent.admin");
  const db = database();
  const versions = await currentVersions(a.academyId, db);
  const latest = await latestEvents(a.academyId, db);
  const links = await db
    .select({ link: t.guardianLinks, player: t.players.name })
    .from(t.guardianLinks)
    .innerJoin(
      t.players,
      and(
        eq(t.players.academyId, t.guardianLinks.academyId),
        eq(t.players.id, t.guardianLinks.playerId),
      ),
    )
    .where(
      and(eq(t.guardianLinks.academyId, a.academyId), eq(t.guardianLinks.active, true)),
    );
  const nameOf = await names(a.academyId, [...new Set(links.map((l) => l.link.userId))], db);
  const counts = Object.fromEntries(
    CONSENT_CATEGORIES.map((c) => [
      c,
      { CURRENT: 0, RENEWAL_REQUESTED: 0, LAPSED: 0, WITHDRAWN: 0, NONE: 0, UNRECORDED: 0 },
    ]),
  ) as unknown as Record<ConsentCategory, Record<string, number>>;
  const renewals: {
    playerId: string;
    playerName: string;
    subjectUserId: string;
    subjectName: string;
    category: ConsentCategory;
    status: string;
  }[] = [];
  for (const { link, player } of links)
    for (const category of CONSENT_CATEGORIES) {
      const last = latest.get(`${link.playerId}|${link.userId}|${category}`) ?? null;
      const status = statusOf(
        last,
        versions.get(category)?.id ?? null,
        link.consent[FLAG_KEY[category]],
      );
      counts[category][status]++;
      if ((status === "RENEWAL_REQUESTED" || status === "LAPSED") && renewals.length < 200)
        renewals.push({
          playerId: link.playerId,
          playerName: player,
          subjectUserId: link.userId,
          subjectName: nameOf.get(link.userId) ?? "Linked person",
          category,
          status,
        });
    }
  return {
    currentVersions: Object.fromEntries(
      CONSENT_CATEGORIES.map((c) => [c, versions.get(c)?.version ?? null]),
    ),
    counts,
    renewals,
    // Links whose flag disagrees with their history (should be zero; see CONSENT.md).
    unrecorded: Object.values(counts).reduce((n, c) => n + c.UNRECORDED, 0),
  };
}
