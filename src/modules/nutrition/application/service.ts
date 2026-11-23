import { z } from "zod";
import { and, eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { can, requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import type { NutritionData } from "../../academy/domain/types";
import {
  unit,
  requireFeature,
  requirePlayer,
  history,
  expectVersion,
  family,
} from "../../academy/application/access";
import {
  withdrawPublished,
  withdrawalReason,
} from "../../academy/application/withdrawal";
export async function saveNutrition(a: Actor, input: unknown) {
  requireCapability(a, "nutrition.author");
  const v = z
    .object({
      id: z.string().optional(),
      version: z.number().int().optional(),
      playerId: z.string(),
      title: z.string().trim().min(2).max(150),
      guidance: z.string().trim().min(3).max(8000),
      action: z.enum(["save", "submit", "approve", "share", "revise"]),
      reviewNote: z.string().max(1000),
      sections: z
        .object({
          beforeTraining: z.string().max(2000),
          afterTraining: z.string().max(2000),
          dailyMeals: z.string().max(2000),
          hydration: z.string().max(2000),
          trainingDay: z.string().max(2000),
        })
        .optional(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "nutrition", tx);
    await requirePlayer(a, v.playerId, tx);
    const id = v.id ?? crypto.randomUUID();
    let version = 1;
    let status = "DRAFT";
    let data: NutritionData = {
      playerId: v.playerId,
      title: v.title,
      guidance: v.guidance,
      professional: null as string | null,
      reviewNote: "",
      approvedAt: null as string | null,
    };
    if (v.id) {
      const [old] = await tx
        .select()
        .from(t.nutritionPlans)
        .where(
          and(
            eq(t.nutritionPlans.academyId, a.academyId),
            eq(t.nutritionPlans.id, id),
          ),
        );
      if (!old || old.playerId !== v.playerId)
        throw new DomainError("Nutrition plan not found.", 404);
      expectVersion(old.version, v.version ?? 0);
      data = structuredClone(old.data);
      status = old.status;
      version = old.version + 1;
    }
    if (v.action === "save") {
      if (status !== "DRAFT")
        throw new DomainError("Revise the plan before editing.");
      data.title = v.title;
      data.guidance = v.guidance;
      if (v.sections) data.sections = v.sections;
    }
    if (v.action === "submit") {
      if (status !== "DRAFT")
        throw new DomainError("Submit a draft for professional review.");
      status = "IN_REVIEW";
    }
    if (v.action === "approve") {
      requireCapability(a, "nutrition.approve");
      if (status !== "IN_REVIEW" || v.reviewNote.trim().length < 3)
        throw new DomainError(
          "Professional approval requires a submitted plan and a review note.",
        );
      status = "APPROVED";
      // Attribution comes only from the signed-in session, never from the request: the name is a
      // snapshot taken now, the id says which account approved.
      data.professional = a.name;
      data.professionalId = a.id;
      data.approvedAt = new Date().toISOString();
      data.reviewNote = v.reviewNote;
    }
    if (v.action === "share") {
      requireCapability(a, "nutrition.share");
      if (status !== "APPROVED")
        throw new DomainError(
          "Only professionally approved plans can be shared.",
        );
      status = "SHARED";
    }
    if (v.action === "revise") {
      if (!["APPROVED", "SHARED", "WITHDRAWN"].includes(status))
        throw new DomainError("Only approved or shared plans need revision.");
      status = "DRAFT";
      data = {
        ...data,
        professional: null,
        professionalId: null,
        approvedAt: null,
        reviewNote: "",
      };
    }
    const [saved] = v.id
      ? await tx
          .update(t.nutritionPlans)
          .set({ version, status, data })
          .where(
            and(
              eq(t.nutritionPlans.academyId, a.academyId),
              eq(t.nutritionPlans.id, id),
            ),
          )
          .returning()
      : await tx
          .insert(t.nutritionPlans)
          .values({
            id,
            academyId: a.academyId,
            playerId: v.playerId,
            data,
            status,
          })
          .returning();
    await history(tx, a, "nutrition-plan", id, version, { data, status });
    return saved;
  });
}
/**
 * Withdraws a shared nutrition plan from families. Not a revision: the history stays, the shared
 * revision stops being available to them. Same authority as sharing (owner, admin, head coach,
 * nutrition professional) and the usual player access (a professional needs an active assignment).
 */
export async function withdrawNutritionPlan(a: Actor, input: unknown) {
  requireCapability(a, "nutrition.share");
  const v = z
    .object({
      id: z.string().min(1).max(200),
      version: z.number().int(),
      reason: z.string().max(2000),
    })
    .parse(input);
  const reason = withdrawalReason(v.reason);
  return unit(a, async (tx) => {
    await requireFeature(a, "nutrition", tx);
    const [plan] = await tx
      .select()
      .from(t.nutritionPlans)
      .where(
        and(
          eq(t.nutritionPlans.academyId, a.academyId),
          eq(t.nutritionPlans.id, v.id),
        ),
      );
    if (!plan) throw new DomainError("Nutrition plan not found.", 404);
    await requirePlayer(a, plan.playerId, tx);
    expectVersion(plan.version, v.version);
    return withdrawPublished(tx, a, {
      kind: "nutrition-plan",
      row: plan,
      reason,
      save: async (status, version) => {
        const [saved] = await tx
          .update(t.nutritionPlans)
          .set({ status, version })
          .where(
            and(
              eq(t.nutritionPlans.academyId, a.academyId),
              eq(t.nutritionPlans.id, plan.id),
            ),
          )
          .returning();
        return saved;
      },
    });
  });
}
export async function saveRestrictions(a: Actor, input: unknown) {
  if (!family(a)) requireCapability(a, "nutrition.restricted");
  const v = z
    .object({
      playerId: z.string(),
      version: z.number().int(),
      allergies: z.string().max(2000),
      restrictions: z.string().max(2000),
    })
    .parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "nutrition", tx);
    // RC-4: allergies and restrictions are the HEALTH section.
    await requirePlayer(a, v.playerId, tx, "HEALTH");
    const [old] = await tx
      .select()
      .from(t.restrictedNutrition)
      .where(
        and(
          eq(t.restrictedNutrition.academyId, a.academyId),
          eq(t.restrictedNutrition.playerId, v.playerId),
        ),
      );
    expectVersion(old?.version ?? 1, v.version);
    await tx
      .insert(t.restrictedNutrition)
      .values({
        academyId: a.academyId,
        playerId: v.playerId,
        version: (old?.version ?? 1) + 1,
        allergies: v.allergies,
        restrictions: v.restrictions,
      })
      .onConflictDoUpdate({
        target: [
          t.restrictedNutrition.academyId,
          t.restrictedNutrition.playerId,
        ],
        set: {
          version: (old?.version ?? 1) + 1,
          allergies: v.allergies,
          restrictions: v.restrictions,
        },
      });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: v.playerId,
      action: "restricted-nutrition-updated",
      version: (old?.version ?? 1) + 1,
      detail: {},
    });
    return { ok: true };
  });
}
export async function nutritionQuestion(a: Actor, input: unknown) {
  const v = z
    .object({
      id: z.string().optional(),
      version: z.number().int().optional(),
      playerId: z.string(),
      question: z.string().trim().min(3).max(2000),
      answer: z.string().max(3000),
    })
    .parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "nutrition", tx);
    // RC-4: private nutrition questions are the HEALTH section.
    await requirePlayer(a, v.playerId, tx, "HEALTH");
    if (v.id) {
      requireCapability(a, "nutrition.answer");
      const [old] = await tx
        .select()
        .from(t.nutritionQuestions)
        .where(
          and(
            eq(t.nutritionQuestions.academyId, a.academyId),
            eq(t.nutritionQuestions.id, v.id),
            eq(t.nutritionQuestions.playerId, v.playerId),
          ),
        );
      if (!old) throw new DomainError("Question not found.", 404);
      expectVersion(old.version, v.version ?? 0);
      await tx
        .update(t.nutritionQuestions)
        .set({ answer: v.answer, version: old.version + 1 })
        .where(
          and(
            eq(t.nutritionQuestions.academyId, a.academyId),
            eq(t.nutritionQuestions.id, v.id),
          ),
        );
    } else {
      if (!can(a, "nutrition.ask"))
        throw new DomainError(
          "Only linked families can ask private questions.",
          403,
        );
      await tx.insert(t.nutritionQuestions).values({
        id: crypto.randomUUID(),
        academyId: a.academyId,
        playerId: v.playerId,
        authorId: a.id,
        question: v.question,
      });
    }
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: v.playerId,
      action: v.id
        ? "nutrition-question-answered"
        : "nutrition-question-created",
      version: 1,
      detail: {},
    });
    return { ok: true };
  });
}
/**
 * Assigns a player to a Nutrition Pro, or withdraws the assignment. Until an assignment is active
 * the professional sees nothing about that player (see accessiblePlayers). Owner and Admin manage
 * assignments; nobody can assign themselves, and the target must be an active NUTRITION_PRO of
 * this academy (a missing, inactive, other-academy or other-role id is the same "not found").
 */
