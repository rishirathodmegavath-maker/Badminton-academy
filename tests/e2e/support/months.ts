import type { APIRequestContext } from "@playwright/test";

/**
 * A month in which nobody has recorded a training session, for specs that record sessions and then draft a report over them.
 *
 * Several specs do this on the same disposable instance, and a report counts every completed session of the player in its period
 * (and in the period before it, for the progress comparison). A month picked at random can land on one another spec already
 * used, which makes the counts wrong for reasons that have nothing to do with the feature. This asks the server instead: the
 * first month from January 2030 with no session in it and none in the month before, so the "period before" is empty too.
 * `api` is any signed-in staff client that can read /api/training.
 */
export async function unusedMonth(api: APIRequestContext): Promise<string> {
  const training = (await (await api.get("/api/training")).json()) as { sessions: { data: { localDate: string } }[] };
  const used = new Set(training.sessions.map((s) => s.data.localDate.slice(0, 7)));
  const label = (i: number) => `${2030 + Math.floor(i / 12)}-${String(1 + (i % 12)).padStart(2, "0")}`;
  for (let i = 1; i < 240; i++) if (!used.has(label(i)) && !used.has(label(i - 1))) return label(i);
  throw new Error("Every month from 2030 on already has a recorded session on this instance.");
}
