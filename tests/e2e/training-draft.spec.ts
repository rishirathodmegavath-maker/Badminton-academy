import { test, expect, type Page } from "@playwright/test";

/**
 * Stage 4 — training draft reliability and navigation safety, in a real browser.
 *
 * These tests create and edit records, so they only run against a DISPOSABLE instance (playwright.isolated.config.ts
 * enforces it: E2E_DISPOSABLE=true, loopback, never port 3100). Under any other configuration the file is skipped,
 * and a skipped test is reported as skipped, never as passed.
 */
const base = process.env.E2E_BASE_URL ?? "";
const disposable =
  process.env.E2E_DISPOSABLE === "true" &&
  /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base) &&
  !base.endsWith(":3100");
test.skip(
  !disposable,
  "needs a disposable instance (E2E_DISPOSABLE=true, E2E_BASE_URL, not port 3100)",
);

const PASSWORD = process.env.DEV_SEED_PASSWORD ?? "";
const ACCOUNT = {
  coach: "aman@greenfield.example", // COACH, Greenfield
  headCoach: "headcoach@greenfield.example", // HEAD_COACH, Greenfield (manager: sees every session)
  otherAcademy: "maya@bluebird.example", // COACH, Bluebird
} as const;
const STORAGE_PREFIX = "sportozen.training-draft";

type Cookie = Awaited<
  ReturnType<ReturnType<Page["context"]>["cookies"]>
>[number];
const sessions = new Map<string, Cookie[]>();
/**
 * Signs in once per account and reuses the session cookies (the sign-in endpoint is rate limited and we do not weaken
 * that for tests); a 429 waits for the window. `fresh` forces a new sign-in (after a test that signed the person out).
 */
async function signIn(page: Page, email: string, fresh = false) {
  const context = page.context();
  await context.clearCookies();
  const cached = fresh ? undefined : sessions.get(email);
  if (cached) {
    await context.addCookies(cached);
    return;
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await page.request.post("/api/auth/sign-in/email", {
      headers: { origin: base },
      data: { email, password: PASSWORD },
    });
    if (r.ok()) {
      sessions.set(email, await context.cookies());
      return;
    }
    expect(r.status(), `sign-in for ${email}`).toBe(429);
    await page.waitForTimeout(15_000);
  }
  throw new Error(`sign-in for ${email} stayed rate limited`);
}
/** Answers every browser dialog the same way (until told otherwise) and records what was asked. */
function dialogs(page: Page) {
  const seen: { type: string; message: string }[] = [];
  const policy = { next: "accept" as "accept" | "dismiss" };
  page.on("dialog", async (d) => {
    seen.push({ type: d.type(), message: d.message() });
    if (policy.next === "accept") await d.accept();
    else await d.dismiss();
  });
  return { seen, policy };
}
const mainNav = (page: Page) =>
  page.getByRole("navigation", { name: "Main navigation" });
const titleBox = (page: Page) =>
  page.getByLabel("Session title", { exact: true });
const indicator = (page: Page) => page.locator(".draft-indicator");
const keys = (page: Page) =>
  page.evaluate(
    (prefix) => Object.keys(localStorage).filter((k) => k.startsWith(prefix)),
    STORAGE_PREFIX,
  );
const entryCount = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { navigation: { entries(): unknown[] } }
      ).navigation.entries().length,
  );
const sessionId = (page: Page) => new URL(page.url()).hash.slice(1);

