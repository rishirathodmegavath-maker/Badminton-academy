import { and, desc, eq, isNull, or, inArray } from "drizzle-orm";
import { z } from "zod";
import { shownName } from "../../identity/membership";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import { type Actor, isManager } from "../../identity/access";
import { rolesWith } from "../../identity/authority";
import {
  DomainError,
  draftInput,
  elapsedSeconds,
  publishBlockers,
  requireTransition,
  validatePublish,
} from "../domain/rules";
import type {
  Bootstrap,
  Drill,
  SessionData,
  TrainingSession,
} from "../domain/types";
import { ensureSlot } from "../../calendar/application/scheduling";
import { recordAccess } from "../../audit/application/record";
import { requireActiveCoach } from "../../settings/application/coach-assignments";
import { lockActor } from "../../identity/lock-actor";
import {
  BADMINTON_CATALOGUE,
  findCatalogueDrill,
} from "../domain/catalogue";

const scope = (actor: Actor) =>
  and(
    eq(t.trainingSessions.academyId, actor.academyId),
    isManager(actor) ? undefined : eq(t.trainingSessions.coachId, actor.id),
  );
const batchScope = (actor: Actor) =>
  and(
    eq(t.batches.academyId, actor.academyId),
    isManager(actor) ? undefined : eq(t.batches.coachId, actor.id),
  );
const serialize = (
  row: typeof t.trainingSessions.$inferSelect,
): TrainingSession => ({
  ...row,
  status: row.status as TrainingSession["status"],
  updatedAt: row.updatedAt.toISOString(),
});

export async function bootstrap(actor: Actor): Promise<Bootstrap> {
  const db = database();
  const [
    branches,
    batches,
    coaches,
    drills,
    sessions,
    favourites,
    players,
    goals,
  ] = await Promise.all([
    db
      .select({ id: t.branches.id, name: t.branches.name })
      .from(t.branches)
      .where(eq(t.branches.academyId, actor.academyId)),
    db.select().from(t.batches).where(batchScope(actor)),
    db
      .select({ id: t.user.id, name: shownName })
      .from(t.memberships)
      .innerJoin(t.user, eq(t.user.id, t.memberships.userId))
      .where(
        and(
          eq(t.memberships.academyId, actor.academyId),
          eq(t.memberships.active, true),
          inArray(t.memberships.role, rolesWith("sessions.coach")),
          isManager(actor) ? undefined : eq(t.user.id, actor.id),
        ),
      ),
    db
      .select()
      .from(t.drills)
      .where(
        or(isNull(t.drills.academyId), eq(t.drills.academyId, actor.academyId)),
      )
      .orderBy(desc(t.drills.version)),
    db
      .select()
      .from(t.trainingSessions)
      .where(scope(actor))
      .orderBy(desc(t.trainingSessions.updatedAt)),
    db
      .select()
      .from(t.favourites)
      .where(
        and(
          eq(t.favourites.academyId, actor.academyId),
          eq(t.favourites.userId, actor.id),
        ),
      ),
    db
      .select({
        id: t.players.id,
        name: t.players.name,
        batchId: t.players.batchId,
      })
      .from(t.players)
      .innerJoin(
        t.batches,
        and(
          eq(t.players.academyId, t.batches.academyId),
          eq(t.players.batchId, t.batches.id),
        ),
      )
      .where(batchScope(actor)),
    db
      .select({ data: t.goals.data })
      .from(t.goals)
      .innerJoin(
        t.players,
        and(
          eq(t.goals.academyId, t.players.academyId),
          eq(t.goals.playerId, t.players.id),
        ),
      )
      .innerJoin(
        t.batches,
        and(
          eq(t.players.academyId, t.batches.academyId),
          eq(t.players.batchId, t.batches.id),
        ),
      )
      .where(batchScope(actor)),
  ]);
  // The built-in library comes first, then the academy's own drills.
  const seen = new Set<string>(BADMINTON_CATALOGUE.map((d) => d.id));
  const payload = {
    academy: {
      id: actor.academyId,
      name: actor.academyName,
      timezone: actor.timezone,
    },
    actor: { id: actor.id, name: actor.name, role: actor.role },
    branches,
    batches,
    coaches,
    drills: [
      ...BADMINTON_CATALOGUE,
      ...drills
        .filter((d) => {
          if (seen.has(d.id)) return false;
          seen.add(d.id);
          return true;
        })
        .map((d) => d.data),
    ],
    sessions: sessions.map(serialize),
    favourites: favourites.map((f) => f.drillId),
    players,
    goals: goals.map((g) => g.data),
    development: process.env.NODE_ENV !== "production",
  };
  // Phase 7: sessions carry rosters and observations about players; one event per load (fail-closed).
  await recordAccess(db, actor, {
    category: "TRAINING",
    operation: actor.role === "COACH" ? "LIST" : "BULK",
    context: {
      counts: {
        sessions: payload.sessions.length,
        players: payload.players.length,
        goals: payload.goals.length,
      },
    },
  });
  return payload;
}

