import { test, expect, type APIRequestContext, type Browser } from "@playwright/test";
import { formatDate } from "../../src/modules/academy/ui/labels";

/**
 * Stage 5E in the browser: an owner changes "this and following" occurrences of a weekly series from the
 * calendar dialog, then cancels one occurrence, which is refused without a reason and accepted with one.
 * Creates records (a coach login and a series), so it runs ONLY under playwright.isolated.config.ts
 * (E2E_DISPOSABLE=true, loopback, never port 3100). Under any other configuration it is skipped.
 */
const base = process.env.E2E_BASE_URL ?? "";
const disposable =
  process.env.E2E_DISPOSABLE === "true" &&
  /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(base) &&
  new URL(base || "http://x").port !== "3100";
test.skip(!disposable, "needs a disposable instance (E2E_DISPOSABLE=true, E2E_BASE_URL, not port 3100)");

async function signedIn(browser: Browser, email: string) {
  const context = await browser.newContext({ baseURL: base });
  const login = await context.request.post("/api/auth/sign-in/email", {
    headers: { origin: base },
    data: { email, password: process.env.DEV_SEED_PASSWORD },
    timeout: 60_000,
  });
  expect(login.ok(), `sign-in ${login.status()}`).toBeTruthy();
  return context;
}
const post = (api: APIRequestContext, path: string, data: unknown) =>
  api.post("/api/academy" + path, { headers: { origin: base }, data, timeout: 60_000 });
type Occurrence = {
  id: string;
  version: number;
  kind: string;
  status: string;
  seriesId: string | null;
  occurrenceDate: string | null;
  data: {
    title: string;
    localDate: string;
    localTime: string;
    duration: number;
    branchId: string;
    coachId: string;
    batchId: string;
    playerIds: string[];
    seriesId: string | null;
    cancellation?: { reason: string; scope: string };
  };
};
type Workspace = {
  currentDate: string;
  branches: { id: string }[];
  events: Occurrence[];
  calendarSeries: { id: string; version: number; splitFrom: string | null }[];
};
const plusDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

