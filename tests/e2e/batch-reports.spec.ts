import { test, expect, type APIRequestContext, type Browser } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { apiFor, base, stateFor, type RoleKey } from "./support/roles";
import { unusedMonth } from "./support/months";
import { chooseBatchAndMonth } from "./support/batch-view";

/**
 * Batch reports in a real browser, on a DISPOSABLE instance: the owner picks a batch and a month, creates drafts for everyone,
 * sees which are ready and why the others are not, approves only the ready ones, and gets a parent-wise list with WhatsApp and
 * Mail buttons. Seed: coach Aman coaches the Junior batch (Aarav Mehta, Diya Sharma); Priya is the guardian of both.
 */
const SHOTS = process.env.E2E_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const post = async (api: APIRequestContext, path: string, data: unknown) => {
  const r = await api.post(path, { headers: { origin: base() }, data, timeout: 60_000 });
  expect(r.ok(), `${path}: ${await r.text()}`).toBeTruthy();
  return r.json();
};
let dayCounter = 0;
async function completedSession(coach: APIRequestContext, month: string, attendance: (ids: string[]) => Record<string, string>) {
  const identity = await (await coach.get("/api/academy/identity")).json();
  const training = await (await coach.get("/api/training")).json();
  const batch = training.batches.find((b: { name: string }) => b.name === "Junior Foundations");
  const roster = training.players.filter((p: { batchId: string }) => p.batchId === batch.id).map((p: { id: string }) => p.id);
  const date = `${month}-${String(10 + (++dayCounter % 18)).padStart(2, "0")}`;
  const step = async (id: string, version: number, action: string, payload?: unknown) =>
    (await post(coach, `/api/training/sessions/${id}`, { version, action, payload })) as { id: string; version: number };
  let s = (await post(coach, "/api/training/sessions", {})) as { id: string; version: number };
  s = await step(s.id, s.version, "save", {
    title: `QA batch session ${dayCounter}`,
    batchId: batch.id,
    branchId: batch.branchId,
    coachId: identity.userId,
    localDate: date,
    localTime: "17:00",
    duration: 10,
    objective: "Movement and net control.",
    activities: [
      { id: "a1", drillId: "bd-21", drillVersion: 1, title: "x", minutes: 5, cues: "" },
      { id: "a2", drillId: "bd-29", drillVersion: 1, title: "x", minutes: 5, cues: "" },
    ],
    adjustments: [],
  });
  s = await step(s.id, s.version, "publish");
  s = await step(s.id, s.version, "start");
  s = await step(s.id, s.version, "attendance", attendance(roster));
  await step(s.id, s.version, "complete", { actuals: { a1: "COMPLETED", a2: "COMPLETED" }, recap: "Private.", acknowledgeAttendance: true });
}
async function as(browser: Browser, role: RoleKey) {
  const context = await browser.newContext({ storageState: await stateFor(role), viewport: { width: 1440, height: 1000 }, baseURL: base() });
  return { context, page: await context.newPage() };
}