export async function createSession(actor: Actor) {
  const data: SessionData = {
    title: "",
    batchId: "",
    branchId: "",
    coachId: actor.id,
    localDate: "",
    localTime: "",
    startsAt: null,
    timezone: actor.timezone,
    duration: 60,
    objective: "",
    activities: [],
    roster: [],
    attendance: {},
    observations: [],
    adjustments: [],
    progress: { index: 0, elapsed: 0, runningSince: null },
    actuals: {},
    recap: "",
  };
  const db = database();
  return db.transaction(async (tx) => {
    await tx
      .select()
      .from(t.academies)
      .where(eq(t.academies.id, actor.academyId))
      .for("update");
    await lockActor(tx, actor);
    const id = crypto.randomUUID();
    const [row] = await tx
      .insert(t.trainingSessions)
      .values({ id, academyId: actor.academyId, coachId: actor.id, data })
      .returning();
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: actor.academyId,
      actorId: actor.id,
      entityId: id,
      action: "create",
      version: 1,
      detail: {},
    });
    await tx.insert(t.revisions).values({
      academyId: actor.academyId,
      sessionId: id,
      version: 1,
      status: "DRAFT",
      data,
    });
    return serialize(row);
  });
}

const envelope = z.object({
  version: z.number().int().min(1),
  action: z.enum([
    "save",
    "publish",
    "start",
    "progress",
    "attendance",
    "note",
    "complete",
    "cancel",
    "duplicate",
  ]),
  payload: z.unknown().optional(),
});
export async function mutateSession(actor: Actor, id: string, input: unknown) {
  const command = envelope.parse(input);
  const db = database();
  return db.transaction(async (tx) => {
    await tx
      .select()
      .from(t.academies)
      .where(eq(t.academies.id, actor.academyId))
      .for("update");
    await lockActor(tx, actor);
    const [row] = await tx
      .select()
      .from(t.trainingSessions)
      .where(and(scope(actor), eq(t.trainingSessions.id, id)));
    if (!row) throw new DomainError("Session not found.", 404);
    if (row.version !== command.version)
      throw new DomainError(
        "This session changed in another tab. Reload the saved version before continuing. Your unsaved edits remain on screen.",
        409,
      );
    const status = row.status as TrainingSession["status"];
    requireTransition(status, command.action);
    let nextStatus = status;
    const data = structuredClone(row.data);
    let coachId = row.coachId;
    const payload = command.payload;
    if (command.action === "save") {
      const draft = draftInput.parse(payload);
      if (
        new Set(draft.activities.map((a) => a.id)).size !==
        draft.activities.length
      )
        throw new DomainError("Activity identifiers must be unique.");
      const [coach] = await tx
        .select()
        .from(t.memberships)
        .where(
          and(
            eq(t.memberships.academyId, actor.academyId),
            eq(t.memberships.userId, draft.coachId),
            eq(t.memberships.active, true),
            inArray(t.memberships.role, rolesWith("sessions.coach")),
          ),
        );
      if (!coach || (!isManager(actor) && draft.coachId !== actor.id))
        throw new DomainError("Choose an authorised coach.", 403);
      coachId = draft.coachId;
      if (draft.branchId) {
        const [branch] = await tx
          .select()
          .from(t.branches)
          .where(
            and(
              eq(t.branches.academyId, actor.academyId),
              eq(t.branches.id, draft.branchId),
            ),
          );
        if (!branch) throw new DomainError("Branch not found.", 404);
      }
      if (draft.batchId) {
        const [batch] = await tx
          .select()
          .from(t.batches)
          .where(and(batchScope(actor), eq(t.batches.id, draft.batchId)));
        if (!batch) throw new DomainError("Batch not found.", 404);
        if (batch.branchId !== draft.branchId || batch.coachId !== coachId)
          throw new DomainError(
            "Branch and coach must match the batch assignment.",
          );
      }
      const selectedPlayers = draft.batchId
        ? await tx
            .select()
            .from(t.players)
            .where(
              and(
                eq(t.players.academyId, actor.academyId),
                eq(t.players.batchId, draft.batchId),
              ),
            )
        : [];
      for (const a of draft.adjustments) {
        if (!selectedPlayers.some((p) => p.id === a.playerId))
          throw new DomainError("Focus player must belong to this batch.");
        if (a.goalId) {
          const [goal] = await tx
            .select()
            .from(t.goals)
            .where(
              and(
                eq(t.goals.academyId, actor.academyId),
                eq(t.goals.id, a.goalId),
                eq(t.goals.playerId, a.playerId),
              ),
            );
          if (!goal) throw new DomainError("Goal not found.", 404);
        }
      }
      const activities = [];
      for (const a of draft.activities) {
        if (a.drillId) {
          const previous = data.activities.find(
            (old) =>
              old.id === a.id &&
              old.drillId === a.drillId &&
              old.drillVersion === a.drillVersion,
          );
          const [stored] = await tx
            .select()
            .from(t.drills)
            .where(
              and(
                eq(t.drills.id, a.drillId),
                eq(t.drills.version, a.drillVersion ?? 0),
                or(
                  isNull(t.drills.academyId),
                  eq(t.drills.academyId, actor.academyId),
                ),
              ),
            );
          const drill =
            findCatalogueDrill(a.drillId, a.drillVersion ?? 0) ?? stored?.data;
          if (!drill)
            throw new DomainError("An assigned drill is unavailable.", 404);
          activities.push({
            ...a,
            title: drill.title,
            snapshot: previous?.snapshot ?? drill,
          });
        } else activities.push({ ...a, drillVersion: null, snapshot: null });
      }
      Object.assign(data, draft, {
        activities,
        startsAt: null,
        timezone: actor.timezone,
      });
    }
    if (command.action === "publish") {
      // Say what is missing before anything else, so an unfinished draft is told exactly what to complete (the batch check
      // below would otherwise answer an empty batch with a vague "recheck" message). The minutes rule keeps its own message.
      const missing = publishBlockers(data).filter((m) => !m.startsWith("make the activities add up"));
      if (missing.length)
        throw new DomainError(`This session is still a draft. To publish it, ${missing.join(", ")}.`);
      const [batch] = await tx
        .select()
        .from(t.batches)
        .where(and(batchScope(actor), eq(t.batches.id, data.batchId)));
      if (
        !batch ||
        batch.coachId !== data.coachId ||
        batch.branchId !== data.branchId
      )
        throw new DomainError(
          "The branch or coach chosen does not match this batch's. Choose the batch again to reset them, then publish.",
        );
      data.roster = await tx
        .select({ id: t.players.id, name: t.players.name })
        .from(t.players)
        .where(
          and(
            eq(t.players.academyId, actor.academyId),
            eq(t.players.batchId, data.batchId),
          ),
        );
      if (
        data.adjustments.some(
          (a) => !data.roster.some((p) => p.id === a.playerId),
        )
      )
        throw new DomainError(
          "A focus player has left this batch. Update the draft before publishing.",
        );
      const inactive = await tx
        .select()
        .from(t.profiles)
        .where(eq(t.profiles.academyId, actor.academyId));
      data.roster = data.roster.filter(
        (p) =>
          !inactive.some(
            (profile) =>
              profile.playerId === p.id && profile.data.status !== "ACTIVE",
          ),
      );
      data.startsAt = validatePublish(data);
      await ensureSlot(tx, actor, {
        id,
        startsAt: data.startsAt,
        duration: data.duration,
        branchId: data.branchId,
        coachId: data.coachId,
        playerIds: data.roster.map((p) => p.id),
      });
      nextStatus = "PUBLISHED";
    }
    if (command.action === "start") {
      nextStatus = "IN_PROGRESS";
      data.progress = {
        index: 0,
        elapsed: 0,
        runningSince: new Date().toISOString(),
      };
    }
    if (command.action === "progress") {
      const { operation } = z
        .object({ operation: z.enum(["pause", "resume", "next"]) })
        .parse(payload);
      const elapsed = elapsedSeconds(data.progress);
      if (operation === "pause")
        data.progress = { ...data.progress, elapsed, runningSince: null };
      if (operation === "resume" && !data.progress.runningSince)
        data.progress.runningSince = new Date().toISOString();
      if (operation === "next") {
        if (data.progress.index >= data.activities.length - 1)
          throw new DomainError(
            "This is the final activity. Review actual activities and complete the session.",
          );
        data.progress = {
          index: data.progress.index + 1,
          elapsed: 0,
          runningSince: data.progress.runningSince
            ? new Date().toISOString()
            : null,
        };
      }
    }
    if (command.action === "attendance") {
      const updates = z
        .record(
          z.string(),
          z.enum(["PRESENT", "ABSENT", "EXCUSED", "NOT_MARKED"]),
        )
        .parse(payload);
      for (const [playerId, value] of Object.entries(updates)) {
        if (!data.roster.some((p) => p.id === playerId))
          throw new DomainError("Player not in the published roster.");
        data.attendance[playerId] = value;
      }
      if (
        JSON.stringify(data.attendance) === JSON.stringify(row.data.attendance)
      )
        return serialize(row);
    }
    if (command.action === "note") {
      const note = z
        .object({
          id: z.uuid(),
          playerId: z.string(),
          activityId: z.string().nullable(),
          text: z.string().trim().min(1).max(2000),
        })
        .parse(payload);
      if (
        !data.roster.some((p) => p.id === note.playerId) ||
        (note.activityId &&
          !data.activities.some((a) => a.id === note.activityId))
      )
        throw new DomainError("Observation context is outside this session.");
      const existing = data.observations.find((n) => n.id === note.id);
      if (existing) {
        if (
          existing.text !== note.text ||
          existing.playerId !== note.playerId ||
          existing.activityId !== note.activityId
        )
          throw new DomainError("Observation ID was already used.", 409);
        return serialize(row);
      }
      data.observations.push({
        ...note,
        author: actor.name,
        at: new Date().toISOString(),
        visibility: "PRIVATE_DRAFT",
      });
    }
    if (command.action === "complete") {
      const completion = z
        .object({
          actuals: z.record(
            z.string(),
            z.enum(["COMPLETED", "MODIFIED", "NOT_COMPLETED"]),
          ),
          recap: z.string().max(2000),
          acknowledgeAttendance: z.boolean(),
        })
        .parse(payload);
      if (
        data.activities.some((a) => !completion.actuals[a.id]) ||
        Object.keys(completion.actuals).some(
          (id) => !data.activities.some((a) => a.id === id),
        )
      )
        throw new DomainError(
          "Record what happened for every planned activity.",
        );
      if (!completion.acknowledgeAttendance)
        throw new DomainError(
          "Review attendance exceptions before completing.",
        );
      data.actuals = completion.actuals;
      data.recap = completion.recap;
      data.progress = {
        ...data.progress,
        elapsed: elapsedSeconds(data.progress),
        runningSince: null,
      };
      nextStatus = "COMPLETED";
    }
    if (command.action === "cancel") {
      const { reason } = z
        .object({ reason: z.string().trim().min(3).max(500) })
        .parse(payload);
      data.recap = `Cancellation: ${reason}`;
      nextStatus = "CANCELLED";
    }
    if (command.action === "duplicate") {
      const { localDate, localTime } = z
        .object({
          localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          localTime: z.string().regex(/^\d{2}:\d{2}$/),
        })
        .parse(payload);
      // A copy is new, upcoming work for the same coach: refuse it if they can no longer coach.
      await requireActiveCoach(tx, actor.academyId, row.coachId);
      const copy: SessionData = {
        ...data,
        title: `${data.title} (copy)`,
        localDate,
        localTime,
        startsAt: null,
        roster: [],
        attendance: {},
        observations: [],
        actuals: {},
        recap: "",
        progress: { index: 0, elapsed: 0, runningSince: null },
        activities: data.activities.map((a) => ({
          ...a,
          id: crypto.randomUUID(),
        })),
      };
      const copyId = crypto.randomUUID();
      const [created] = await tx
        .insert(t.trainingSessions)
        .values({
          id: copyId,
          academyId: actor.academyId,
          coachId: row.coachId,
          batchId: row.batchId,
          data: copy,
        })
        .returning();
      await tx.insert(t.audit).values({
        id: crypto.randomUUID(),
        academyId: actor.academyId,
        actorId: actor.id,
        entityId: copyId,
        action: "duplicate",
        version: 1,
        detail: { sourceId: id, goalsReused: true, evidenceCopied: false },
      });
      await tx.insert(t.revisions).values({
        academyId: actor.academyId,
        sessionId: copyId,
        version: 1,
        status: "DRAFT",
        data: copy,
      });
      return serialize(created);
    }
    const version = row.version + 1;
    const [updated] = await tx
      .update(t.trainingSessions)
      .set({
        data,
        status: nextStatus,
        version,
        coachId,
        batchId: data.batchId || null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(t.trainingSessions.id, id),
          eq(t.trainingSessions.academyId, actor.academyId),
          eq(t.trainingSessions.version, command.version),
        ),
      )
      .returning();
    if (!updated)
      throw new DomainError(
        "Another tab saved first. Reload before continuing.",
        409,
      );
    await tx.insert(t.revisions).values({
      academyId: actor.academyId,
      sessionId: id,
      version,
      status: nextStatus,
      data,
    });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: actor.academyId,
      actorId: actor.id,
      entityId: id,
      action: command.action,
      version,
      detail:
        command.action === "attendance"
          ? { changes: payload }
          : { status: nextStatus },
    });
    return serialize(updated);
  });
}

