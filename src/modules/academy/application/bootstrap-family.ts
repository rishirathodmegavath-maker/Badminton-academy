import { publicSettings } from "../../settings/domain/logo";
import { and, desc, eq, getTableColumns, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import { shownName } from "../../identity/membership";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { defaultProfile, familyScope } from "./access";
import { defaultSettings } from "../domain/types";
import { publicationState, type PublishedKind } from "../domain/withdrawal";
import { recordAccess } from "../../audit/application/record";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { AcademyData } from "./bootstrap";
import type { GuardianAccessScope } from "../domain/guardian-access";
/**
 * Stage 5F: the workspace read model of a family account (GUARDIAN, ADULT_PLAYER).
 *
 * Same response as the family branch of the shared loader had, but every query that touches family data is limited
 * in SQL to this academy AND to this account's children, its own user id, or ids derived from those rows. Nothing
 * academy-wide that holds another family's data is read. The JavaScript checks of the shared loader still run on
 * the (already narrowed) rows as a second layer.
 *
 * Read only from the actor; never cached.
 *
 * RC-4: a guardian reads an ADULT player's record only through that adult's grant, section by section. Every
 * child-keyed query below is therefore keyed by the children for which the account holds THAT section
 * (FamilyScope.ids), in SQL and again in the JavaScript layer; a section that is not granted is not read at all.
 * A minor's guardian and the adult themself hold every section, so their response is what it was before.
 */
/** A non-empty id list for an IN / ANY clause. An empty list is a programming error, never "no filter". */
function ids(values: Iterable<string>) {
  const list = [...new Set(values)];
  if (!list.length)
    throw new Error("Stage 5F: a family query was built with an empty id list.");
  return list;
}
const textArray = (values: Iterable<string>) =>
  sql`ARRAY[${sql.join(
    ids(values).map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;
/** Table columns minus the ones a family response never contains. */
function columnsWithout<T extends Record<string, unknown>, K extends keyof T>(
  columns: T,
  ...drop: K[]
): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(columns).filter(([key]) => !drop.includes(key as K)),
  ) as Omit<T, K>;
}
// JSON-held relations, written to match the JavaScript rules below. A value that is not an array never matches.
/** calendar_event.data.playerIds contains at least one of the children (JS: playerIds.some(visible)). */
const eventHasChild = (kids: SQL) =>
  sql`CASE WHEN jsonb_typeof(${t.calendarEvents.data} -> 'playerIds') = 'array' THEN (${t.calendarEvents.data} -> 'playerIds') ?| ${kids} ELSE false END`;
/**
 * training_session.data.roster has an entry whose id is one of the children (JS: roster.some(p => visible(p.id))).
 * JSON containment: an entry matches only if it is an object whose "id" is that exact string (as Set.has requires).
 */
const rosterHasChild = (kidIds: readonly string[]) =>
  sql`CASE WHEN jsonb_typeof(${t.trainingSessions.data} -> 'roster') = 'array' THEN (${t.trainingSessions.data} -> 'roster') @> ANY(ARRAY[${sql.join(
    ids(kidIds).map((id) => sql`${JSON.stringify([{ id }])}`),
    sql`, `,
  )}]::jsonb[]) ELSE false END`;
/**
 * Owner decision D-5b (approved):
 *  - invoice.data.playerIds is a NON-EMPTY array: every entry is one of the children (JS: playerIds.every(visible)),
 *    and the invoice names no family contact or names this account (unchanged rule);
 *  - invoice.data.playerIds is an EMPTY array: visible only if the invoice is explicitly addressed to this account
 *    (familyUserId is the JSON string of this user id). An empty list without that address matches no family, so it
 *    can no longer match every family by vacuous truth.
 * Anything that is not an array never matches. `<@` (contained in the JSON array of the children's ids) is false for
 * any null, numeric or object entry, as the JavaScript check is. With no children only the addressed branch can match.
 */
const invoiceOfFamily = (kidIds: readonly string[], self: string) =>
  sql`CASE WHEN jsonb_typeof(${t.invoices.data} -> 'playerIds') = 'array' THEN CASE WHEN jsonb_array_length(${t.invoices.data} -> 'playerIds') = 0 THEN jsonb_typeof(${t.invoices.data} -> 'familyUserId') = 'string' AND ${t.invoices.data} ->> 'familyUserId' = ${self} ELSE ${
    kidIds.length
      ? sql`(${t.invoices.data} -> 'playerIds') <@ ${JSON.stringify(ids(kidIds))}::jsonb AND coalesce(${t.invoices.data} ->> 'familyUserId', '') IN ('', ${self})`
      : sql`false`
  } END ELSE false END`;
/**
 * Elements of a JSON array, in their stored order, kept by `keep` (an SQL condition on the element `e`).
 * Not an array: an empty array.
 */
const keptElements = (array: SQL, keep: SQL) =>
  sql`CASE WHEN jsonb_typeof(${array}) = 'array' THEN coalesce((SELECT jsonb_agg(k.e ORDER BY k.n) FROM jsonb_array_elements(${array}) WITH ORDINALITY AS k(e, n) WHERE ${keep}), '[]'::jsonb) ELSE '[]'::jsonb END`;
// Rows that involve several families (a group session, an event, a message to many families) are cut down in SQL
// to this family's part, so other children's entries and staff-only text are never read into memory. The
// JavaScript projection below then produces the response exactly as before.
/** Session data without private coaching text and with only this family's roster, attendance and adjustments. */
const familySessionData = (kids: SQL) => {
  const d = t.trainingSessions.data;
  return sql<typeof t.trainingSessions.$inferSelect.data>`(${d} - 'observations' - 'recap' - 'actuals' - 'roster' - 'attendance' - 'adjustments') || jsonb_build_object(
    'roster', ${keptElements(sql`${d} -> 'roster'`, sql`k.e ->> 'id' = ANY(${kids})`)},
    'adjustments', ${keptElements(sql`${d} -> 'adjustments'`, sql`k.e ->> 'playerId' = ANY(${kids})`)},
    'attendance', CASE WHEN jsonb_typeof(${d} -> 'attendance') = 'object' THEN coalesce((SELECT jsonb_object_agg(v.key, v.value) FROM jsonb_each(${d} -> 'attendance') AS v WHERE v.key = ANY(${kids})), '{}'::jsonb) ELSE '{}'::jsonb END)`;
};
/** Event data without staff-only fields and with only this family's participants. */
const familyEventData = (kids: SQL) => {
  const d = t.calendarEvents.data;
  return sql<typeof t.calendarEvents.$inferSelect.data>`(${d} - 'overrides' - 'cancellation') || jsonb_build_object(
    'playerIds', ${keptElements(sql`${d} -> 'playerIds'`, sql`jsonb_typeof(k.e) = 'string' AND k.e #>> '{}' = ANY(${kids})`)})`;
};
/** Message data with only this account's recipient entry and this family's players. */
const familyMessageData = (kids: SQL, self: string) => {
  const d = t.messages.data;
  return sql<typeof t.messages.$inferSelect.data>`${d} || jsonb_build_object(
    'recipients', ${keptElements(sql`${d} -> 'recipients'`, sql`k.e ->> 'userId' = ${self}`)},
    'playerIds', ${keptElements(sql`${d} -> 'playerIds'`, sql`jsonb_typeof(k.e) = 'string' AND k.e #>> '{}' = ANY(${kids})`)})`;
};
const paymentColumns = columnsWithout(getTableColumns(t.payments), "referenceKey", "rejectionKind");
const mediaColumns = columnsWithout(getTableColumns(t.mediaAssets), "storageKey");
export async function bootstrapFamily(a: Actor): Promise<AcademyData> {
  const db = database();
  const academy = a.academyId;
  const inAcademy = (column: AnyPgColumn) => eq(column, academy);
  const scope = await familyScope(a, db);
  const visiblePlayers = scope.players;
  const playerIds = scope.playerIds;
  const links = scope.links;
  const any = playerIds.size > 0;
  const kidList = any ? ids(playerIds) : [];
  // RC-4: the children per section. `sql` is null and `list` empty when the section is held for nobody.
  const section = (name: GuardianAccessScope) => {
    const set = scope.ids(name);
    return { set, list: set.size ? ids(set) : [], sql: set.size ? textArray(set) : null };
  };
  const schedule = section("SCHEDULE");
  const reportKids = section("REPORTS");
  const nutritionKids = section("NUTRITION");
  const health = section("HEALTH");
  const fees = section("FEES");
  const mediaKids = section("MEDIA");
  const messageKids = section("MESSAGES");
  const none = Promise.resolve([] as never[]);
  // Wave 1. Child-keyed sections run only when there is at least one child; account-keyed ones always.
  const [
    settingRows,
    entitlementRows,
    profiles,
    branches,
    batches,
    members,
    events,
    sessions,
    invoices,
    credits,
    reports,
    nutrition,
    restrictions,
    questions,
    deliveries,
    conversations,
    media,
  ] = await Promise.all([
    db.select().from(t.academySettings).where(inAcademy(t.academySettings.academyId)),
    db.select().from(t.entitlements).where(inAcademy(t.entitlements.academyId)),
    any
      ? db
          .select()
          .from(t.profiles)
          .where(and(inAcademy(t.profiles.academyId), inArray(t.profiles.playerId, kidList)))
      : none,
    // Academy reference data, sent to families as before (decision D-1: response unchanged).
    db.select().from(t.branches).where(inAcademy(t.branches.academyId)),
    db
      .select()
      .from(t.batches)
      .where(
        and(
          inAcademy(t.batches.academyId),
          any
            ? or(inArray(t.batches.id, ids(visiblePlayers.map((p) => p.batchId))), eq(t.batches.coachId, a.id))
            : eq(t.batches.coachId, a.id),
        ),
      ),
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
      .where(and(inAcademy(t.memberships.academyId), eq(t.memberships.userId, a.id))),
    schedule.sql
      ? db
          .select({
            id: t.calendarEvents.id,
            academyId: t.calendarEvents.academyId,
            version: t.calendarEvents.version,
            kind: t.calendarEvents.kind,
            status: t.calendarEvents.status,
            data: familyEventData(schedule.sql),
          })
          .from(t.calendarEvents)
          .where(and(inAcademy(t.calendarEvents.academyId), eventHasChild(schedule.sql)))
      : none,
    schedule.sql
      ? db
          .select({
            id: t.trainingSessions.id,
            version: t.trainingSessions.version,
            status: t.trainingSessions.status,
            coachId: t.trainingSessions.coachId,
            batchId: t.trainingSessions.batchId,
            data: familySessionData(schedule.sql),
          })
          .from(t.trainingSessions)
          .where(
            and(
              inAcademy(t.trainingSessions.academyId),
              notInArray(t.trainingSessions.status, ["DRAFT", "CANCELLED"]),
              rosterHasChild(schedule.list),
            ),
          )
      : none,
    // Account-keyed as well as child-keyed (D-5b: an invoice naming no child, addressed to this account), so it
    // runs even with no children; then only the addressed branch of the predicate can match.
    db
      .select()
      .from(t.invoices)
      .where(and(inAcademy(t.invoices.academyId), invoiceOfFamily(fees.list, a.id))),
    fees.set.size
      ? db
          .select()
          .from(t.lessonCredits)
          .where(and(inAcademy(t.lessonCredits.academyId), inArray(t.lessonCredits.playerId, fees.list)))
      : none,
    reportKids.set.size
      ? db
          .select()
          .from(t.reports)
          .where(and(inAcademy(t.reports.academyId), inArray(t.reports.playerId, reportKids.list)))
      : none,
    nutritionKids.set.size
      ? db
          .select()
          .from(t.nutritionPlans)
          .where(and(inAcademy(t.nutritionPlans.academyId), inArray(t.nutritionPlans.playerId, nutritionKids.list)))
      : none,
    health.set.size
      ? db
          .select()
          .from(t.restrictedNutrition)
          .where(
            and(inAcademy(t.restrictedNutrition.academyId), inArray(t.restrictedNutrition.playerId, health.list)),
          )
      : none,
    health.set.size
      ? db
          .select()
          .from(t.nutritionQuestions)
          .where(
            and(
              inAcademy(t.nutritionQuestions.academyId),
              inArray(t.nutritionQuestions.playerId, health.list),
              eq(t.nutritionQuestions.authorId, a.id),
            ),
          )
      : none,
    db
      .select()
      .from(t.deliveries)
      .where(and(inAcademy(t.deliveries.academyId), eq(t.deliveries.userId, a.id))),
    messageKids.set.size
      ? db
          .select()
          .from(t.conversations)
          .where(
            and(
              inAcademy(t.conversations.academyId),
              eq(t.conversations.guardianId, a.id),
              inArray(t.conversations.playerId, messageKids.list),
            ),
          )
      : none,
    mediaKids.set.size
      ? db
          .select(mediaColumns)
          .from(t.mediaAssets)
          .where(
            and(
              inAcademy(t.mediaAssets.academyId),
              inArray(t.mediaAssets.playerId, mediaKids.list),
              eq(t.mediaAssets.status, "SHARED"),
            ),
          )
      : none,
  ]);
  const settings = settingRows[0] ?? {
    academyId: academy,
    version: 1,
    data: defaultSettings,
  };
  const entitlements = entitlementRows[0]?.data ?? {};
  const enabled = (key: keyof typeof defaultSettings.features) =>
    !!entitlements[key] && settings.data.features[key];
  // Second layer: the shared loader's family rules, unchanged, on the narrowed rows (plus D-5b, as in SQL).
  const visibleInvoices = invoices.filter((i) => {
    if (!Array.isArray(i.data.playerIds)) return false;
    // D-5b: an invoice naming no child is visible only to the account it is explicitly addressed to.
    if (i.data.playerIds.length === 0)
      return typeof i.data.familyUserId === "string" && i.data.familyUserId === a.id;
    return (
      i.data.playerIds.every((id) => fees.set.has(id)) &&
      (!i.data.familyUserId || i.data.familyUserId === a.id)
    );
  });
  const invoiceIds = new Set(visibleInvoices.map((i) => i.id));
  // RC-4: a delivery is the trace of a message about some children. One that concerns only adult players who have
  // not granted this guardian MESSAGES is withheld (the row stays in the database). Read only for a guardian who
  // is linked to an adult-controlled record; everyone else's deliveries are untouched.
  const ownDeliveries = deliveries.filter((d) => d.userId === a.id);
  const withheldMessages = new Set<string>();
  if (scope.delegated.size && ownDeliveries.length) {
    const addressed = await db
      .select({
        id: t.messages.id,
        recipients: sql<unknown>`${keptElements(sql`${t.messages.data} -> 'recipients'`, sql`k.e ->> 'userId' = ${a.id}`)}`,
      })
      .from(t.messages)
      .where(and(inAcademy(t.messages.academyId), inArray(t.messages.id, ids(ownDeliveries.map((d) => d.messageId)))));
    const known = new Set(addressed.map((m) => m.id));
    for (const m of addressed) {
      const about = (Array.isArray(m.recipients) ? m.recipients : []).flatMap((r) =>
        r && typeof r === "object" && Array.isArray((r as { playerIds?: unknown }).playerIds)
          ? ((r as { playerIds: unknown[] }).playerIds.filter((id) => typeof id === "string") as string[])
          : [],
      );
      // Fail-closed: a message whose players cannot be read, or that names a withheld adult and no child whose
      // messages this account may read, is withheld.
      if (!about.length || (about.some((id) => scope.delegated.has(id)) && !about.some((id) => messageKids.set.has(id))))
        withheldMessages.add(m.id);
    }
    for (const d of ownDeliveries) if (!known.has(d.messageId)) withheldMessages.add(d.messageId);
  }
  const visibleDeliveries = ownDeliveries.filter((d) => !withheldMessages.has(d.messageId));
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
  // Only unpublished / unshared records need their revision history (to find the last shared version).
  const needHistory = [
    ...reports.filter((r) => r.status !== "PUBLISHED").map((r) => r.id),
    ...nutrition.filter((n) => n.status !== "SHARED").map((n) => n.id),
  ];
  // Wave 2: rows identified by ids taken from wave 1.
  const [payments, refunds, messages, versions] = await Promise.all([
    invoiceIds.size
      ? db
          .select(paymentColumns)
          .from(t.payments)
          .where(and(inAcademy(t.payments.academyId), inArray(t.payments.invoiceId, ids(invoiceIds))))
      : none,
    invoiceIds.size
      ? db
          .select()
          .from(t.refunds)
          .where(
            and(
              inAcademy(t.refunds.academyId),
              inArray(
                t.refunds.paymentId,
                db
                  .select({ id: t.payments.id })
                  .from(t.payments)
                  .where(and(inAcademy(t.payments.academyId), inArray(t.payments.invoiceId, ids(invoiceIds)))),
              ),
            ),
          )
      : none,
    // A message can only reach a family through a portal delivery to this account (and a visible child).
    messageKids.sql && portalIds.size
      ? db
          .select({
            id: t.messages.id,
            authorId: t.messages.authorId,
            academyId: t.messages.academyId,
            version: t.messages.version,
            status: t.messages.status,
            data: familyMessageData(messageKids.sql, a.id),
          })
          .from(t.messages)
          .where(and(inAcademy(t.messages.academyId), inArray(t.messages.id, ids(portalIds))))
      : none,
    needHistory.length
      ? db
          .select()
          .from(t.recordRevisions)
          .where(
            and(inAcademy(t.recordRevisions.academyId), inArray(t.recordRevisions.entityId, ids(needHistory))),
          )
          .orderBy(desc(t.recordRevisions.version))
      : none,
  ]);
  // Revisions grouped once per record, in the same (newest first) order as before.
  const revisionsOf = new Map<string, (typeof versions)[number][]>();
  for (const v of versions) {
    const list = revisionsOf.get(v.entityId);
    if (list) list.push(v);
    else revisionsOf.set(v.entityId, [v]);
  }
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
      revisionsOf.get(row.id) ?? [],
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
  const visiblePayments = payments.filter((p) => invoiceIds.has(p.invoiceId));
  const paymentIds = new Set(visiblePayments.map((p) => p.id));
  const visibleRefunds = refunds.filter((r) => paymentIds.has(r.paymentId));
  const visibleReports = enabled("reports")
    ? reports
        .filter((r) => reportKids.set.has(r.playerId))
        .flatMap((r) => {
          const shared = lastShared(r, "report", "PUBLISHED");
          // The counts-only "facts" sentence is a drafting aid for the coach; a family gets the published report, not the aid.
          if (!shared) return [];
          const { facts: _aid, ...published } = shared.data;
          return [{ ...shared, data: published }];
        })
    : [];
  const visibleNutrition = enabled("nutrition")
    ? nutrition
        .filter((n) => nutritionKids.set.has(n.playerId))
        .flatMap((n) => {
          const shared = lastShared(n, "nutrition-plan", "SHARED");
          return shared ? [shared] : [];
        })
    : [];
  const profileOf = new Map(profiles.map((pr) => [pr.playerId, pr]));
  const playerRecords = visiblePlayers.map((p) => {
    const profile = profileOf.get(p.id);
    // RC-4: of an adult player a guardian sees name and batch only; contact details, birth date, preferences and
    // the adult's account id are the adult's own. Status is kept so the portal can tell an archived record.
    if (scope.delegated.has(p.id))
      return {
        ...p,
        version: profile?.version ?? 1,
        profile: { ...defaultProfile, adult: true, status: profile?.data.status ?? defaultProfile.status },
      };
    return {
      ...p,
      version: profile?.version ?? 1,
      profile: { ...defaultProfile, ...profile?.data, notes: "" },
    };
  });
  const visibleSessions = sessions.filter(
    (s) =>
      s.status !== "DRAFT" &&
      s.status !== "CANCELLED" &&
      s.data.roster.some((p) => schedule.set.has(p.id)),
  );
  const safeSessions = visibleSessions.map((s) => ({
    id: s.id,
    version: s.version,
    status: s.status,
    coachId: s.coachId,
    batchId: s.batchId,
    data: {
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
      adjustments: s.data.adjustments.filter((ad) => schedule.set.has(ad.playerId)),
      attendance: Object.fromEntries(
        Object.entries(s.data.attendance).filter(([id]) => schedule.set.has(id)),
      ),
      observations: [],
      roster: [],
      recap: "",
      actuals: {},
      coachId: s.coachId,
      batchId: s.batchId,
      startsAt: s.data.startsAt,
      progress: { index: 0, elapsed: 0, runningSince: null },
    },
  }));
  const visibleMessages = enabled("communications")
    ? messages
        .filter(
          (m) =>
            portalIds.has(m.id) &&
            m.data.recipients.some(
              (r) =>
                r.userId === a.id &&
                r.playerIds.some((id) => messageKids.set.has(id)) &&
                links.some(
                  (l) =>
                    l.userId === a.id &&
                    l.active &&
                    messageKids.set.has(l.playerId) &&
                    r.playerIds.includes(l.playerId),
                ),
            ),
        )
        .map((m) => ({
          ...m,
          data: {
            ...m.data,
            recipients: [],
            playerIds: m.data.playerIds.filter((id) => messageKids.set.has(id)),
            batchIds: [],
            approvedBy: null,
            approvalHash: null,
          },
        }))
    : [];
  const messageActivity = visibleMessages.length
    ? await db
        .select({ entityId: t.audit.entityId, at: t.audit.createdAt })
        .from(t.audit)
        .where(
          and(
            inAcademy(t.audit.academyId),
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
  const payload: AcademyData = {
    goals: [],
    actor: a,
    development: process.env.NODE_ENV !== "production",
    permissions: {
      ops: false,
      finance: false,
      coaching: false,
      professional: false,
      family: true,
      owner: false,
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
    batches: batches.filter(
      (b) =>
        b.coachId === a.id ||
        visiblePlayers.some((p) => p.batchId === b.id),
    ),
    members: members.filter((m) => m.id === a.id),
    // RC-4: not the link to an adult player read through a grant; its consent flags are not this account's to manage.
    guardianLinks: links.filter(
      (l) => scope.holds(l.playerId) && l.userId === a.id,
    ),
    enquiries: [],
    events: events
      .filter((e) => e.data.playerIds.some((id) => schedule.set.has(id)))
      .map((e) => {
        // Families keep the event shape they had before Stage 5E: the series bookkeeping (not selected), the list
        // of individually changed fields and the staff's cancellation note are staff information.
        const { overrides: _overrides, cancellation: _cancellation, ...data } = e.data;
        return {
          ...e,
          data: {
            ...data,
            playerIds: e.data.playerIds.filter((id) => schedule.set.has(id)),
            enquiryId: null,
          },
        };
      }),
    calendarSeries: [],
    sessions: safeSessions,
    feePlans: [],
    invoices: invoiceSummaries,
    payments: visiblePayments,
    refunds: visibleRefunds,
    credits: credits.filter((c) => fees.set.has(c.playerId)),
    reports: visibleReports,
    reviews: [],
    nutrition: visibleNutrition,
    restrictions: enabled("nutrition")
      ? restrictions.filter((r) => health.set.has(r.playerId))
      : [],
    questions: enabled("nutrition")
      ? questions.filter(
          (q) => health.set.has(q.playerId) && q.authorId === a.id,
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
    templates: [],
    conversations: enabled("communications")
      ? conversations.filter(
          (c) =>
            c.guardianId === a.id &&
            messageKids.set.has(c.playerId) &&
            links.some(
              (l) =>
                l.userId === c.guardianId &&
                l.active &&
                messageKids.set.has(l.playerId),
            ),
        )
      : [],
    media: enabled("manualVideo")
      ? media.filter(
          (m) =>
            mediaKids.set.has(m.playerId) &&
            m.status === "SHARED" &&
            m.expiresAt.getTime() > Date.now(),
        )
      : [],
    history: [],
    versions: [],
    audits: [],
    assignments: [],
    summary: {
      activePlayers: playerRecords.filter((p) => p.profile.status === "ACTIVE")
        .length,
      upcoming: safeSessions.filter(
        (s) => s.status === "PUBLISHED" && s.data.localDate >= currentDate,
      ).length,
      followUps: 0,
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
    operation: "LIST",
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
        history: 0,
        versions: 0,
        withdrawn: 0,
        sessions: payload.sessions.length,
        events: payload.events.length,
        members: payload.members.length,
      },
    },
  });
  return payload;
}