test("owner: drafts for the batch, flagged reports excluded, ready ones approved, one row per parent", async ({ browser }) => {
  test.setTimeout(420_000);
  const coach = await apiFor("COACH");
  const month = await unusedMonth(coach);
  const players = (await (await coach.get("/api/training")).json()).players as { id: string; name: string }[];
  const aarav = players.find((p) => p.name === "Aarav Mehta")!.id;
  for (const mark of ["PRESENT", "PRESENT", "ABSENT"])
    await completedSession(coach, month, (ids) => Object.fromEntries(ids.map((id) => [id, id === aarav ? mark : "PRESENT"])));
  const { context, page } = await as(browser, "OWNER");
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));

  await page.goto("/reports");
  await page.getByRole("button", { name: "Batch reports" }).click();
  await chooseBatchAndMonth(page, "Junior Foundations", month);
  const rowOf = (name: string) => page.locator(".br-table tbody tr", { hasText: name });
  // 1. Choosing the batch makes a separate draft for everyone who has none, without a press (owner decision, 23 Nov 2026).
  await expect(page.getByText(/\d+ drafts? created\./)).toBeVisible();
  await expect(rowOf("Aarav Mehta")).not.toContainText("No draft yet");
  await expect(rowOf("Diya Sharma")).not.toContainText("No draft yet");
  // Only the chosen batch was drafted: players of other batches are not listed at all.
  await expect(page.locator(".br-table tbody tr", { hasText: "Arjun Rao" })).toHaveCount(0);
  await expect(rowOf("Aarav Mehta")).toContainText("The monthly summary is empty.");
  await expect(rowOf("Diya Sharma")).toContainText("Strengths are not written.");
  await expect(page.getByRole("button", { name: /^Approve and publish ready reports \(0\)/ })).toBeDisabled();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "batch-1-drafts-flagged.png"), fullPage: true });

  // 2. The owner finishes Aarav's report; Diya's is left flagged.
  await rowOf("Aarav Mehta").getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".report-studio")).toBeVisible();
  await page.getByRole("button", { name: "Use this as the summary" }).click();
  await expect(page.getByLabel("Coach report summary")).toHaveValue(/Aarav attended 2 of 3 recorded sessions/);
  await page.getByLabel("Strengths shown").fill("QA strengths: court movement.");
  await page.getByLabel("Areas to improve").fill("QA improve: backhand clear depth.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator(".rs-unsaved")).toHaveCount(0);

  // 3. Back in the batch view: Aarav is ready, Diya is not, and only the ready one is approved.
  await page.getByRole("button", { name: "Batch reports" }).click();
  await chooseBatchAndMonth(page, "Junior Foundations", month);
  await expect(rowOf("Aarav Mehta")).toContainText("Ready");
  await expect(rowOf("Diya Sharma")).toContainText("Strengths are not written.");
  await page.getByRole("button", { name: /^Approve and publish ready reports \(1\)/ }).click();
  await expect(page.getByRole("heading", { name: "Approve and publish 1 report?" })).toBeVisible();
  await page.getByRole("button", { name: "Approve and publish 1", exact: true }).click();
  await expect(page.getByText(/1 published\./)).toBeVisible();
  await expect(rowOf("Aarav Mehta")).toContainText("Published");
  await expect(rowOf("Diya Sharma")).toContainText("Strengths are not written.");

  // 4. The parent list: each parent once. Aarav has two parents (Priya and Raj); Diya's report is not published yet.
  // The free links are the MANUAL fallback, inside the delivery step; they are not automatic delivery.
  await page.getByText("Manual fallback: free links (not automatic)").click();
  await page.getByRole("button", { name: /^Prepare the parent list/ }).click();
  const share = page.getByTestId("batch-report-share");
  const parent = (name: string) => share.locator(".ss-people li", { hasText: name });
  await expect(share.locator(".ss-people li")).toHaveCount(2);
  const mailOf = async (name: string) =>
    decodeURIComponent((await parent(name).getByRole("link", { name: /Mail app/ }).getAttribute("href")) ?? "");
  expect(await mailOf("Priya")).toContain("Aarav's development report");
  expect(await mailOf("Priya")).not.toContain("Diya");
  expect(await mailOf("Raj")).toContain("Aarav's development report");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "batch-2-parent-list.png"), fullPage: true });

  // 5. Diya's report is completed and published: Priya (parent of both) still appears once, now with both children;
  // Raj (parent of Aarav only) is unchanged.
  const owner = await apiFor("OWNER");
  const reports = (await (await owner.get("/api/academy")).json()).reports as { id: string; version: number; playerId: string; status: string }[];
  const diya = players.find((p) => p.name === "Diya Sharma")!.id;
  const dr = reports.find((r) => r.playerId === diya && r.status === "DRAFT")!;
  await post(owner, "/api/academy/reports/update", { id: dr.id, version: dr.version, action: "save", summary: "Good month.", reason: "", strengths: "Smash.", improvements: "Stamina." });
  await post(owner, "/api/academy/reports/batch-approve", { reportIds: [dr.id] });
  await page.reload();
  await page.getByRole("button", { name: "Batch reports" }).click();
  await chooseBatchAndMonth(page, "Junior Foundations", month);
  await page.getByText("Manual fallback: free links (not automatic)").click();
  await page.getByRole("button", { name: /^Prepare the parent list/ }).click();
  await expect(share.locator(".ss-people li")).toHaveCount(2);
  expect(await mailOf("Priya")).toContain("Aarav and Diya's development report");
  expect(await mailOf("Raj")).toContain("Aarav's development report");
  expect(await mailOf("Raj")).not.toContain("Diya");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "batch-3-both-children.png"), fullPage: true });
  expect(problems).toEqual([]);
  await context.close();
  await coach.dispose();
  await owner.dispose();
});

test("coach: sees only their own batch and cannot approve a batch", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await as(browser, "COACH");
  await page.goto("/reports");
  await page.getByRole("button", { name: "Batch reports" }).click();
  await expect(page.getByRole("button", { name: /^Approve and publish ready reports/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Create drafts \(/ })).toBeVisible();
  const api = await apiFor("COACH");
  const refused = await api.post("/api/academy/reports/batch-approve", { headers: { origin: base() }, data: { reportIds: ["x"] } });
  expect(refused.status()).toBe(403);
  await api.dispose();
  await context.close();
});
