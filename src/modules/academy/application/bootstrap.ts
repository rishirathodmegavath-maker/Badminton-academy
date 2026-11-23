import { publicSettings } from "../../settings/domain/logo";
import { eq, desc, and, inArray } from "drizzle-orm";
import { shownName } from "../../identity/membership";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import {
  accessiblePlayers,
  billablePlayers,
  family,
  financeRoles,
  coachingRoles,
  opsRoles,
  defaultProfile,
} from "./access";
import { defaultSettings, type ProfileData } from "../domain/types";
import { publicationState, type PublishedKind } from "../domain/withdrawal";
import { withdrawalOf } from "../domain/withdrawal";
import { recordAccess } from "../../audit/application/record";
import { bootstrapFamily } from "./bootstrap-family";
import { requireCapability } from "../../identity/authority";
type Jsonify<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;
export type AcademyData = Awaited<ReturnType<typeof bootstrapStaff>>;
export type AcademyPayload = Jsonify<AcademyData>;
/** The workspace read model of the signed-in actor. */
export async function bootstrapAcademy(a: Actor): Promise<AcademyData> {
  // Stage 5F: family accounts have their own loader, which reads only that family's records.
  if (family(a)) return bootstrapFamily(a);
  return bootstrapStaff(a);
}
// Staff read model. Family actors return above, so the `own` branches below are no longer reached; they are kept
// unchanged in Stage 5F so this path stays exactly as it was (removing them is a separate clean-up).
async function bootstrapStaff(a: Actor) {
  // RC-5: the staff read model is served only to an account holding `portal.staff`, before anything is read.
  // resolveActor already refuses roles outside the eight; this keeps the read model closed on its own.
  requireCapability(a, "portal.staff");
  const db = database();
  const academy = a.academyId;
  const own = family(a);
  const finance = financeRoles.includes(a.role);
  const coaching = coachingRoles.includes(a.role);
  const ops = opsRoles.includes(a.role);
  const professional = a.role === "NUTRITION_PRO";
  // FINANCE and NUTRITION_PRO get purpose-built projections, never the staff read model:
  //   FINANCE       money records plus the bare billing roster (player id and name)
  //   NUTRITION_PRO only the players assigned to them and the nutrition records of those players
  const moneyOnly = a.role === "FINANCE";
  const narrow = moneyOnly || professional;
  const visiblePlayers = moneyOnly
    ? await billablePlayers(a)
    : await accessiblePlayers(a);
  const playerIds = new Set(visiblePlayers.map((p) => p.id));
  const [
    settingRows,
    entitlementRows,
    profiles,
    branches,
    batches,
    members,
    links,
    enquiries,
    events,
    sessions,
    plans,
    invoices,
    payments,
    refunds,
    credits,
    reports,
    reviews,
    nutrition,
    restrictions,
    questions,
    messages,
    deliveries,
    templates,
    conversations,
    media,
    history,
    versions,
    audits,
    assignments,
  ] = await Promise.all([
    db
      .select()
      .from(t.academySettings)
      .where(eq(t.academySettings.academyId, academy)),
    db
      .select()
      .from(t.entitlements)
      .where(eq(t.entitlements.academyId, academy)),
    db.select().from(t.profiles).where(eq(t.profiles.academyId, academy)),
    db.select().from(t.branches).where(eq(t.branches.academyId, academy)),
    db.select().from(t.batches).where(eq(t.batches.academyId, academy)),
    db
      .select({
        id: t.user.id,
        name: shownName,
        email: t.user.email,
        role: t.memberships.role,
        active: t.memberships.active,
      })
      .from(t.memberships)
      .innerJoin(t.user, eq(t.user.id, t.memberships.userId))
      .where(eq(t.memberships.academyId, academy)),
    db
      .select()
      .from(t.guardianLinks)
      .where(eq(t.guardianLinks.academyId, academy)),
    ops
      ? db.select().from(t.enquiries).where(eq(t.enquiries.academyId, academy))
      : [],
    narrow
      ? []
      : db
          .select()
          .from(t.calendarEvents)
          .where(eq(t.calendarEvents.academyId, academy)),
    coaching || own
      ? db
          .select()
          .from(t.trainingSessions)
          .where(eq(t.trainingSessions.academyId, academy))
      : [],
    finance
      ? db.select().from(t.feePlans).where(eq(t.feePlans.academyId, academy))
      : [],
    finance || own
      ? db.select().from(t.invoices).where(eq(t.invoices.academyId, academy))
      : [],
    finance || own
      ? db.select().from(t.payments).where(eq(t.payments.academyId, academy))
      : [],
    finance || own
      ? db.select().from(t.refunds).where(eq(t.refunds.academyId, academy))
      : [],
    finance || own
      ? db
          .select()
          .from(t.lessonCredits)
          .where(eq(t.lessonCredits.academyId, academy))
      : [],
    coaching || own
      ? db.select().from(t.reports).where(eq(t.reports.academyId, academy))
      : [],
    coaching
      ? db
          .select()
          .from(t.observationReviews)
          .where(eq(t.observationReviews.academyId, academy))
      : [],
    coaching || professional || own
      ? db
          .select()
          .from(t.nutritionPlans)
          .where(eq(t.nutritionPlans.academyId, academy))
      : [],
    professional || own
      ? db
          .select()
          .from(t.restrictedNutrition)
          .where(eq(t.restrictedNutrition.academyId, academy))
      : [],
    professional || own
      ? db
          .select()
          .from(t.nutritionQuestions)
          .where(eq(t.nutritionQuestions.academyId, academy))
      : [],
    coaching || own
      ? db.select().from(t.messages).where(eq(t.messages.academyId, academy))
      : [],
    coaching || own
      ? db
          .select()
          .from(t.deliveries)
          .where(eq(t.deliveries.academyId, academy))
      : [],
    coaching
      ? db
          .select()
          .from(t.messageTemplates)
          .where(eq(t.messageTemplates.academyId, academy))
      : [],
    coaching || own
      ? db
          .select()
          .from(t.conversations)
          .where(eq(t.conversations.academyId, academy))
      : [],
    coaching || own
      ? db
          .select()
          .from(t.mediaAssets)
          .where(eq(t.mediaAssets.academyId, academy))
      : [],
    !own && !narrow
      ? db
          .select()
          .from(t.playerHistory)
          .where(eq(t.playerHistory.academyId, academy))
      : [],
    db
      .select()
      .from(t.recordRevisions)
      .where(eq(t.recordRevisions.academyId, academy))
      .orderBy(desc(t.recordRevisions.version)),
    ops
      ? db
          .select({
            id: t.audit.id,
            entityId: t.audit.entityId,
            action: t.audit.action,
            actorId: t.audit.actorId,
            version: t.audit.version,
            createdAt: t.audit.createdAt,
          })
          .from(t.audit)
          .where(eq(t.audit.academyId, academy))
          .orderBy(desc(t.audit.createdAt))
          .limit(100)
      : [],
    // Who looks after which player's nutrition: managed by owner/admin, visible to the professional
    // themself, nobody else.
    a.role === "OWNER" || a.role === "ADMIN" || professional
      ? db
          .select()
          .from(t.nutritionAssignments)
          .where(
            professional
              ? and(
                  eq(t.nutritionAssignments.academyId, academy),
                  eq(t.nutritionAssignments.professionalId, a.id),
                )
              : eq(t.nutritionAssignments.academyId, academy),
          )
      : [],
  ]);
  // Stage 5E: series versions for the roles that can change events (optimistic checks on series changes).
  const calendarSeries = ops
    ? await db
        .select({
          id: t.calendarSeries.id,
          version: t.calendarSeries.version,
          kind: t.calendarSeries.kind,
          splitFrom: t.calendarSeries.splitFrom,
        })
        .from(t.calendarSeries)
        .where(eq(t.calendarSeries.academyId, academy))
    : [];
  const settings = settingRows[0] ?? {
    academyId: academy,
    version: 1,
    data: defaultSettings,
  };
  const entitlements = entitlementRows[0]?.data ?? {};
  const enabled = (key: keyof typeof defaultSettings.features) =>
    !!entitlements[key] && settings.data.features[key];
  const lastShared = <
    T extends { id: string; status: string; version: number; data: unknown },
  >(
    row: T,
    kind: string,
    status: string,
  ): T | null => {
    if (row.status === status) return row;
    // The newest revision in the shared state, unless a withdrawal came after it (Phase 6).
    const old = publicationState(
      versions.filter((v) => v.entityId === row.id),
      kind as PublishedKind,
    ).live;
    return old
      ? ({
          ...row,
          version: old.version,
          status,
          data: (old.data as { data: unknown }).data,
        } as T)
      : null;
  };
  const visibleInvoices = invoices.filter(
    (i) =>
      !own ||
      (i.data.playerIds.every((id) => playerIds.has(id)) &&
        (!i.data.familyUserId || i.data.familyUserId === a.id)),
  );
  const invoiceIds = new Set(visibleInvoices.map((i) => i.id));
  const visiblePayments = payments.filter((p) => invoiceIds.has(p.invoiceId));
  const paymentIds = new Set(visiblePayments.map((p) => p.id));
  const visibleRefunds = refunds.filter((r) => paymentIds.has(r.paymentId));
  const visibleReports = enabled("reports")
    ? reports
        .filter((r) => playerIds.has(r.playerId))
        .flatMap((r) =>
          own
            ? lastShared(r, "report", "PUBLISHED")
              ? [lastShared(r, "report", "PUBLISHED")!]
              : []
            : [r],
        )
    : [];
  const visibleNutrition = enabled("nutrition")
    ? nutrition
        .filter((n) => playerIds.has(n.playerId))
        .flatMap((n) =>
          own
            ? lastShared(n, "nutrition-plan", "SHARED")
              ? [lastShared(n, "nutrition-plan", "SHARED")!]
              : []
            : [n],
        )
    : [];
  const playerRecords = visiblePlayers.map((p) => {
    const profile = profiles.find((pr) => pr.playerId === p.id);
    if (narrow) {
      // Explicit allow-list: name and batch for identification, and only the status flag of the
      // profile. Contact details, birth date, notes and preferences never leave the server.
      const bare: ProfileData = {
        ...defaultProfile,
        status: profile?.data.status ?? defaultProfile.status,
      };
      return { ...p, version: 1, profile: bare };
    }
    return {
      ...p,
      version: profile?.version ?? 1,
      profile: own
        ? { ...defaultProfile, ...profile?.data, notes: "" }
        : (profile?.data ?? defaultProfile),
    };
  });
  const visibleSessions = sessions.filter((s) =>
    own
      ? s.status !== "DRAFT" &&
        s.status !== "CANCELLED" &&
        s.data.roster.some((p) => playerIds.has(p.id))
      : a.role !== "COACH" || s.coachId === a.id,
  );
  const safeSessions = visibleSessions.map((s) => ({
    id: s.id,
    version: s.version,
    status: s.status,
    coachId: s.coachId,
    batchId: s.batchId,
    data: own
      ? {
          title: s.data.title,
          localDate: s.data.localDate,
          localTime: s.data.localTime,
          duration: s.data.duration,
          timezone: s.data.timezone,
          branchId: s.data.branchId,
          objective: s.data.objective,
          activities: s.data.activities.map((act) => ({
            id: act.id,
            title: act.title,
            minutes: act.minutes,
          })),
          adjustments: s.data.adjustments.filter((ad) =>
            playerIds.has(ad.playerId),
          ),
          attendance: Object.fromEntries(
            Object.entries(s.data.attendance).filter(([id]) =>
              playerIds.has(id),
            ),
          ),
          observations: [],
          roster: [],
          recap: "",
          actuals: {},
          coachId: s.coachId,
          batchId: s.batchId,
          startsAt: s.data.startsAt,
          progress: { index: 0, elapsed: 0, runningSince: null },
        }
      : s.data,
  }));
  const visibleDeliveries = deliveries.filter((d) =>
    own
      ? d.userId === a.id
      : a.role !== "COACH" ||
        messages.some((m) => m.id === d.messageId && m.authorId === a.id),
  );
  const portalIds = new Set(
    visibleDeliveries
      .filter(
        (d) =>
          d.userId === a.id &&
          d.channel === "PORTAL" &&
          d.status === "AVAILABLE_IN_PORTAL",
      )
      .map((d) => d.messageId),
  );
  const visibleMessages = enabled("communications")
    ? messages
        .filter(
          (m) =>
            (!own && (a.role !== "COACH" || m.authorId === a.id)) ||
            (portalIds.has(m.id) &&
              m.data.recipients.some(
                (r) =>
                  r.userId === a.id &&
                  r.playerIds.some((id) => playerIds.has(id)) &&
                  links.some(
                    (l) =>
                      l.userId === a.id &&
                      l.active &&
                      r.playerIds.includes(l.playerId),
                  ),
              )),
        )
        .map((m) =>
          own
            ? {
                ...m,
                data: {
                  ...m.data,
                  recipients: [],
                  playerIds: m.data.playerIds.filter((id) => playerIds.has(id)),
                  batchIds: [],
                  approvedBy: null,
                  approvalHash: null,
                },
              }
            : m,
        )
    : [];
  const messageActivity = visibleMessages.length
    ? await db
        .select({ entityId: t.audit.entityId, at: t.audit.createdAt })
        .from(t.audit)
        .where(
          and(
            eq(t.audit.academyId, academy),
            inArray(
              t.audit.entityId,
              visibleMessages.map((m) => m.id),
            ),
          ),
        )
        .orderBy(desc(t.audit.createdAt))
    : [];
  const invoiceSummaries = visibleInvoices.map((i) => {
    const verified = visiblePayments
      .filter((p) => p.invoiceId === i.id && p.status === "VERIFIED")
      .reduce((sum, p) => sum + p.data.amount, 0);
    const refunded = visibleRefunds
      .filter((r) =>
        visiblePayments.some(
          (p) => p.id === r.paymentId && p.invoiceId === i.id,
        ),
      )
      .reduce((sum, r) => sum + r.amount, 0);
    return {
      ...i,
      verified,
      refunded,
      balance: i.status === "VOID" ? 0 : i.data.total - verified + refunded,
    };
  });
  const currentDate = new Date().toLocaleDateString("en-CA", {
    timeZone: a.timezone,
  });
  const goals = coaching
    ? await db.select().from(t.goals).where(eq(t.goals.academyId, academy))
    : [];
  const payload = {
    goals: goals.filter((g) => playerIds.has(g.playerId)),
    actor: a,
    development: process.env.NODE_ENV !== "production",
    permissions: {
      ops,
      finance,
      coaching,
      professional,
      family: own,
      owner: a.role === "OWNER",
    },
    academy: { id: academy, name: a.academyName, timezone: a.timezone },
    settings: publicSettings(settings),
    entitlements,
    enabled: {
      reports: enabled("reports"),
      nutrition: enabled("nutrition"),
      communications: enabled("communications"),
      manualVideo: enabled("manualVideo"),
    },
    players: playerRecords,
    branches,
    // Batch names only; the coach behind a batch is staff information.
    batches: narrow
      ? batches
          .filter((b) => visiblePlayers.some((p) => p.batchId === b.id))
          .map((b) => ({ ...b, coachId: "" }))
      : batches.filter(
          (b) =>
            (!own && a.role !== "COACH") ||
            b.coachId === a.id ||
            visiblePlayers.some((p) => p.batchId === b.id),
        ),
    // FINANCE sees itself and the billing contacts named on invoices (name only, no e-mail);
    // NUTRITION_PRO sees itself. Neither can enumerate other accounts.
    members: narrow
      ? members
          .filter(
            (m) =>
              m.id === a.id ||
              (moneyOnly &&
                invoices.some((i) => i.data.familyUserId === m.id)),
          )
          .map((m) => (m.id === a.id ? m : { ...m, email: "" }))
      : members.filter((m) =>
          own
            ? m.id === a.id
            : a.role !== "COACH" ||
              m.id === a.id ||
              links.some(
                (l) =>
                  l.userId === m.id && l.active && playerIds.has(l.playerId),
              ),
        ),
    // Consent records are never part of the finance or nutrition read model, and a coach has no use
    // for families' consent flags or guardian links (Phase 5, least privilege).
    guardianLinks: narrow || a.role === "COACH"
      ? []
      : links.filter(
          (l) => playerIds.has(l.playerId) && (!own || l.userId === a.id),
        ),
    enquiries,
    events: (narrow ? [] : events)
      .filter(
        (e) =>
          (!own &&
            (a.role !== "COACH" ||
              e.data.coachId === a.id ||
              e.kind === "CLOSURE")) ||
          (own && e.data.playerIds.some((id) => playerIds.has(id))),
      )
      .map((e) => {
        if (!own) return e;
        // Families keep the event shape they had before Stage 5E: the series bookkeeping, the list of
        // individually changed fields and the staff's cancellation note are staff information.
        const { seriesId: _series, occurrenceDate: _occurrence, ...row } = e;
        const { overrides: _overrides, cancellation: _cancellation, ...data } = e.data;
        return {
          ...row,
          data: {
            ...data,
            playerIds: e.data.playerIds.filter((id) => playerIds.has(id)),
            enquiryId: null,
          },
        };
      }),
    calendarSeries,
    sessions: safeSessions,
    feePlans: plans,
    invoices: invoiceSummaries,
    // The canonical reference and the rejection column are internal (the decision is also in data).
    payments: visiblePayments.map(
      ({ referenceKey: _key, rejectionKind: _kind, ...payment }) => payment,
    ),
    refunds: visibleRefunds,
    credits: credits.filter((c) => playerIds.has(c.playerId)),
    reports: visibleReports,
    reviews: reviews.filter((r) =>
      visibleSessions.some((s) => s.id === r.sessionId),
    ),
    nutrition: visibleNutrition,
    restrictions: enabled("nutrition")
      ? restrictions.filter((r) => playerIds.has(r.playerId))
      : [],
    questions: enabled("nutrition")
      ? questions.filter(
          (q) => playerIds.has(q.playerId) && (!own || q.authorId === a.id),
        )
      : [],
    messages: visibleMessages.map((m) => ({
      ...m,
      updatedAt:
        messageActivity
          .find((event) => event.entityId === m.id)
          ?.at.toISOString() ?? null,
    })),
    deliveries: visibleDeliveries,
    templates,
    conversations: enabled("communications")
      ? conversations.filter(
          (c) =>
            (!own || c.guardianId === a.id) &&
            playerIds.has(c.playerId) &&
            links.some(
              (l) =>
                l.userId === c.guardianId &&
                l.active &&
                playerIds.has(l.playerId),
            ),
        )
      : [],
    media: enabled("manualVideo")
      ? media
          .filter(
            (m) =>
              playerIds.has(m.playerId) &&
              (!own || m.status === "SHARED") &&
              m.expiresAt.getTime() > Date.now(),
          )
          .map(({ storageKey, ...metadata }) => metadata)
      : [],
    history: history.filter((h) => playerIds.has(h.playerId)),
    versions: own || moneyOnly
      ? []
      : professional
        ? versions.filter(
            (v) =>
              v.kind === "nutrition-plan" &&
              playerIds.has(
                (v.data as { data?: { playerId?: string } }).data?.playerId ??
                  "",
              ),
          )
        : versions.filter(
          (v) =>
            (ops && ["enquiry", "calendar-event"].includes(v.kind)) ||
            (["report", "nutrition-plan", "player-profile"].includes(v.kind) &&
              ((v.data as { data?: { playerId?: string }; playerId?: string })
                .data?.playerId
                ? playerIds.has(
                    (v.data as { data: { playerId: string } }).data.playerId,
                  )
                : v.kind === "player-profile" && playerIds.has(v.entityId))),
        ),
    audits,
    assignments: assignments.map((r) => ({
      playerId: r.playerId,
      professionalId: r.professionalId,
      active: r.active,
      updatedAt: r.updatedAt,
    })),
    summary: {
      activePlayers: playerRecords.filter((p) => p.profile.status === "ACTIVE")
        .length,
      upcoming: safeSessions.filter(
        (s) => s.status === "PUBLISHED" && s.data.localDate >= currentDate,
      ).length,
      followUps: enquiries.filter(
        (e) =>
          e.status !== "ENROLLED" &&
          e.status !== "CLOSED" &&
          e.data.followUpDate &&
          e.data.followUpDate <= currentDate,
      ).length,
      reviews: visibleReports.filter((r) => r.status === "IN_REVIEW").length,
      outstanding: invoiceSummaries
        .filter((i) => i.data.currency === settings.data.currency)
        .reduce((sum, i) => sum + i.balance, 0),
      overdue: invoiceSummaries
        .filter(
          (i) =>
            i.data.currency === settings.data.currency &&
            i.data.dueDate < currentDate,
        )
        .reduce((sum, i) => sum + i.balance, 0),
      pendingPayments: visiblePayments.filter((p) => p.status === "SUBMITTED")
        .length,
    },
    currentDate,
  };
  // Phase 7: one event per load of the workspace, with counts of what it contained (never the data).
  // Fail-closed: if it cannot be recorded, nothing is returned.
  await recordAccess(db, a, {
    category: "WORKSPACE",
    operation: own || professional ? "LIST" : "BULK",
    context: {
      counts: {
        players: payload.players.length,
        guardianLinks: payload.guardianLinks.length,
        reports: payload.reports.length,
        nutrition: payload.nutrition.length,
        restrictions: payload.restrictions.length,
        questions: payload.questions.length,
        invoices: payload.invoices.length,
        payments: payload.payments.length,
        media: payload.media.length,
        messages: payload.messages.length,
        conversations: payload.conversations.length,
        history: payload.history.length,
        versions: payload.versions.length,
        withdrawn: payload.versions.filter((v) => withdrawalOf(v)).length,
        sessions: payload.sessions.length,
        events: payload.events.length,
        members: payload.members.length,
      },
    },
  });
  return payload;
}
