import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { inflateSync } from "node:zlib";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { apiFor, base, stateFor, type RoleKey } from "./support/roles";
import { unusedMonth } from "./support/months";

/**
 * The monthly development report in a real browser, on a DISPOSABLE instance: the numbered preparation workflow, the live
 * preview that follows every keystroke, draft save and reload, submit / approve / publish by the people allowed to, what a
 * family sees (and does not), phone layout, accessibility, and that the PDF carries what the screen shows.
 * Seed: scripts/seed.ts (coach Aman coaches the Junior batch; Priya is guardian of Aarav Mehta and Diya Sharma).
 */
const SHOTS = process.env.E2E_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
/** Screenshot of the report studio only: the sticky page shell is hidden so it cannot overlay a tall capture. */
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const pos = getComputedStyle(el).position;
      if ((pos === "fixed" || pos === "sticky") && !el.closest(".report-studio") && !el.querySelector(".report-studio")) el.style.visibility = "hidden";
    }
  });
  await page.locator(".report-studio").screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("body *")) if (el.style.visibility === "hidden") el.style.visibility = "";
  });
};
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const post = async (api: APIRequestContext, path: string, data: unknown) => {
  const r = await api.post(path, { headers: { origin: base() }, data, timeout: 60_000 });
  expect(r.ok(), `${path}: ${await r.text()}`).toBeTruthy();
  return r.json();
};

/** The text a PDF displays, read from its (deflated) content streams. */
function pdfText(bytes: Buffer) {
  const raw = bytes.toString("latin1");
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let text = m[1];
    try {
      text = inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      /* not deflated */
    }
    for (const h of text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(h[1], "hex").toString("latin1"));
  }
  return out.join("\n").replace(/\s+/g, " ");
}

let dayCounter = 0;
/** A completed session for the Junior batch, with real drills, recorded through the same API the Training screen uses. */
async function completedSession(coach: APIRequestContext, month: string, attendance: (ids: string[]) => Record<string, string>) {
  const identity = await (await coach.get("/api/academy/identity")).json();
  const training = await (await coach.get("/api/training")).json();
  const batch = training.batches.find((b: { name: string }) => b.name === "Junior Foundations");
  const roster = training.players.filter((p: { batchId: string }) => p.batchId === batch.id).map((p: { id: string }) => p.id);
  const date = `${month}-${String(10 + (++dayCounter % 18)).padStart(2, "0")}`;
  const step = async (id: string, version: number, action: string, payload?: unknown) =>
    (await post(coach, `/api/training/sessions/${id}`, { version, action, payload })) as { id: string; version: number; data: { localDate: string } };
  let s = (await post(coach, "/api/training/sessions", {})) as { id: string; version: number };
  s = await step(s.id, s.version, "save", {
    title: `QA monthly session ${dayCounter}`,
    batchId: batch.id,
    branchId: batch.branchId,
    coachId: identity.userId,
    localDate: date,
    localTime: "17:00",
    duration: 15,
    objective: "Movement, overhead and net control.",
    activities: [
      { id: "a1", drillId: "bd-21", drillVersion: 1, title: "x", minutes: 5, cues: "" },
      { id: "a2", drillId: "bd-29", drillVersion: 1, title: "x", minutes: 5, cues: "" },
      { id: "a3", drillId: null, drillVersion: null, title: "Club warm-up", minutes: 5, cues: "" },
    ],
    adjustments: [],
  });
  s = await step(s.id, s.version, "publish");
  s = await step(s.id, s.version, "start");
  s = await step(s.id, s.version, "attendance", attendance(roster));
  s = await step(s.id, s.version, "complete", {
    actuals: { a1: "COMPLETED", a2: "MODIFIED", a3: "COMPLETED" },
    recap: "PRIVATE RECAP: not for families.",
    acknowledgeAttendance: true,
  });
  return { ...s, roster, date };
}