async function newDraft(page: Page) {
  await page.goto("/overview");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({
    timeout: 90_000,
  });
  await mainNav(page).getByRole("link", { name: "Training" }).click();
  await expect(page).toHaveURL(/\/training/);
  await page.getByRole("button", { name: "Create session" }).first().click();
  await expect(titleBox(page)).toBeVisible();
  await expect(page).toHaveURL(/\/training#[0-9a-f-]{36}$/);
  await expect(indicator(page)).toHaveText("Saved draft");
  return sessionId(page);
}
/** Types into the draft and waits until the recovery copy has been written. */
async function edit(page: Page, title: string) {
  await titleBox(page).fill(title);
  await expect(indicator(page)).toHaveText("Unsaved changes");
  await expect
    .poll(async () => (await keys(page)).length, {
      message: "recovery copy written",
    })
    .toBeGreaterThan(0);
}
/** Browser Back / Forward as the browser's own controls do it (not a script call), then let the guard settle. */
async function back(page: Page) {
  await page.goBack({ waitUntil: "commit", timeout: 8_000 }).catch(() => null);
  await page.waitForTimeout(700);
}
async function forward(page: Page) {
  await page
    .goForward({ waitUntil: "commit", timeout: 8_000 })
    .catch(() => null);
  await page.waitForTimeout(700);
}
async function serverSessions(page: Page) {
  const r = await page.request.get("/api/training");
  expect(r.ok()).toBeTruthy();
  return (await r.json()).sessions as {
    id: string;
    version: number;
    status: string;
    data: { title: string };
  }[];
}
async function serverSave(
  page: Page,
  id: string,
  version: number,
  title: string,
) {
  const identity = await (
    await page.request.get("/api/academy/identity")
  ).json();
  const r = await page.request.post(`/api/training/sessions/${id}`, {
    headers: { origin: base },
    data: {
      version,
      action: "save",
      payload: {
        title,
        batchId: "",
        branchId: "",
        coachId: identity.userId,
        localDate: "",
        localTime: "",
        duration: 60,
        objective: "",
        activities: [],
        adjustments: [],
      },
    },
  });
  return r;
}
/** Another person signs in on the same browser: leave the page first (a hash-only goto would keep the old app state). */
async function switchUser(page: Page, email: string) {
  await page.goto("about:blank");
  await signIn(page, email);
}
const watchErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
};

test("Back with unsaved edits asks once; staying keeps the draft, the page and the history untouched", async ({
  page,
}) => {
  const errors = watchErrors(page);
  const d = dialogs(page);
  await signIn(page, ACCOUNT.coach);
  const id = await newDraft(page);
  await edit(page, "Back guard draft");
  const entries = await entryCount(page);

  d.policy.next = "dismiss";
  await back(page);
  expect(d.seen).toHaveLength(1);
  expect(d.seen[0].type).toBe("confirm");
  expect(d.seen[0].message).toMatch(/unsaved changes/i);
  await expect(page).toHaveURL(new RegExp(`/training#${id}$`));
  await expect(titleBox(page)).toHaveValue("Back guard draft");
  await expect(indicator(page)).toHaveText("Unsaved changes");
  expect(await entryCount(page)).toBe(entries);

  // Cancelling again and again never adds history entries or stacks dialogs.
  await back(page);
  await back(page);
  expect(d.seen).toHaveLength(3);
  expect(await entryCount(page)).toBe(entries);
  await expect(page).toHaveURL(new RegExp(`/training#${id}$`));

  // Leaving: exactly one question, then the app really moves.
  d.policy.next = "accept";
  await back(page);
  expect(d.seen).toHaveLength(4);
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole("heading", { level: 1 }).first()).toContainText(
    /Good (morning|afternoon|evening)|Overview/i,
  );

  // Having agreed to leave, coming back does not ask again, and the edits are still there.
  await forward(page);
  await expect(page).toHaveURL(new RegExp(`/training#${id}$`));
  expect(d.seen).toHaveLength(4);
  await expect(titleBox(page)).toHaveValue("Back guard draft");
  await expect(indicator(page)).toHaveText("Unsaved changes");

  // A new departure from the draft is a new question.
  d.policy.next = "dismiss";
  await back(page);
  expect(d.seen).toHaveLength(5);
  await expect(page).toHaveURL(new RegExp(`/training#${id}$`));
  expect(errors).toEqual([]);
});

test("Forward with unsaved edits is guarded the same way", async ({ page }) => {
  const d = dialogs(page);
  await signIn(page, ACCOUNT.coach);
  const id = await newDraft(page);
  await edit(page, "Forward guard draft");
  // leave through the sidebar (asked once), then come back with Back (not asked: already agreed to leave)
  await mainNav(page).getByRole("link", { name: "Players" }).click();
  await expect(page).toHaveURL(/\/players$/);
  expect(d.seen).toHaveLength(1);
  await back(page);
  await expect(page).toHaveURL(new RegExp(`/training#${id}$`));
  expect(d.seen).toHaveLength(1);
  // Forward from the draft is a departure again.
  d.policy.next = "dismiss";
  await forward(page);
  expect(d.seen).toHaveLength(2);
  await expect(page).toHaveURL(new RegExp(`/training#${id}$`));
  await expect(titleBox(page)).toHaveValue("Forward guard draft");
  d.policy.next = "accept";
  await forward(page);
  expect(d.seen).toHaveLength(3);
  await expect(page).toHaveURL(/\/players$/);
});

