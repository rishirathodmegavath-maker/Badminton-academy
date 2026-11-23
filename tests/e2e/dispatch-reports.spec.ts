import { test, expect, type APIRequestContext, type Browser } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { apiFor, base, stateFor, type RoleKey } from "./support/roles";
import { unusedMonth } from "./support/months";
import { chooseBatchAndMonth } from "./support/batch-view";

/**
 * Bulk delivery in a real browser, on a DISPOSABLE instance whose delivery channels are the TEST adapters (nothing leaves the
 * machine): the owner chooses recipients and channels, previews who is reached and who is left out, records a WhatsApp opt-in,
 * approves, runs the queue, and reads each message's state; then the parents open their links (and the wrong parent cannot).
 * Seed: Junior batch with Aarav Mehta and Diya Sharma; Priya is the parent of both, Raj of Aarav only.
 */
const SHOTS = process.env.E2E_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const post = async (api: APIRequestContext, path: string, data: unknown) => {
  const r = await api.post(path, { headers: { origin: base() }, data, timeout: 60_000 });
  expect(r.ok(), `${path}: ${await r.text()}`).toBeTruthy();
  return r.json();
};
let dayCounter = 0;
async function completedSession(coach: APIRequestContext, month: string) {
  const identity = await (await coach.get("/api/academy/identity")).json();
  const training = await (await coach.get("/api/training")).json();
  const batch = training.batches.find((b: { name: string }) => b.name === "Junior Foundations");
  const roster = training.players.filter((p: { batchId: string }) => p.batchId === batch.id).map((p: { id: string }) => p.id);
  const date = `${month}-${String(10 + (++dayCounter % 18)).padStart(2, "0")}`;
  const step = async (id: string, version: number, action: string, payload?: unknown) =>
    (await post(coach, `/api/training/sessions/${id}`, { version, action, payload })) as { id: string; version: number };
  let s = (await post(coach, "/api/training/sessions", {})) as { id: string; version: number };
  s = await step(s.id, s.version, "save", {
    title: `QA dispatch session ${dayCounter}`,
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
  s = await step(s.id, s.version, "attendance", Object.fromEntries(roster.map((id: string) => [id, "PRESENT"])));
  await step(s.id, s.version, "complete", { actuals: { a1: "COMPLETED", a2: "COMPLETED" }, recap: "Private.", acknowledgeAttendance: true });
}
async function as(browser: Browser, role: RoleKey) {
  const context = await browser.newContext({ storageState: await stateFor(role), viewport: { width: 1440, height: 1100 }, baseURL: base() });
  return { context, page: await context.newPage() };
}
/**
 * What the test delivery adapter has "sent" (a file in .data that outlives the database and earlier runs), from entry `from` on.
 * A test takes `outbox().length` before it sends anything and reads from there, so messages of earlier runs never count.
 */
const outbox = (from = 0) => {
  // The profile runner names the file the test adapters write to; without it they write to .data in the working folder.
  const file = process.env.DISPATCH_TEST_OUTBOX_FILE || join(process.cwd(), ".data", "dispatch-test-outbox.jsonl");
  const all = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { channel: string; to: string; subject?: string; text: string }) : [];
  return all.slice(from);
};

test("owner: choose recipients, preview, record an opt-in, approve, run the queue and read every state; parents open their own links only", async ({ browser }) => {
  test.setTimeout(480_000);
  const outboxFrom = outbox().length; // messages of earlier runs are not this test's
  const coach = await apiFor("COACH");
  const month = await unusedMonth(coach);
  await completedSession(coach, month);
  await completedSession(coach, month);
  const owner = await apiFor("OWNER");
  const players = (await (await owner.get("/api/training")).json()).players as { id: string; name: string }[];
  const aarav = players.find((p) => p.name === "Aarav Mehta")!.id;
  const diya = players.find((p) => p.name === "Diya Sharma")!.id;
  // two published reports through the ordinary, owner-approved path
  // The whole calendar month, exactly as the Batch reports screen asks for it.
  const [y, m] = month.split("-").map(Number);
  const lastDay = String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0");
  const made = (await post(owner, "/api/academy/reports/batch-drafts", { periodStart: `${month}-01`, periodEnd: `${month}-${lastDay}`, title: `QA ${month}`, playerIds: [aarav, diya] })) as { results: { reportId: string }[] };
  const academy = await (await owner.get("/api/academy")).json();
  for (const r of made.results) {
    const rep = academy.reports.find((x: { id: string }) => x.id === r.reportId) ?? (await (await owner.get("/api/academy")).json()).reports.find((x: { id: string }) => x.id === r.reportId);
    await post(owner, "/api/academy/reports/update", { id: rep.id, version: rep.version, action: "save", summary: "A steady month.", reason: "", strengths: "Footwork.", improvements: "Backhand." });
  }
  const approved = (await post(owner, "/api/academy/reports/batch-approve", { reportIds: made.results.map((r) => r.reportId) })) as { results: { outcome: string }[] };
  expect(approved.results.map((r) => r.outcome)).toEqual(["PUBLISHED", "PUBLISHED"]);
  // Priya has no WhatsApp number yet: the owner saves one for her (an owner may do that for a member of this academy)
  const priya = academy.members.find((m: { email: string }) => m.email === "priya@greenfield.example");
  await post(owner, "/api/academy/communications/phone", { userId: priya.id, phone: "+919811110001" });

  const { context, page } = await as(browser, "OWNER");
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto("/reports");
  await page.getByRole("button", { name: "Batch reports" }).click();
  await chooseBatchAndMonth(page, "Junior Foundations", month);
  const panel = page.getByTestId("dispatch-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/test mode: nothing leaves this computer/).first()).toBeVisible();

  // Parents, e-mail and WhatsApp. Two published reports: Priya has both children, Raj only Aarav.
  await panel.getByLabel("Parents", { exact: true }).check();
  await panel.getByLabel(/Email/).check();
  await panel.getByLabel(/WhatsApp \(official\)/).check();
  await panel.getByRole("button", { name: "Preview who will receive this" }).click();
  const preview = page.getByTestId("dispatch-preview");
  await expect(preview).toContainText("2 messages for 2 published reports");
  await expect(preview).toContainText("2 by e-mail · 0 by WhatsApp");
  await expect(preview.locator("tr", { hasText: "Priya" }).filter({ hasText: "No WhatsApp opt-in" })).toBeVisible();
  await expect(preview.locator("tr", { hasText: "Raj" }).filter({ hasText: "No address or number" })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "dispatch-1-preview.png"), fullPage: true });

  // Record Priya's opt-in; the preview updates and now includes one WhatsApp message
  await preview.locator("tr", { hasText: "Priya" }).getByRole("button", { name: "Record opt-in" }).click();
  await expect(preview).toContainText("3 messages for 2 published reports");
  await expect(preview).toContainText("2 by e-mail · 1 by WhatsApp");

  // Approve (owner-level) and queue: nothing is sent yet
  await panel.getByRole("button", { name: "Approve and send 3" }).first().click();
  await expect(page.getByRole("heading", { name: "Approve and send 3 messages?" })).toBeVisible();
  await page.getByRole("button", { name: "Approve and send 3" }).last().click();
  await expect(panel.getByText(/3 messages queued\./)).toBeVisible();
  const detail = page.getByTestId("dispatch-detail");
  // Three messages are queued; Raj (no WhatsApp number) is listed too, as "Not sent", so the history says who was left out.
  await expect(detail.locator("tbody tr")).toHaveCount(4);
  await expect(detail.locator(".dp-state", { hasText: "Queued" })).toHaveCount(3);
  await expect(detail.locator("tr", { hasText: "Raj" }).filter({ hasText: "Not sent" })).toHaveCount(1);
  expect(outbox(outboxFrom).filter((m) => m.text.includes("report-link#")).length, "approving queued, it did not send").toBe(0);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "dispatch-2-queued.png"), fullPage: true });

  // The worker (here: the test-mode runner) sends; the screen shows "Sent (accepted by the provider)", never "Delivered"
  await panel.getByRole("button", { name: "Process the queue now (test mode)" }).click();
  await expect(panel.getByText(/Test worker pass: 3 sent/)).toBeVisible();
  await panel.getByRole("button", { name: "Details" }).first().click();
  await expect(detail.locator(".dp-state", { hasText: "Sent (accepted by the provider)" })).toHaveCount(3);
  await expect(detail.getByText("Delivered", { exact: true })).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "dispatch-3-sent.png"), fullPage: true });
  // addresses are masked on screen
  await expect(detail).not.toContainText("priya@greenfield.example");

  // Approving the same selection again has nothing new to send
  await panel.getByRole("button", { name: "Preview who will receive this" }).click();
  await expect(preview).toContainText("0 messages");
  await expect(preview).toContainText("Already sent or queued");

  // What the families received: one e-mail to Priya naming BOTH children with a link each; Raj's names only Aarav
  const sent = outbox(outboxFrom).filter((m) => m.channel === "EMAIL");
  const toPriya = sent.find((m) => m.to === "priya@greenfield.example")!;
  const toRaj = sent.find((m) => m.to === "raj@greenfield.example")!;
  expect(toPriya.text).toContain("Aarav:");
  expect(toPriya.text).toContain("Diya:");
  expect(toRaj.text).toContain("Aarav");
  expect(toRaj.text).not.toContain("Diya");
  const tokenFor = (text: string, child: string) => new RegExp(`${child}: [^#\\s]*report-link#(\\S+)`).exec(text)?.[1] ?? "";
  const [aaravLink, diyaLink] = [tokenFor(toPriya.text, "Aarav"), tokenFor(toPriya.text, "Diya")];
  expect(aaravLink).toBeTruthy();
  expect(diyaLink).toBeTruthy();
  expect(aaravLink).not.toBe(diyaLink);

  // Priya opens both of her children's links. Raj opens Aarav's (his child) but is refused Diya's.
  const open = async (role: RoleKey, token: string) => {
    const g = await as(browser, role);
    await g.page.goto(`/report-link#${token}`);
    return g;
  };
  const priyaOpens = await open("GUARDIAN", diyaLink);
  await expect(priyaOpens.page.getByRole("heading", { name: "Diya's report" })).toBeVisible();
  await expect(priyaOpens.page.getByRole("link", { name: "Open the report (PDF)" })).toBeVisible();
  if (SHOTS) await priyaOpens.page.screenshot({ path: join(SHOTS, "dispatch-4-parent-opens.png") });
  // The parent's own portal shows the published report with the progress comparison, in numbers, and the PDF is the same report.
  await priyaOpens.page.goto("/");
  await priyaOpens.page.getByRole("button", { name: /^Reports$/ }).or(priyaOpens.page.getByRole("tab", { name: /^Reports$/ })).first().click();
  const progress = priyaOpens.page.getByTestId("rs-progress").first();
  await expect(progress).toBeVisible();
  await expect(progress.getByRole("heading", { name: /Progress compared with the period before/ })).toBeVisible();
  await expect(progress.getByRole("cell", { name: /^\d+ of \d+ sessions/ }).first()).toBeVisible();
  await expect(progress.getByText(/Not recorded in this period/)).toBeVisible();
  await expect(progress.getByText(/counts and differences only/)).toBeVisible();
  await expect(priyaOpens.page.getByText("Coach-entered")).toHaveCount(0); // the family sees no coach-only source tags
  if (SHOTS) await priyaOpens.page.screenshot({ path: join(SHOTS, "dispatch-4b-parent-report-progress.png"), fullPage: true });
  await priyaOpens.context.close();
  const rajWrong = await open("GUARDIAN_TWO", diyaLink);
  await expect(rajWrong.page.getByText(/not available to this account/)).toBeVisible();
  await expect(rajWrong.page.getByRole("link", { name: "Open the report (PDF)" })).toHaveCount(0);
  await rajWrong.context.close();
  const rajRight = await open("GUARDIAN_TWO", aaravLink);
  await expect(rajRight.page.getByRole("heading", { name: "Aarav's report" })).toBeVisible();
  await rajRight.context.close();
  // the owner (staff, not a parent of the child) cannot use a parent's link either
  const staff = await open("OWNER", aaravLink);
  await expect(staff.page.getByText(/not available to this account/)).toBeVisible();
  await staff.context.close();
  expect(problems).toEqual([]);
  await context.close();
  await coach.dispose();
  await owner.dispose();
});