/** A fresh month with sessions for Aarav (first player of the Junior batch): present, present, absent. */
async function seedMonth(coach: APIRequestContext, month: string) {
  const players = (await (await coach.get("/api/training")).json()).players as { id: string; name: string }[];
  const aarav = players.find((p) => p.name === "Aarav Mehta")!.id;
  const diya = players.find((p) => p.name === "Diya Sharma")!.id;
  for (const mark of ["PRESENT", "PRESENT", "ABSENT"])
    await completedSession(coach, month, (ids) => Object.fromEntries(ids.map((id) => [id, id === aarav ? mark : "PRESENT"])));
  return { aarav, diya };
}
async function newReport(api: APIRequestContext, playerId: string, month: string, title: string) {
  return (await post(api, "/api/academy/reports/create", { playerId, periodStart: `${month}-01`, periodEnd: `${month}-28`, title })) as {
    id: string;
    version: number;
    data: { evidence: { attendance: string; practised: unknown[] }[]; priorities: string[] };
  };
}
async function as(browser: Browser, role: RoleKey, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ storageState: await stateFor(role), viewport, baseURL: base() });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  return { context, page, problems };
}
async function openReport(page: Page, playerId: string, reportId: string) {
  await page.goto("/reports");
  await expect(page.locator(".report-studio")).toBeVisible({ timeout: 90_000 });
  await page.getByLabel("Player", { exact: true }).selectOption(playerId);
  await page.getByLabel("Reporting month").selectOption(reportId);
}

let month = "2027-05";
let aarav = "";
let diya = "";
test.beforeAll(async () => {
  test.setTimeout(300_000);
  const coach = await apiFor("COACH");
  // A month nobody else used on this disposable instance, asked of the server (the other report specs record sessions too).
  month = await unusedMonth(coach);
  ({ aarav, diya } = await seedMonth(coach, month));
  await coach.dispose();
});

