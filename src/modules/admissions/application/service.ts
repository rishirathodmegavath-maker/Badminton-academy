import { z } from "zod";
import { and, eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import {
  unit,
  history,
  expectVersion,
  scopedBatch,
  defaultProfile,
} from "../../academy/application/access";
import { saveEventTx } from "../../calendar/application/service";
import { academyToday, requireUnder18 } from "../../players/application/age-rules";
const enquirySchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.union([z.email(), z.literal("")]),
  phone: z.string().max(40),
  adult: z.boolean(),
  source: z.string().max(100),
  followUpDate: z.string().max(10),
  notes: z.string().max(2000),
  trialAttendance: z.enum(["NOT_MARKED", "PRESENT", "ABSENT", "EXCUSED"]),
  feedback: z.string().max(2000),
});
export async function saveEnquiry(a: Actor, input: unknown) {
  requireCapability(a, "admissions.manage");
  const v = z
    .object({
      id: z.string().optional(),
      version: z.number().int().optional(),
      status: z.enum(["ENQUIRY", "TRIAL", "WAITLIST", "CLOSED"]),
      data: enquirySchema,
    })
    .parse(input);
  if (v.data.adult) throw new DomainError("Adult players are not supported: every player must be under 18.", 422, "ADULT_PLAYERS_NOT_SUPPORTED");
  return unit(a, async (tx) => {
    const id = v.id ?? crypto.randomUUID();
    let version = 1;
    let trialEventId = null;
    let playerId = null;
    if (v.id) {
      const [old] = await tx
        .select()
        .from(t.enquiries)
        .where(
          and(eq(t.enquiries.academyId, a.academyId), eq(t.enquiries.id, id)),
        );
      if (!old) throw new DomainError("Enquiry not found.", 404);
      expectVersion(old.version, v.version ?? 0);
      if (old.status === "ENROLLED")
        throw new DomainError(
          "This identity is enrolled. Update its player record.",
        );
      version = old.version + 1;
      trialEventId = old.data.trialEventId;
      playerId = old.data.playerId;
    }
    if (v.data.trialAttendance !== "NOT_MARKED" && !trialEventId)
      throw new DomainError(
        "Schedule a trial before recording trial attendance.",
      );
    const data = { ...v.data, trialEventId, playerId };
    if (v.id)
      await tx
        .update(t.enquiries)
        .set({ data, status: v.status, version })
        .where(
          and(eq(t.enquiries.academyId, a.academyId), eq(t.enquiries.id, id)),
        );
    else
      await tx
        .insert(t.enquiries)
        .values({ id, academyId: a.academyId, status: v.status, data });
    await history(tx, a, "enquiry", id, version, { data, status: v.status });
    return { id, version };
  });
}
export async function scheduleTrial(a: Actor, input: unknown) {
  requireCapability(a, "admissions.manage");
  const v = z
    .object({ id: z.string(), version: z.number().int(), event: z.unknown() })
    .parse(input);
  return unit(a, async (tx) => {
    const [old] = await tx
      .select()
      .from(t.enquiries)
      .where(
        and(eq(t.enquiries.academyId, a.academyId), eq(t.enquiries.id, v.id)),
      );
    if (!old) throw new DomainError("Enquiry not found.", 404);
    expectVersion(old.version, v.version);
    if (old.status === "ENROLLED" || old.data.trialEventId)
      throw new DomainError(
        "Trial already scheduled or enquiry enrolled. Edit the existing occurrence in Calendar.",
      );
    const event = z.record(z.string(), z.unknown()).parse(v.event);
    const scheduled = await saveEventTx(a, tx, {
      ...event,
      kind: "TRIAL",
      enquiryId: v.id,
    });
    const data = { ...old.data, trialEventId: scheduled.id };
    await tx
      .update(t.enquiries)
      .set({ data, status: "TRIAL", version: old.version + 1 })
      .where(
        and(eq(t.enquiries.academyId, a.academyId), eq(t.enquiries.id, v.id)),
      );
    await history(tx, a, "enquiry", v.id, old.version + 1, {
      data,
      status: "TRIAL",
    });
    return scheduled;
  });
}
export async function convertEnquiry(a: Actor, input: unknown) {
  requireCapability(a, "admissions.manage");
  const v = z
    .object({ id: z.string(), version: z.number().int(), batchId: z.string(), birthDate: z.string().max(10).default("") })
    .parse(input);
  return unit(a, async (tx) => {
    const [old] = await tx
      .select()
      .from(t.enquiries)
      .where(
        and(eq(t.enquiries.academyId, a.academyId), eq(t.enquiries.id, v.id)),
      );
    if (!old) throw new DomainError("Enquiry not found.", 404);
    if (old.status === "ENROLLED") return { id: old.data.playerId };
    expectVersion(old.version, v.version);
    await scopedBatch(a, v.batchId, tx);
    if (old.data.trialAttendance !== "PRESENT" || !old.data.feedback.trim())
      throw new DomainError(
        "Record trial attendance and feedback before enrolment.",
      );
    // Players are under 18 and always have a date of birth: asked for here, because an enquiry does not hold one.
    requireUnder18({ birthDate: v.birthDate, adult: old.data.adult, status: "ACTIVE" }, await academyToday(tx, a.academyId), null);
    await tx
      .insert(t.players)
      .values({
        id: old.id,
        academyId: a.academyId,
        name: old.data.name,
        batchId: v.batchId,
      });
    await tx
      .insert(t.profiles)
      .values({
        academyId: a.academyId,
        playerId: old.id,
        data: {
          ...defaultProfile,
          adult: false,
          birthDate: v.birthDate,
          email: old.data.email,
          phone: old.data.phone,
        },
      });
    const data = { ...old.data, playerId: old.id };
    await tx
      .update(t.enquiries)
      .set({ data, status: "ENROLLED", version: old.version + 1 })
      .where(
        and(eq(t.enquiries.academyId, a.academyId), eq(t.enquiries.id, v.id)),
      );
    await tx
      .insert(t.playerHistory)
      .values({
        id: crypto.randomUUID(),
        academyId: a.academyId,
        playerId: old.id,
        kind: "ADMISSION_CONVERSION",
        detail: { enquiryId: old.id, batchId: v.batchId },
      });
    await history(tx, a, "enquiry", old.id, old.version + 1, {
      data,
      status: "ENROLLED",
    });
    return { id: old.id };
  });
}