test("series scopes and cancellation reasons from the calendar dialog", async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await signedIn(browser, "admin@greenfield.example");
  const workspace = async () => (await (await owner.request.get("/api/academy", { timeout: 60_000 })).json()) as Workspace;
  const start = await workspace();
  const stamp = Date.now();
  // A fresh coach so the series cannot clash with seeded sessions or events.
  const coach = await post(owner.request, "/settings/member", {
    name: `E2E Series Coach ${stamp}`,
    email: `e2e-series-coach-${stamp}@greenfield.example`,
    role: "COACH",
    active: true,
    professionalAttestation: "",
  });
  expect(coach.ok(), await coach.text()).toBeTruthy();
  const coachId = (await coach.json()).id as string;
  const title = `E2E series ${stamp}`;
  const first = plusDays(start.currentDate, 15);
  const made = await post(owner.request, "/calendar/event", {
    kind: "EVENT",
    title,
    localDate: first,
    localTime: "06:10",
    duration: 20,
    branchId: start.branches[0].id,
    coachId,
    batchId: "",
    playerIds: [],
    enquiryId: null,
    repeatWeeks: 4,
    requestId: crypto.randomUUID(),
  });
  expect(made.ok(), await made.text()).toBeTruthy();
  const { seriesId } = (await made.json()) as { seriesId: string };
  const ofSeries = async () =>
    (await workspace()).events
      .filter((e) => e.data.title.startsWith(title))
      .sort((a, b) => a.data.localDate.localeCompare(b.data.localDate));
  const [o1, o2, o3, o4] = await ofSeries();
  expect([o1, o2, o3, o4].every((o) => o.seriesId === seriesId)).toBe(true);

  const page = await owner.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const openOccurrence = async (date: string, name: string) => {
    await page.goto("/calendar", { timeout: 120_000 });
    await page.getByLabel("Calendar date").fill(date);
    await page.getByRole("button", { name: new RegExp(name) }).first().click();
    await expect(page.getByText("Weekly series").first()).toBeVisible();
    await page.getByRole("button", { name: "Edit / cancel event" }).click();
    await expect(page.getByRole("heading", { name: "Edit calendar event" })).toBeVisible();
  };

  // "This and following" from the second occurrence.
  await openOccurrence(o2.data.localDate, title);
  await page.getByLabel("Event title").fill(`${title} (late slot)`);
  await page.getByLabel("Apply to").selectOption("FOLLOWING");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit calendar event" })).toBeHidden();
  let now = await ofSeries();
  expect(now.map((o) => o.data.title)).toEqual([title, `${title} (late slot)`, `${title} (late slot)`, `${title} (late slot)`]);
  expect(now[0].seriesId).toBe(seriesId);
  const tail = now[1].seriesId!;
  expect(tail).not.toBe(seriesId);
  expect(now.slice(1).every((o) => o.seriesId === tail && o.data.seriesId === tail)).toBe(true);
  expect(now.map((o) => o.occurrenceDate)).toEqual([o1.occurrenceDate, o2.occurrenceDate, o3.occurrenceDate, o4.occurrenceDate]);
  expect((await workspace()).calendarSeries.find((s) => s.id === tail)?.splitFrom).toBe(seriesId);

  // Cancel only the third occurrence: refused without a reason, accepted with one.
  await openOccurrence(o3.data.localDate, `${title} \\(late slot\\)`);
  await page.getByLabel("Cancelled").check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Edit calendar event" }).getByRole("alert")).toContainText("reason");
  now = await ofSeries();
  expect(now[2].status).toBe("SCHEDULED");
  await page.getByLabel("Cancellation reason (required when cancelling)").fill("Hall closed for maintenance");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit calendar event" })).toBeHidden();
  now = await ofSeries();
  expect(now.map((o) => o.status)).toEqual(["SCHEDULED", "SCHEDULED", "CANCELLED", "SCHEDULED"]);
  expect(now[2].seriesId).toBe(tail);
  expect(now[2].data.cancellation?.reason).toBe("Hall closed for maintenance");
  await page.goto("/calendar", { timeout: 120_000 });
  await page.getByLabel("Calendar date").fill(o3.data.localDate);
  await page.getByRole("button", { name: /late slot/ }).first().click();
  await expect(page.getByText("Hall closed for maintenance")).toBeVisible();

  // DEC-3: cancelling "this and following" shows the server's preview (count and dates) before anything changes.
  const apiEdit = async (o: Occurrence, changes: Record<string, unknown>) => {
    const r = await post(owner.request, "/calendar/event", {
      id: o.id,
      version: o.version,
      kind: o.kind,
      title: o.data.title,
      localDate: o.data.localDate,
      localTime: o.data.localTime,
      duration: o.data.duration,
      branchId: o.data.branchId,
      coachId: o.data.coachId,
      batchId: o.data.batchId,
      playerIds: o.data.playerIds,
      enquiryId: null,
      repeatWeeks: 1,
      cancel: o.status === "CANCELLED",
      scope: "THIS",
      reason: "",
      ...changes,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  };
  // The fourth occurrence is changed individually (an exception that a cancellation keeps).
  await apiEdit((await ofSeries())[3], { title: `${title} (late slot) final` });
  await openOccurrence(o2.data.localDate, `${title} \\(late slot\\)`);
  await page.getByLabel("Apply to").selectOption("FOLLOWING");
  await page.getByLabel("Cancelled").check();
  await page.getByLabel("Cancellation reason (required when cancelling)").fill("Season ended early");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm cancellation" });
  await expect(confirmation).toContainText("1 occurrence will be cancelled");
  await expect(confirmation).toContainText(formatDate(o2.data.localDate));
  await expect(confirmation).toContainText("1 occurrence changed individually will stay scheduled");
  await expect(confirmation).toContainText(formatDate(o4.data.localDate));
  await expect(confirmation).toContainText("changed: title");
  expect((await ofSeries())[1].status, "nothing is cancelled by the preview").toBe("SCHEDULED");
  // Meanwhile someone cancels the individually changed occurrence: the confirmed preview is stale.
  await apiEdit((await ofSeries())[3], { cancel: true, reason: "Coach away" });
  await confirmation.getByRole("button", { name: "Cancel 1 occurrence" }).click();
  await expect(page.getByRole("dialog", { name: "Edit calendar event" }).getByRole("alert")).toContainText("changed after the cancellation was previewed");
  expect((await ofSeries())[1].status, "a stale preview cancels nothing").toBe("SCHEDULED");
  // Saving again asks the server for a fresh preview, which no longer lists a kept occurrence.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const fresh = page.getByRole("dialog", { name: "Confirm cancellation" });
  await expect(fresh).toContainText("1 occurrence will be cancelled");
  await expect(fresh).toContainText("No occurrence changed individually is affected.");
  await fresh.getByRole("button", { name: "Cancel 1 occurrence" }).click();
  await expect(page.getByRole("heading", { name: "Confirm cancellation" })).toBeHidden();
  now = await ofSeries();
  expect(now.map((o) => o.status)).toEqual(["SCHEDULED", "CANCELLED", "CANCELLED", "CANCELLED"]);
  expect(now[1].data.cancellation).toMatchObject({ reason: "Season ended early", scope: "FOLLOWING" });
  expect(now[3].data.cancellation?.reason).toBe("Coach away");
  expect(errors).toEqual([]);
});