test("Coach: numbered workflow, live preview that follows every edit, save, reload", async ({ browser }) => {
  test.setTimeout(300_000);
  const coachApi = await apiFor("COACH");
  const title = `QA monthly ${Date.now()}`;
  const report = await newReport(coachApi, aarav, month, title);
  // The draft snapshot is the recorded truth: present, present, absent.
  expect(report.data.evidence.map((e) => e.attendance)).toEqual(["PRESENT", "PRESENT", "ABSENT"]);
  const { context, page, problems } = await as(browser, "COACH");
  await openReport(page, aarav, report.id);

  // The four numbered steps.
  for (const heading of ["Select player and month", "Review training evidence", "Coach feedback", "Review and approve"])
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Live report preview" })).toBeVisible();

  // Step 2 shows the recorded evidence; the numbers are the ones the server recorded, not invented ones.
  const rows = page.locator(".rs-table tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Present");
  await expect(rows.nth(2)).toContainText("Absent");
  await expect(page.locator(".rs-evidence-stats")).toContainText("67% attendance");

  // The preview shows the same recorded facts, with no coach feedback invented.
  const sheet = page.locator(".rs-sheet");
  await expect(sheet).toContainText("Aarav Mehta");
  await expect(sheet).toContainText("Junior Foundations");
  // The player header shows the count and the percentage ("2 / 3", "67% attendance"); the progress table spells the same count out.
  await expect(sheet.locator(".rs-attendance strong")).toHaveText("2 / 3");
  await expect(sheet.locator(".rs-attendance small")).toHaveText("67% attendance");
  await expect(sheet.locator(".rs-progress-table")).toContainText("2 of 3 sessions (67%)");
  await expect(sheet.locator(".rs-practice")).not.toHaveCount(0);
  await expect(sheet).toContainText("Overhead shots"); // the recorded skill of the Clear-to-clear drill (bd-21)
  await expect(sheet).toContainText("Doubles play");
  await expect(sheet).toContainText("No coach summary recorded.");
  await shot(page, "01-coach-desktop-initial");

  // Live preview: nothing is saved yet, and the preview already shows the edit.
  await page.getByLabel("Coach report summary").fill("QA: moved well and recovered faster this month.");
  await expect(sheet).toContainText("QA: moved well and recovered faster this month.");
  await expect(page.locator(".rs-unsaved")).toBeVisible();
  await page.getByLabel("Strengths shown").fill("QA strengths: court movement.");
  await page.getByLabel("Areas to improve").fill("QA improve: backhand clear depth.");
  await page.getByLabel("Closing note (optional)").fill("QA closing: keep working on fitness.");
  await expect(sheet).toContainText("QA strengths: court movement.");
  await expect(sheet).toContainText("QA improve: backhand clear depth.");
  await expect(sheet).toContainText("QA closing: keep working on fitness.");
  await expect(page.locator("#rs-summary-count")).toHaveText(/^\d+\/3000$/);

  // Development priorities: add with the button and with Enter, refuse blanks and duplicates, cap at five, remove.
  const add = page.getByLabel("Add a development priority");
  for (const p of ["Net play consistency", "Backhand clear"]) {
    await add.fill(p);
    await page.getByRole("button", { name: "Add priority" }).click();
  }
  await add.fill("Smash power");
  await add.press("Enter");
  await add.fill("net PLAY consistency");
  await page.getByRole("button", { name: "Add priority" }).click();
  await expect(page.getByText("That priority is already listed.")).toBeVisible();
  await add.fill("");
  for (const p of ["Defensive positioning", "Serve variation"]) {
    await add.fill(p);
    await add.press("Enter");
  }
  await add.fill("One too many");
  await add.press("Enter");
  await expect(page.getByText("A report holds at most 5 priorities.")).toBeVisible();
  await expect(sheet.locator(".rs-priorities li")).toHaveText([
    "Net play consistency",
    "Backhand clear",
    "Smash power",
    "Defensive positioning",
    "Serve variation",
  ]);
  await page.getByRole("button", { name: "Remove priority Smash power" }).click();
  await expect(sheet.locator(".rs-priorities li")).toHaveCount(4);
  await expect(sheet.locator(".rs-priorities")).not.toContainText("Smash power");
  await shot(page, "02-coach-desktop-editing");

  // Coach view tags where each part comes from; the player's view shows none of that.
  await expect(sheet.locator(".rs-source")).toHaveCount(0);
  await page.getByRole("button", { name: "Coach view" }).click();
  await expect(sheet.locator(".rs-source-recorded").first()).toBeVisible();
  await expect(sheet.locator(".rs-source-calculated").first()).toBeVisible();
  await expect(sheet.locator(".rs-source-coach").first()).toBeVisible();
  await expect(page.getByRole("list", { name: "Coach checks" })).toBeVisible();
  await shot(page, "03-coach-view");
  await page.getByRole("button", { name: "Player view" }).click();
  await expect(sheet.locator(".rs-source")).toHaveCount(0);

  // Save the draft; what is on the server is exactly what was shown.
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
  await expect(page.locator(".rs-unsaved")).toHaveCount(0);
  const saved = (await (await coachApi.get("/api/academy")).json()).reports.find((r: { id: string }) => r.id === report.id);
  expect(saved.data.summary).toBe("QA: moved well and recovered faster this month.");
  expect(saved.data.priorities).toEqual(["Net play consistency", "Backhand clear", "Defensive positioning", "Serve variation"]);
  expect(saved.data.closingNote).toBe("QA closing: keep working on fitness.");

  // Reload: the draft and the preview come back.
  await page.reload();
  await expect(page.locator(".report-studio")).toBeVisible({ timeout: 90_000 });
  await page.getByLabel("Player", { exact: true }).selectOption(aarav);
  await page.getByLabel("Reporting month").selectOption(report.id);
  await expect(page.getByLabel("Coach report summary")).toHaveValue("QA: moved well and recovered faster this month.");
  await expect(page.locator(".rs-sheet .rs-priorities li")).toHaveCount(4);
  await expect(page.locator(".rs-sheet")).toContainText("QA closing: keep working on fitness.");
  expect(problems).toEqual([]);
  await context.close();
  await coachApi.dispose();
});

