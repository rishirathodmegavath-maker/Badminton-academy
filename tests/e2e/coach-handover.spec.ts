import { test, expect, type APIRequestContext, type Browser } from "@playwright/test";
import { ROLE_ACCOUNTS, stateFor, type RoleKey } from "./support/roles";

/**
 * Stage 5D in the browser: the owner switches off a coach who still coaches a batch. Without a
 * replacement the dialog shows the refusal and nothing changes; with one, the batch moves to the
 * replacement and the coach's access ends.
 * Creates records (a coach login and a batch), so it runs ONLY under playwright.isolated.config.ts
 * (E2E_DISPOSABLE=true, loopback, never port 3100). Under any other configuration it is skipped.
 */
const base = process.env.E2E_BASE_URL ?? "";
const disposable =
  process.env.E2E_DISPOSABLE === "true" &&
  /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(base) &&
  new URL(base || "http://x").port !== "3100";
test.skip(!disposable, "needs a disposable instance (E2E_DISPOSABLE=true, E2E_BASE_URL, not port 3100)");

/**
 * A context signed in as the role account with this address. Sessions come from the cache in support/roles.ts: the sign-in
 * endpoint allows 5 attempts a minute per client address (one shared bucket on a server with no trusted proxy) and that limit
 * is not weakened for tests, so the suite signs each role in once and reuses it (waiting out a 429 where it happens).
 */
async function signedIn(browser: Browser, email: string) {
  const role = (Object.keys(ROLE_ACCOUNTS) as RoleKey[]).find((r) => ROLE_ACCOUNTS[r] === email);
  if (!role) throw new Error(`No role account for ${email}`);
  return browser.newContext({ baseURL: base, storageState: await stateFor(role) });
}
const post = (api: APIRequestContext, path: string, data: unknown) =>
  api.post("/api/academy" + path, { headers: { origin: base }, data, timeout: 60_000 });
type Workspace = {
  branches: { id: string }[];
  batches: { id: string; coachId: string }[];
  members: { id: string; email: string; active: boolean; role: string }[];
};

test("switching off a coach who still coaches a batch needs a replacement, and the batch moves to them", async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await signedIn(browser, "admin@greenfield.example");
  const workspace = async () => (await (await owner.request.get("/api/academy", { timeout: 60_000 })).json()) as Workspace;
  const start = await workspace();
  const replacement = start.members.find((m) => m.email === "headcoach@greenfield.example" && m.active);
  expect(replacement, "seeded head coach").toBeTruthy();
  const stamp = Date.now();
  const name = `E2E Coach ${stamp}`;
  const created = await post(owner.request, "/settings/member", {
    name,
    email: `e2e-coach-${stamp}@greenfield.example`,
    role: "COACH",
    active: true,
    professionalAttestation: "",
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const coachId = (await created.json()).id as string;
  const batchName = `E2E handover batch ${stamp}`;
  const batch = await post(owner.request, "/settings/batch", { name: batchName, branchId: start.branches[0].id, coachId });
  expect(batch.ok(), await batch.text()).toBeTruthy();
  const batchId = (await batch.json()).id as string;

  const page = await owner.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/settings", { timeout: 120_000 });
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await page.getByLabel("Search records").fill(name);
  await page.getByRole("button", { name: "Manage access" }).click();
  await expect(page.getByRole("heading", { name: "Update academy access" })).toBeVisible();
  await page.getByLabel("Academy access is active").uncheck();
  // No replacement chosen: refused, the dialog stays open, nothing changed.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // The refusal is shown in the dialog (and in the page's own alert banner).
  await expect(
    page.getByRole("dialog", { name: "Update academy access" }).getByRole("alert"),
  ).toContainText("Choose an active replacement coach");
  let now = await workspace();
  expect(now.members.find((m) => m.id === coachId)?.active).toBe(true);
  expect(now.batches.find((b) => b.id === batchId)?.coachId).toBe(coachId);
  // With a replacement: the batch moves and the access ends, in one save.
  await page.getByLabel("Replacement coach (when removing coaching access)").selectOption(replacement!.id);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Update academy access" })).toBeHidden();
  now = await workspace();
  expect(now.members.find((m) => m.id === coachId)?.active).toBe(false);
  expect(now.batches.find((b) => b.id === batchId)?.coachId).toBe(replacement!.id);
  expect(errors, errors.join("\n")).toEqual([]);
  await owner.close();
});
