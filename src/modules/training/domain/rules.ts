import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import type { Activity, SessionData, TrainingSession } from "./types";
export class DomainError extends Error {
  constructor(
    message: string,
    public status = 422,
    /** Optional stable identifier clients may branch on (for example PASSWORD_CHANGE_REQUIRED). */
    public code?: string,
  ) {
    super(message);
  }
}
export const activityInput = z.object({
  id: z.string().min(1).max(100),
  drillId: z.string().nullable(),
  drillVersion: z.number().int().nullable(),
  title: z.string().trim().min(1).max(120),
  minutes: z.number().int().min(1).max(180),
  cues: z.string().max(1000),
});
export const draftInput = z.object({
  title: z.string().trim().max(120),
  batchId: z.string().max(100),
  branchId: z.string().max(100),
  coachId: z.string().max(100),
  localDate: z.string().max(10),
  localTime: z.string().max(5),
  duration: z.number().int().min(1).max(480),
  objective: z.string().max(2000),
  activities: z.array(activityInput).max(60),
  adjustments: z
    .array(
      z.object({
        playerId: z.string(),
        focus: z.string().trim().min(1).max(500),
        goalId: z.string().optional(),
      }),
    )
    .max(100),
});
export const totalMinutes = (activities: Pick<Activity, "minutes">[]) =>
  activities.reduce((total, a) => total + a.minutes, 0);
export function localInstant(date: string, time: string, timezone: string) {
  try {
    return Temporal.PlainDateTime.from(`${date}T${time}`)
      .toZonedDateTime(timezone, { disambiguation: "reject" })
      .toInstant()
      .toString();
  } catch {
    throw new DomainError(
      "Choose a valid local date and time. Ambiguous or missing daylight-saving times must be changed explicitly.",
    );
  }
}
export function validatePublish(data: SessionData) {
  if (
    !data.title ||
    !data.batchId ||
    !data.branchId ||
    !data.coachId ||
    !data.objective.trim()
  )
    throw new DomainError(
      "Add a title, batch, branch, coach and objective before publishing.",
    );
  if (!data.activities.length)
    throw new DomainError("Add at least one activity before publishing.");
  if (totalMinutes(data.activities) !== data.duration)
    throw new DomainError(
      "Activity minutes must match session duration. Correct the plan or update the session duration.",
    );
  if (!data.roster.length)
    throw new DomainError("The selected batch has no eligible players.");
  return localInstant(data.localDate, data.localTime, data.timezone);
}
export function requireTransition(
  status: TrainingSession["status"],
  action: string,
) {
  const permitted: Record<string, TrainingSession["status"][]> = {
    save: ["DRAFT"],
    publish: ["DRAFT"],
    start: ["PUBLISHED"],
    progress: ["IN_PROGRESS"],
    attendance: ["PUBLISHED", "IN_PROGRESS"],
    note: ["PUBLISHED", "IN_PROGRESS"],
    complete: ["IN_PROGRESS"],
    cancel: ["DRAFT", "PUBLISHED"],
    duplicate: ["DRAFT", "PUBLISHED", "IN_PROGRESS", "COMPLETED", "CANCELLED"],
  };
  if (!permitted[action]?.includes(status))
    throw new DomainError(
      `Cannot ${action} a ${status.toLowerCase().replaceAll("_", " ")} session.`,
      409,
    );
}
export function elapsedSeconds(
  progress: SessionData["progress"],
  now = Date.now(),
) {
  return (
    progress.elapsed +
    (progress.runningSince
      ? Math.max(
          0,
          Math.floor((now - Date.parse(progress.runningSince)) / 1000),
        )
      : 0)
  );
}