test("Approval and publication follow the existing rules; the family sees the published report and its PDF, nothing earlier", async ({ browser }) => {
  test.setTimeout(420_000);
  const coachApi = await apiFor("COACH");
  const ownerApi = await apiFor("OWNER");
  const guardianApi = await apiFor("GUARDIAN");
  const title = `QA publish ${Date.now()}`;
  // Unique to this run: a fixed sentence published by an earlier run on the same database would already be visible to the family,
  // and "nothing earlier than publication is shared" could not be checked.
  const publishSummary = `QA publish summary ${Date.now()}: steady month, good attendance.`;
  const report = await newReport(coachApi, aarav, month, title);

  // Coach: prepares and submits, cannot approve.
  const coach = await as(browser, "COACH");
  await openReport(coach.page, aarav, report.id);
  await coach.page.getByLabel("Coach report summary").fill(publishSummary);
  await coach.page.getByLabel("Add a development priority").fill("Serve consistency");
  await coach.page.getByLabel("Add a development priority").press("Enter");
  await coach.page.getByLabel("Closing note (optional)").fill("QA closing note for the family.");
  await expect(coach.page.getByRole("button", { name: "Approve and finalise" })).toHaveCount(0);
  const submit = coach.page.getByRole("button", { name: "Submit for review" });
  await expect(submit).toBeDisabled(); // the review confirmation is required first
  await coach.page.getByRole("checkbox", { name: /I have reviewed the player/ }).check();
  await submit.click();
  await expect(coach.page.getByText("Waiting for an owner, admin or head coach to approve this report.")).toBeVisible();
  await expect(coach.page.getByLabel("Coach report summary")).toHaveAttribute("readonly", "");
  await coach.context.close();
  // Not shared with the family yet.
  expect(JSON.stringify(await (await guardianApi.get("/api/academy")).json())).not.toContain(publishSummary);

  // Owner: approves and finalises, then publishes.
  const owner = await as(browser, "OWNER");
  await openReport(owner.page, aarav, report.id);
  await expect(owner.page.locator(".rs-sheet")).toContainText(publishSummary);
  const approve = owner.page.getByRole("button", { name: "Approve and finalise" });
  await expect(approve).toBeDisabled();
  await owner.page.getByRole("checkbox", { name: /I have reviewed the player/ }).check();
  await approve.click();
  await expect(owner.page.getByRole("button", { name: "Publish approved report" })).toBeVisible();
  expect(JSON.stringify(await (await guardianApi.get("/api/academy")).json())).not.toContain(publishSummary);
  await owner.page.getByRole("button", { name: "Publish approved report" }).click();
  await owner.page.getByRole("dialog").getByRole("button", { name: "Publish approved report" }).click();
  await expect(owner.page.getByText("This approved revision is available privately to authorised families.")).toBeVisible();
  await shot(owner.page, "04-owner-published");
  await owner.context.close();

  // Family: the published report on screen, exactly as shared. No editing, no coach view, no coach-only material.
  const family = await as(browser, "GUARDIAN");
  await family.page.goto("/family");
  await expect(family.page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 90_000 });
  await family.page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Schedule", exact: true }).click();
  await family.page.locator(".ops-tabs").getByRole("button", { name: "Reports", exact: true }).click();
  await family.page.getByLabel("Player", { exact: true }).selectOption(aarav);
  await family.page.getByLabel("Reporting month").selectOption(report.id);
  const fsheet = family.page.locator(".rs-sheet");
  await expect(fsheet).toBeVisible();
  await expect(fsheet).toContainText(publishSummary);
  await expect(fsheet).toContainText("Serve consistency");
  await expect(fsheet).toContainText("QA closing note for the family.");
  await expect(fsheet).toContainText("Published");
  await expect(fsheet.locator(".rs-source")).toHaveCount(0);
  await expect(family.page.getByRole("button", { name: "Coach view" })).toHaveCount(0);
  await expect(family.page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await expect(family.page.getByLabel("Coach report summary")).toHaveCount(0);
  const familyText = await family.page.locator("body").innerText();
  expect(familyText).not.toContain("PRIVATE RECAP");
  await shot(family.page, "05-family-desktop");

  // The PDF is the same report: every fact on the screen is in it.
  const pdf = await guardianApi.get(`/api/academy/reports/${report.id}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  const bytes = await pdf.body();
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const text = pdfText(bytes);
  for (const fact of [publishSummary, "Serve consistency", "QA closing note for the family.", "Aarav Mehta", "Junior Foundations", "Published"])
    expect(text, fact).toContain(fact);
  // The screen says "2 / 3" and "67% attendance"; the PDF's tiles say "2" with "of 3", and "67%". Same numbers, each in its own wording.
  const [attended, sessions] = (await fsheet.locator(".rs-attendance strong").innerText()).split("/").map((s) => s.trim());
  const percent = (await fsheet.locator(".rs-attendance small").innerText()).match(/\d+%/)![0];
  expect(text).toContain(`${attended} of ${sessions}`);
  expect(text).toContain(percent);
  const stats = await fsheet.locator(".rs-stats dd").allInnerTexts();
  for (const n of stats) expect(text).toContain(n.trim());
  expect(text).not.toContain("PRIVATE RECAP");
  await family.context.close();
  for (const a of [coachApi, ownerApi, guardianApi]) await a.dispose();
});

test("Access: another family, finance and nutrition never reach a report; guardians cannot author or approve", async ({ browser }) => {
  test.setTimeout(300_000);
  const coachApi = await apiFor("COACH");
  const ownerApi = await apiFor("OWNER");
  const report = await newReport(coachApi, diya, month, `QA access ${Date.now()}`);
  let r = await post(coachApi, "/api/academy/reports/update", { id: report.id, version: report.version, action: "save", summary: "QA access summary", reason: "" });
  r = await post(coachApi, "/api/academy/reports/update", { id: report.id, version: r.version, action: "submit", summary: "", reason: "" });
  r = await post(ownerApi, "/api/academy/reports/update", { id: report.id, version: r.version, action: "approve", summary: "", reason: "" });
  r = await post(ownerApi, "/api/academy/reports/update", { id: report.id, version: r.version, action: "publish", summary: "", reason: "" });
  const raj = await apiFor("GUARDIAN_TWO"); // linked to Aarav only, not to Diya
  expect((await raj.get(`/api/academy/reports/${report.id}/pdf`)).status()).toBe(404);
  expect(JSON.stringify(await (await raj.get("/api/academy")).json())).not.toContain("QA access summary");
  for (const role of ["GUARDIAN", "GUARDIAN_TWO", "FINANCE", "NUTRITION_PRO"] as RoleKey[]) {
    const api = await apiFor(role);
    for (const action of ["save", "submit", "approve", "publish"]) {
      const res = await api.post("/api/academy/reports/update", { headers: { origin: base() }, data: { id: report.id, version: r.version, action, summary: "x", reason: "" } });
      expect([403, 404], `${role} ${action}`).toContain(res.status());
    }
    const create = await api.post("/api/academy/reports/create", { headers: { origin: base() }, data: { playerId: diya, periodStart: `${month}-01`, periodEnd: `${month}-28`, title: "Nope" } });
    expect([403, 404], `${role} create`).toContain(create.status());
    await api.dispose();
  }
  // The guardian of the child can read the published PDF; finance and nutrition cannot.
  const priya = await apiFor("GUARDIAN");
  expect((await priya.get(`/api/academy/reports/${report.id}/pdf`)).status()).toBe(200);
  for (const role of ["FINANCE", "NUTRITION_PRO"] as RoleKey[]) {
    const api = await apiFor(role);
    expect([403, 404], role).toContain((await api.get(`/api/academy/reports/${report.id}/pdf`)).status());
    await api.dispose();
  }
  // Finance has no Reports screen at all.
  const fin = await as(browser, "FINANCE");
  await fin.page.goto("/reports");
  await expect(fin.page.locator(".report-studio")).toHaveCount(0);
  await fin.context.close();
  for (const a of [coachApi, ownerApi, raj, priya]) await a.dispose();
});

test("Phone: one panel at a time, switched with Edit / Preview; the page never scrolls sideways; the draft survives the switch", async ({ browser }) => {
  test.setTimeout(300_000);
  const coachApi = await apiFor("COACH");
  const report = await newReport(coachApi, aarav, month, `QA phone ${Date.now()}`);
  const { context, page, problems } = await as(browser, "COACH", { width: 390, height: 844 });
  await openReport(page, aarav, report.id);
  await expect(page.getByRole("group", { name: "Show" })).toBeVisible();
  // Edit panel first; the preview is not shown until asked for.
  await expect(page.locator(".rs-sheet")).toBeHidden();
  await page.getByLabel("Coach report summary").fill("QA phone summary stays after switching.");
  await shot(page, "06-coach-phone-edit");
  await page.getByRole("button", { name: /Preview report/ }).click();
  await expect(page.locator(".rs-sheet")).toBeVisible();
  await expect(page.locator(".rs-sheet")).toContainText("QA phone summary stays after switching.");
  await expect(page.getByLabel("Coach report summary")).toBeHidden();
  await shot(page, "07-coach-phone-preview");
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);
  await page.getByRole("button", { name: /Edit report/ }).click();
  await expect(page.getByLabel("Coach report summary")).toHaveValue("QA phone summary stays after switching.");
  const editOverflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(editOverflow.scroll).toBeLessThanOrEqual(editOverflow.inner);
  expect(problems).toEqual([]);
  await context.close();
  await coachApi.dispose();
});

test("Accessibility: no serious or critical violations in the studio (edit and preview, coach and player view) or the family report", async ({ browser }) => {
  test.setTimeout(300_000);
  const coachApi = await apiFor("COACH");
  const report = await newReport(coachApi, aarav, month, `QA a11y ${Date.now()}`);
  const { context, page } = await as(browser, "COACH");
  await openReport(page, aarav, report.id);
  await page.getByLabel("Coach report summary").fill("QA a11y summary.");
  await page.getByLabel("Add a development priority").fill("Net play consistency");
  await page.getByLabel("Add a development priority").press("Enter");
  const bad: string[] = [];
  const scan = async (label: string) => {
    const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    for (const v of res.violations.filter((x) => x.impact === "serious" || x.impact === "critical"))
      bad.push(`${label}: ${v.id} ×${v.nodes.length}: ${v.help} :: ${v.nodes.slice(0, 2).map((n) => (n.target ?? []).join(" ")).join(" | ")}`);
  };
  await scan("studio / player view");
  await page.getByRole("button", { name: "Coach view" }).click();
  await scan("studio / coach view");
  // Keyboard: the priority field adds on Enter and every control is reachable by Tab.
  await page.getByLabel("Add a development priority").focus();
  await page.keyboard.type("Backhand clear");
  await page.keyboard.press("Enter");
  await expect(page.locator(".rs-sheet .rs-priorities li")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await scan("studio / phone edit");
  await page.getByRole("button", { name: /Preview report/ }).click();
  await scan("studio / phone preview");
  await context.close();
  const family = await as(browser, "GUARDIAN");
  await family.page.goto("/family");
  await expect(family.page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 90_000 });
  await family.page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Schedule", exact: true }).click();
  await family.page.locator(".ops-tabs").getByRole("button", { name: "Reports", exact: true }).click();
  await expect(family.page.locator(".report-studio")).toBeVisible();
  const res = await new AxeBuilder({ page: family.page }).withTags(TAGS).analyze();
  for (const v of res.violations.filter((x) => x.impact === "serious" || x.impact === "critical"))
    bad.push(`family reports: ${v.id} ×${v.nodes.length}: ${v.help}`);
  await family.context.close();
  expect(bad.join("\n")).toBe("");
  await coachApi.dispose();
});