test("Sidebar navigation and the account links: cancel keeps the draft, confirm moves on, one question each", async ({
  page,
}) => {
  const d = dialogs(page);
  await signIn(page, ACCOUNT.coach);
  const id = await newDraft(page);
  await edit(page, "Sidebar guard draft");
  d.policy.next = "dismiss";
  await mainNav(page).getByRole("link", { name: "Calendar" }).click();
  expect(d.seen).toHaveLength(1);
  await expect(page).toHaveURL(new RegExp(`/training#${id}$`));
  await expect(titleBox(page)).toHaveValue("Sidebar guard draft");
  d.policy.next = "accept";
  await mainNav(page).getByRole("link", { name: "Calendar" }).click();
  expect(d.seen).toHaveLength(2);
  await expect(page).toHaveURL(/\/calendar$/);
});

test("Programmatic navigation: creating or opening another session while editing asks first and keeps the edits on this device", async ({
  page,
}) => {
  const d = dialogs(page);
  await signIn(page, ACCOUNT.coach);
  const first = await newDraft(page);
  await edit(page, "First draft kept");
  const before = (await serverSessions(page)).length;

  d.policy.next = "dismiss";
  await page.getByRole("button", { name: "Create session" }).first().click();
  expect(d.seen).toHaveLength(1);
  expect(d.seen[0].message).toMatch(/stay on this device/i);
  expect(sessionId(page)).toBe(first);
  expect((await serverSessions(page)).length).toBe(before);

  d.policy.next = "accept";
  await page.getByRole("button", { name: "Create session" }).first().click();
  await expect.poll(() => sessionId(page)).not.toBe(first);
  expect((await serverSessions(page)).length).toBe(before + 1);
  // The first draft was not discarded: its copy is still here and is offered back.
  expect(await keys(page)).toHaveLength(1);
  const other = page.getByTestId("other-drafts");
  await expect(other).toBeVisible();
  await other.getByRole("button", { name: /First draft kept/ }).click();
  await expect(page.getByTestId("draft-recovery")).toBeVisible();
  await page.getByRole("button", { name: "Restore my edits" }).click();
  await expect(page).toHaveURL(new RegExp(`/training#${first}$`));
  await expect(titleBox(page)).toHaveValue("First draft kept");
  await expect(indicator(page)).toHaveText("Unsaved changes");
});