export async function assignNutrition(a: Actor, input: unknown) {
  requireCapability(a, "nutrition.assign");
  const v = z
    .object({
      playerId: z.string().min(1).max(200),
      professionalId: z.string().min(1).max(200),
      active: z.boolean(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    await requirePlayer(a, v.playerId, tx);
    const [professional] = await tx
      .select()
      .from(t.memberships)
      .where(
        and(
          eq(t.memberships.academyId, a.academyId),
          eq(t.memberships.userId, v.professionalId),
          eq(t.memberships.role, "NUTRITION_PRO"),
          eq(t.memberships.active, true),
        ),
      );
    if (!professional) throw new DomainError("Member not found.", 404);
    await tx
      .insert(t.nutritionAssignments)
      .values({
        academyId: a.academyId,
        playerId: v.playerId,
        professionalId: v.professionalId,
        active: v.active,
        assignedBy: a.id,
      })
      .onConflictDoUpdate({
        target: [
          t.nutritionAssignments.academyId,
          t.nutritionAssignments.playerId,
          t.nutritionAssignments.professionalId,
        ],
        set: { active: v.active, assignedBy: a.id, updatedAt: new Date() },
      });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: v.playerId,
      action: v.active ? "nutrition-assigned" : "nutrition-unassigned",
      version: 1,
      detail: { professionalId: v.professionalId },
    });
    return { ok: true };
  });
}