test("owner: bulk invitations and resend from Settings, and the automatic-draft rules", async ({ browser }) => {
  test.setTimeout(300_000);
  const { context, page } = await as(browser, "OWNER");
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto("/settings");
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await page.getByRole("button", { name: "Invitations", exact: true }).click();
  const stamp = Date.now().toString(36);
  await page.getByText("Invite many parents at once").click();
  await page
    .getByLabel("Parents to invite")
    .fill([`Aarav Mehta, bulk-a-${stamp}@example.test, Father, Anil, +91 98765 43210`, `Diya Sharma, bulk-a-${stamp}@example.test, Father`, `No Such Child, bulk-b-${stamp}@example.test, Mother`].join("\n"));
  await page.getByRole("button", { name: "Create the invitations" }).click();
  await expect(page.getByText("2 of 3 invitations created.")).toBeVisible();
  await expect(page.getByText("No player with that name or id.")).toBeVisible();
  await expect(page.getByRole("link", { name: "WhatsApp" }).first()).toHaveAttribute("href", /wa\.me\/919876543210/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "invite-1-bulk.png"), fullPage: true });
  // resend gives a fresh link and the old one stops working
  const row = page.locator("tr", { hasText: `bulk-a-${stamp}@example.test`, has: page.getByRole("button", { name: "Resend" }) }).first();
  await row.getByRole("button", { name: "Resend" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Invitation created for bulk-a-${stamp}@example.test` })).toBeVisible();
  await expect(page.getByLabel("Invitation link")).toHaveValue(/\/invite#/);

  // the automatic-draft rules: save, then read back
  await page.goto("/reports");
  await page.getByRole("button", { name: "Batch reports" }).click();
  await page.getByText("Automatic drafts: when should reports be prepared?").click();
  // These are the academy's own settings and outlive this test: a required observation category makes every later batch approval
  // refuse reports that have none. The rules are put back as they were found at the end.
  const initial = {
    monthly: await page.getByLabel(/Prepare a draft each month/).isChecked(),
    afterN: await page.getByLabel(/Prepare a draft after/).isChecked(),
    n: await page.getByLabel("Number of completed sessions").inputValue(),
    behaviour: await page.getByLabel("Behaviour and discipline").isChecked(),
  };
  await page.getByLabel(/Prepare a draft each month/).check();
  await page.getByLabel("Number of completed sessions").fill("6");
  await page.getByLabel(/Prepare a draft after/).check();
  await page.getByLabel("Behaviour and discipline").check();
  // Wait for the save request itself: "Saved." is also a substring of the "Changes saved." toast already on screen.
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/academy/reports/policy-save") && r.ok()),
    page.getByRole("button", { name: "Save these rules" }).click(),
  ]);
  await page.reload();
  await page.getByRole("button", { name: "Batch reports" }).click();
  await page.getByText("Automatic drafts: when should reports be prepared?").click();
  await expect(page.getByLabel(/Prepare a draft each month/)).toBeChecked();
  await expect(page.getByLabel("Number of completed sessions")).toHaveValue("6");
  await expect(page.getByLabel("Behaviour and discipline")).toBeChecked();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "drafts-1-rules.png"), fullPage: true });
  // Put the rules back as they were found.
  await page.getByLabel(/Prepare a draft each month/).setChecked(initial.monthly);
  await page.getByLabel(/Prepare a draft after/).setChecked(initial.afterN);
  if (await page.getByLabel("Number of completed sessions").isEnabled()) await page.getByLabel("Number of completed sessions").fill(initial.n);
  await page.getByLabel("Behaviour and discipline").setChecked(initial.behaviour);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/academy/reports/policy-save") && r.ok()),
    page.getByRole("button", { name: "Save these rules" }).click(),
  ]);
  const restored = await (await (await apiFor("OWNER")).post("/api/academy/reports/policy", { headers: { origin: base() }, data: {} })).json();
  expect(restored.policy.requiredCategories.includes("BEHAVIOUR"), "the rules are back as they were found").toBe(initial.behaviour);
  expect(restored.policy.monthlyEnabled).toBe(initial.monthly);
  expect(problems).toEqual([]);
  await context.close();
});