test("No unsaved changes: Back, Forward and the sidebar never ask", async ({
  page,
}) => {
  const errors = watchErrors(page);
  const d = dialogs(page);
  await signIn(page, ACCOUNT.coach);
  await newDraft(page);
  await back(page);
  await expect(page).toHaveURL(/\/overview$/);
  await forward(page);
  await expect(page).toHaveURL(/\/training#/);
  await mainNav(page).getByRole("link", { name: "Players" }).click();
  await expect(page).toHaveURL(/\/players$/);
  await back(page);
  await forward(page);
  expect(d.seen).toEqual([]);
  expect(errors).toEqual([]);
});

test("Refresh and tab close: the browser asks, the edits survive, and the draft can be restored and saved", async ({
  page,
}) => {
  const d = dialogs(page);
  await signIn(page, ACCOUNT.coach);
  const id = await newDraft(page);
  await edit(page, "Refresh survivor");
  const copiesBefore = await keys(page);

  // A second tab opened on the same session is offered the first tab's kept edits (it has none of its own).
  const second = await page.context().newPage();
  await second.goto(`/training#${id}`);
  await expect(titleBox(second)).toBeVisible();
  await expect(second.getByTestId("draft-recovery")).toBeVisible();
  await second.close();

  // Refresh: accept the browser's prompt; the page reloads without the in-memory edits.
  d.policy.next = "accept";
  await page.reload();
  expect(d.seen.some((x) => x.type === "beforeunload")).toBeTruthy();
  const banner = page.getByTestId("draft-recovery");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("kept on this device");
  await expect(banner).toContainText("Refresh survivor"); // names the edits that were typed, not the saved title
  expect(await keys(page)).toEqual(copiesBefore);
  await expect(titleBox(page)).toHaveValue("");

  await page.getByRole("button", { name: "Restore my edits" }).click();
  await expect(titleBox(page)).toHaveValue("Refresh survivor");
  await expect(indicator(page)).toHaveText("Unsaved changes");
  await expect(banner).toBeHidden();

  // A confirmed save removes the recovery copy.
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  await expect(indicator(page)).toHaveText("Saved draft");
  await expect.poll(() => keys(page)).toEqual([]);
  expect(
    (await serverSessions(page)).find((s) => s.id === id)?.data.title,
  ).toBe("Refresh survivor");
});

test("Closing the tab with unsaved edits triggers the browser's own prompt", async ({
  page,
}) => {
  const d = dialogs(page);
  await signIn(page, ACCOUNT.coach);
  await newDraft(page);
  await edit(page, "Tab close draft");
  d.policy.next = "dismiss";
  await page.close({ runBeforeUnload: true });
  await expect
    .poll(() => d.seen.some((x) => x.type === "beforeunload"))
    .toBeTruthy();
  expect(page.isClosed()).toBe(false); // dismissed: the tab stayed open
});

test("Explicit discard: from the editor and from the recovery notice; nothing is discarded any other way", async ({
  page,
}) => {
  const d = dialogs(page);
  await signIn(page, ACCOUNT.coach);
  const id = await newDraft(page);
  await edit(page, "Throw away");
  d.policy.next = "dismiss";
  await page.getByRole("button", { name: "Discard edits" }).click();
  expect(d.seen.at(-1)?.message).toMatch(/discard your unsaved edits/i);
  await expect(titleBox(page)).toHaveValue("Throw away");
  expect(await keys(page)).toHaveLength(1);
  d.policy.next = "accept";
  await page.getByRole("button", { name: "Discard edits" }).click();
  await expect(titleBox(page)).toHaveValue("");
  await expect(indicator(page)).toHaveText("Saved draft");
  await expect.poll(() => keys(page)).toEqual([]);

  // The recovery notice: Discard local copy removes it for good.
  await edit(page, "Discard from banner");
  await page.reload(); // beforeunload accepted
  const banner = page.getByTestId("draft-recovery");
  await expect(banner).toBeVisible();
  d.policy.next = "dismiss";
  await banner.getByRole("button", { name: "Discard local copy" }).click();
  await expect(banner).toBeVisible();
  expect(await keys(page)).toHaveLength(1);
  d.policy.next = "accept";
  await banner.getByRole("button", { name: "Discard local copy" }).click();
  await expect(banner).toBeHidden();
  await expect.poll(() => keys(page)).toEqual([]);
  await page.reload();
  await expect(titleBox(page)).toBeVisible();
  await expect(page.getByTestId("draft-recovery")).toHaveCount(0);
  expect(sessionId(page)).toBe(id);
});

test("Malformed, obsolete or foreign recovery data is ignored and removed, never offered or crashing", async ({
  page,
}) => {
  const errors = watchErrors(page);
  dialogs(page);
  await signIn(page, ACCOUNT.coach);
  const id = await newDraft(page);
  const identity = await (
    await page.request.get("/api/academy/identity")
  ).json();
  const academy = (await (await page.request.get("/api/training")).json())
    .academy.id as string;
  const mine = `${STORAGE_PREFIX}.v1:${encodeURIComponent(academy)}:${encodeURIComponent(identity.userId)}:${encodeURIComponent(id)}`;
  const record = (over: Record<string, unknown>) =>
    JSON.stringify({
      v: 1,
      academyId: academy,
      userId: identity.userId,
      sessionId: id,
      baseVersion: 1,
      baseUpdatedAt: "x",
      savedAt: new Date().toISOString(),
      draft: {
        title: "Injected",
        batchId: "",
        branchId: "",
        coachId: identity.userId,
        localDate: "",
        localTime: "",
        duration: 60,
        objective: "",
        activities: [],
        adjustments: [],
      },
      ...over,
    });
  const cases: Record<string, string> = {
    "not JSON": "{{{ not json",
    "wrong format version": record({ v: 2 }),
    "missing fields": JSON.stringify({ v: 1 }),
    "oversized activity list": record({
      draft: {
        title: "x",
        batchId: "",
        branchId: "",
        coachId: "",
        localDate: "",
        localTime: "",
        duration: 60,
        objective: "",
        activities: Array.from({ length: 200 }, (_, i) => ({
          id: `a${i}`,
          drillId: null,
          drillVersion: null,
          title: "t",
          minutes: 1,
          cues: "",
        })),
        adjustments: [],
      },
    }),
    "expired (30 days old)": record({
      savedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    }),
    "claims another user": record({ userId: "someone-else" }),
    "claims another academy": record({ academyId: "academy-elsewhere" }),
    "unknown extra field": record({ token: "secret" }),
  };
  for (const [name, value] of Object.entries(cases)) {
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [mine, value]);
    await page.reload();
    await expect(titleBox(page), name).toBeVisible();
    await expect(page.getByTestId("draft-recovery"), name).toHaveCount(0);
    await expect
      .poll(() => keys(page), { message: `${name} removed` })
      .toEqual([]);
  }
  // Garbage under our prefix that belongs to no one is cleaned up as well; valid-looking foreign data is left alone.
  await page.evaluate((prefix) => {
    localStorage.setItem(`${prefix}.v0:old`, "legacy");
    localStorage.setItem(`${prefix}.v1:broken`, "{");
  }, STORAGE_PREFIX);
  await page.reload();
  await expect(titleBox(page)).toBeVisible();
  await expect.poll(() => keys(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("A stale local copy is flagged, never applied silently, and saving it is an explicit choice", async ({
  page,
}) => {
  const d = dialogs(page);
  await signIn(page, ACCOUNT.coach);
  const id = await newDraft(page);
  await edit(page, "Local edits (older)");
  // Someone else saves the session meanwhile (same mechanism the application uses: save with the current version).
  const saved = await serverSave(page, id, 1, "Newer on the server");
  expect(saved.status()).toBe(200);
  await page.reload(); // accept the unload prompt
  const banner = page.getByTestId("draft-recovery");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("saved again");
  await expect(titleBox(page)).toHaveValue("Newer on the server"); // the latest server version is what is shown
  await expect(titleBox(page)).toBeDisabled(); // nothing can be typed over the decision
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Session", exact: true }).click();

  // Declining the restore keeps everything as it is.
  d.policy.next = "dismiss";
  await banner.getByRole("button", { name: "Restore my edits anyway" }).click();
  await expect(banner).toBeVisible();
  await expect(titleBox(page)).toHaveValue("Newer on the server");

  d.policy.next = "accept";
  await banner.getByRole("button", { name: "Restore my edits anyway" }).click();
  await expect(titleBox(page)).toHaveValue("Local edits (older)");
  await expect(indicator(page)).toHaveText("Unsaved changes");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  const row = (await serverSessions(page)).find((s) => s.id === id)!;
  expect(row.data.title).toBe("Local edits (older)");
  expect(row.version).toBe(3); // the existing version counter advanced exactly once for this save

  // "Keep the saved version" is the other explicit choice.
  await edit(page, "Another local change");
  await serverSave(page, id, 3, "Server moved again");
  await page.reload();
  const again = page.getByTestId("draft-recovery");
  await expect(again).toBeVisible();
  await again.getByRole("button", { name: "Keep the saved version" }).click();
  await expect(again).toBeHidden();
  await expect.poll(() => keys(page)).toEqual([]);
  await expect(titleBox(page)).toHaveValue("Server moved again");
});

test("Conflicting saves from two tabs: the second is refused, its edits stay, and keeping them is explicit", async ({
  page,
}) => {
  const d = dialogs(page);
  await signIn(page, ACCOUNT.coach);
  const id = await newDraft(page);
  const tabB = await page.context().newPage();
  dialogs(tabB);
  await tabB.goto(`/training#${id}`);
  await expect(titleBox(tabB)).toBeVisible();

  await edit(page, "Tab A edit");
  await titleBox(tabB).fill("Tab B edit");
  await tabB.getByRole("button", { name: "Save draft" }).click();
  await expect(tabB.getByText("Draft saved.")).toBeVisible();

  await page.getByRole("button", { name: "Save draft" }).click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: /changed in another tab/i });
  await expect(alert).toBeVisible();
  await expect(titleBox(page)).toHaveValue("Tab A edit");
  await expect(indicator(page)).toHaveText("Unsaved changes");
  expect(
    (await serverSessions(page)).find((s) => s.id === id)?.data.title,
  ).toBe("Tab B edit");
  expect(await keys(page)).toHaveLength(1);

  d.policy.next = "dismiss";
  await alert
    .getByRole("button", { name: "Keep my edits on the latest version" })
    .click();
  expect(
    (await serverSessions(page)).find((s) => s.id === id)?.data.title,
  ).toBe("Tab B edit");
  d.policy.next = "accept";
  await alert
    .getByRole("button", { name: "Keep my edits on the latest version" })
    .click();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  expect(
    (await serverSessions(page)).find((s) => s.id === id)?.data.title,
  ).toBe("Tab A edit");
  await expect.poll(() => keys(page)).toEqual([]);
});

test("Copies are scoped: another user, another academy or a session the person cannot see never gets them", async ({
  page,
}) => {
  dialogs(page);
  await signIn(page, ACCOUNT.coach);
  const id = await newDraft(page);
  await edit(page, "Aman private edits");
  const amansKeys = await keys(page);
  expect(amansKeys).toHaveLength(1);

  // Same browser, same academy, a different person who can see the session (head coach).
  await switchUser(page, ACCOUNT.headCoach);
  await page.goto(`/training#${id}`);
  await expect(titleBox(page)).toBeVisible();
  await expect(page.getByTestId("draft-recovery")).toHaveCount(0);
  await expect(page.getByTestId("other-drafts")).toHaveCount(0);
  await expect(titleBox(page)).not.toHaveValue("Aman private edits");
  expect(await keys(page)).toEqual(amansKeys); // untouched, and still only Aman's to read

  // Same browser, a different academy.
  await switchUser(page, ACCOUNT.otherAcademy);
  await page.goto("/training");
  await expect(
    page.getByRole("heading", { name: "Training Studio" }),
  ).toBeVisible();
  await expect(page.getByTestId("draft-recovery")).toHaveCount(0);
  await expect(page.getByTestId("other-drafts")).toHaveCount(0);
  expect(await keys(page)).toEqual(amansKeys);

  // A copy planted under Aman's scope for a session Aman cannot see (head coach's own) is rejected and removed.
  await switchUser(page, ACCOUNT.headCoach);
  await page.goto("/training");
  const hcId = (
    await (
      await page.request.post("/api/training/sessions", {
        headers: { origin: base },
        data: {},
      })
    ).json()
  ).id as string;
  await switchUser(page, ACCOUNT.coach);
  await page.goto("/api/auth/get-session"); // any page of the app origin, so its storage is reachable
  const identity = await (
    await page.request.get("/api/academy/identity")
  ).json();
  const academy = (await (await page.request.get("/api/training")).json())
    .academy.id as string;
  const planted = `${STORAGE_PREFIX}.v1:${encodeURIComponent(academy)}:${encodeURIComponent(identity.userId)}:${encodeURIComponent(hcId)}`;
  await page.evaluate(
    ([key, user, aca, sid]) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          v: 1,
          academyId: aca,
          userId: user,
          sessionId: sid,
          baseVersion: 1,
          baseUpdatedAt: "x",
          savedAt: new Date().toISOString(),
          draft: {
            title: "Planted",
            batchId: "",
            branchId: "",
            coachId: user,
            localDate: "",
            localTime: "",
            duration: 60,
            objective: "",
            activities: [],
            adjustments: [],
          },
        }),
      ),
    [planted, identity.userId, academy, hcId],
  );
  await page.goto("/training");
  await expect(
    page.getByRole("heading", { name: "Training Studio" }),
  ).toBeVisible();
  await expect(page.getByTestId("other-drafts")).not.toContainText("Planted");
  await expect
    .poll(async () => (await keys(page)).includes(planted))
    .toBe(false);
  // and the server still refuses that session to Aman
  expect((await page.request.get(`/api/training`)).ok()).toBeTruthy();
  const refused = await serverSave(page, hcId, 1, "Not mine");
  expect([403, 404]).toContain(refused.status());

  // Aman's own copy is still there for Aman (a fresh load of the link, as opening it from elsewhere would be).
  await page.goto("about:blank");
  await page.goto(`/training#${id}`);
  await expect(page.getByTestId("draft-recovery")).toBeVisible();
});

test("Signing out removes the copies kept for that person, after asking", async ({
  page,
}) => {
  const d = dialogs(page);
  await signIn(page, ACCOUNT.coach);
  await newDraft(page);
  await edit(page, "Shared computer draft");
  expect(await keys(page)).toHaveLength(1);
  d.policy.next = "dismiss";
  await page.locator(".ax-signout").click();
  expect(d.seen.at(-1)?.message).toMatch(/Sign out\?.*removed/i);
  await expect(page).toHaveURL(/\/training/);
  expect(await keys(page)).toHaveLength(1);
  d.policy.next = "accept";
  const asked = d.seen.length;
  await page.locator(".ax-signout").click();
  await expect(page).toHaveURL(/\/login/);
  expect(d.seen.length).toBe(asked + 1); // one question; no second browser prompt on the way out
  expect(d.seen.some((x) => x.type === "beforeunload")).toBe(false);
  expect(await keys(page)).toEqual([]);
});