export async function setFavourite(actor: Actor, input: unknown) {
  const { drillId, selected } = z
    .object({ drillId: z.string(), selected: z.boolean() })
    .parse(input);
  const db = database();
  const [drill] = await db
    .select()
    .from(t.drills)
    .where(
      and(
        eq(t.drills.id, drillId),
        or(isNull(t.drills.academyId), eq(t.drills.academyId, actor.academyId)),
      ),
    );
  if (!drill && !findCatalogueDrill(drillId))
    throw new DomainError("Drill not found.", 404);
  if (selected)
    await db
      .insert(t.favourites)
      .values({ academyId: actor.academyId, userId: actor.id, drillId })
      .onConflictDoNothing();
  else
    await db
      .delete(t.favourites)
      .where(
        and(
          eq(t.favourites.academyId, actor.academyId),
          eq(t.favourites.userId, actor.id),
          eq(t.favourites.drillId, drillId),
        ),
      );
  return { ok: true };
}
export async function createDrill(actor: Actor, input: unknown) {
  const values = z
    .object({
      title: z.string().trim().min(2).max(120),
      objective: z.string().trim().min(3).max(1000),
      setup: z.string().trim().min(3).max(1000),
      steps: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
      cues: z.array(z.string().max(500)).max(20),
      minutes: z.number().int().min(1).max(180),
      skill: z.enum([
        "Overhead",
        "Net play",
        "Defence",
        "Movement",
        "Serve & return",
        "Doubles",
        "Fitness",
      ]),
      level: z.enum(["Beginner", "Intermediate", "Advanced"]),
      format: z.enum(["Singles", "Doubles", "Both"]),
      players: z.number().int().min(1).max(50),
      equipment: z.array(z.string().max(100)).max(20),
      mistakes: z.array(z.string().max(500)).max(20),
      easier: z.string().max(1000),
      harder: z.string().max(1000),
    })
    .parse(input);
  const drill: Drill = {
    ...values,
    id: crypto.randomUUID(),
    version: 1,
    academyId: actor.academyId,
    review: "Draft · coaching review pending",
  };
  await database().transaction(async (tx) => {
    await lockActor(tx, actor);
    await tx.insert(t.drills).values({
      id: drill.id,
      version: 1,
      academyId: actor.academyId,
      data: drill,
    });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: actor.academyId,
      actorId: actor.id,
      entityId: drill.id,
      action: "create-private-drill",
      version: 1,
      detail: {},
    });
  });
  return drill;
}
export async function saveGoal(actor: Actor, input: unknown) {
  const values = z
    .object({
      id: z.uuid().optional(),
      playerId: z.string(),
      title: z.string().trim().min(2).max(200),
      method: z.string().trim().min(3).max(500),
      status: z.enum(["ACTIVE", "REVIEWED"]),
    })
    .parse(input);
  const db = database();
  const goal = {
    ...values,
    id: values.id ?? crypto.randomUUID(),
    author: actor.name,
    createdAt: new Date().toISOString(),
  };
  await db.transaction(async (tx) => {
    await lockActor(tx, actor);
    // The player scope (a coach's own batches) is decided inside the transaction, after the
    // actor's role is confirmed, so it is current for the write below.
    const [player] = await tx
      .select()
      .from(t.players)
      .innerJoin(
        t.batches,
        and(
          eq(t.players.academyId, t.batches.academyId),
          eq(t.players.batchId, t.batches.id),
        ),
      )
      .where(and(batchScope(actor), eq(t.players.id, values.playerId)));
    if (!player) throw new DomainError("Player not found.", 404);
    if (values.id) {
      const [old] = await tx
        .select()
        .from(t.goals)
        .where(
          and(
            eq(t.goals.academyId, actor.academyId),
            eq(t.goals.id, values.id),
            eq(t.goals.playerId, values.playerId),
          ),
        );
      if (!old) throw new DomainError("Goal not found.", 404);
      goal.createdAt = old.data.createdAt;
      await tx
        .update(t.goals)
        .set({ data: goal })
        .where(
          and(
            eq(t.goals.academyId, actor.academyId),
            eq(t.goals.id, values.id),
          ),
        );
    } else
      await tx.insert(t.goals).values({
        id: goal.id,
        academyId: actor.academyId,
        playerId: goal.playerId,
        data: goal,
      });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: actor.academyId,
      actorId: actor.id,
      entityId: goal.id,
      action: "save-goal",
      version: 1,
      detail: { status: goal.status },
    });
  });
  return goal;
}
