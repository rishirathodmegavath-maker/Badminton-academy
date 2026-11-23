import { test, expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
const password = process.env.DEV_SEED_PASSWORD!;
const base = process.env.BETTER_AUTH_URL!;
async function apiSignIn(request: APIRequestContext, email: string) {
  const signIn = () =>
    request.post("/api/auth/sign-in/email", {
      headers: { origin: base },
      data: { email, password },
    });
  let res = await signIn();
  // Repeated local test runs share the real persisted sign-in limiter. Respect it.
  if (res.status() === 429) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    res = await signIn();
  }
  expect(res.ok(), await res.text()).toBeTruthy();
}
test("coach discovers, saves, publishes, runs and completes a persistent session", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/login");
  await page.getByLabel("Email address").fill("aman@greenfield.example");
  await page.getByLabel("Password", { exact: true }).fill(password);
  const signIn = async () => {
    const [response] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/api/auth/sign-in/email"),
      ),
      page.getByRole("button", { name: "Sign in", exact: true }).click(),
    ]);
    return response;
  };
  if ((await signIn()).status() === 429) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    expect((await signIn()).ok()).toBeTruthy();
  }
  await expect(
    page.getByRole("heading", { name: "Training Studio", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".drill-card")).toHaveCount(50);
  await page.getByLabel("Search drills").fill("Clear-to-clear");
  await expect(page.locator(".drill-card")).toHaveCount(1);
  await page.getByRole("button", { name: "View drill", exact: true }).click();
  await expect(
    page.getByText("Illustration · Demonstration not available", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".drill-preview")).toBeVisible();
  // Drill details fill the box; "Back to drills" returns to the list, where the drill is added.
  await page.getByRole("button", { name: "Back to drills", exact: true }).click();
  await page
    .locator(".drill-card")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  // Adding keeps the list open; the "Your session" bar shows the count and opens the builder.
  await expect(page.getByRole("region", { name: "Your session" })).toContainText("1 drill added");
  await page.getByRole("button", { name: "Open session", exact: true }).click();
  await expect(page.getByLabel("Session title", { exact: true })).toBeVisible();
  await page
    .getByLabel("Session title", { exact: true })
    .fill("Recovery foundations");
  const title = await page
    .getByLabel("Session title", { exact: true })
    .inputValue();
  await page
    .getByRole("combobox", { name: "Batch", exact: true })
    .selectOption({ label: "Junior Foundations" });
  const records = await (await page.request.get("/api/academy")).json();
  const usedDates = new Set([
    ...records.sessions.map(
      (s: { data: { localDate: string } }) => s.data.localDate,
    ),
    ...records.events.map(
      (e: { data: { localDate: string } }) => e.data.localDate,
    ),
  ]);
  const availableDate = Array.from({ length: 366 }, (_, i) =>
    new Date(Date.UTC(2030, 0, 1 + i)).toISOString().slice(0, 10),
  ).find((date) => !usedDates.has(date))!;
  await page.getByLabel("Local date", { exact: true }).fill(availableDate);
  await page.getByLabel("Local time", { exact: true }).fill("17:00");
  await page
    .getByLabel("Session objective", { exact: true })
    .fill("Consistent clears with balanced recovery.");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Draft saved." }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Session title", { exact: true })).toHaveValue(
    title,
  );
  await expect(page.getByLabel("Clear-to-clear, standing then moving minutes")).toHaveValue("12");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Activity minutes must match" }),
  ).toContainText("Activity minutes must match");
  await page.getByText("Session details & schedule", { exact: true }).click();
  await page.getByLabel("Duration (min)", { exact: true }).fill("12");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start session", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Mark attendance", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mark unmarked players present" })
    .click();
  await page.getByLabel("Attendance for Diya Sharma").selectOption("EXCUSED");
  await page
    .getByRole("button", { name: "Save attendance", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Add observation", exact: false })
    .click();
  await page
    .getByLabel("Observation & conditions")
    .fill("Recovered with balance during controlled high feeds.");
  await page.getByRole("button", { name: "Save private observation" }).click();
  await expect(
    page.getByText("Recovered with balance during controlled high feeds.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "artifacts/training-live-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Finish session", exact: true })
    .click();
  await page
    .getByLabel("Actual outcome for Clear-to-clear, standing then moving")
    .selectOption("MODIFIED");
  await page
    .getByLabel("Coach recap (optional)")
    .fill("Used slower feeds to focus on balance.");
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Complete session", exact: true })
    .click();
  await expect(
    page.getByText("Session recorded", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Actual: modified", { exact: true }),
  ).toBeVisible();
  const originalId = page.url().split("#")[1];
  await page.getByRole("button", { name: "Duplicate", exact: true }).click();
  await page.getByLabel("New local date").fill("2026-10-23");
  await page.getByRole("button", { name: "Create draft copy" }).click();
  await expect(page.getByLabel("Session title", { exact: true })).toHaveValue(
    `${title} (copy)`,
  );
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.getByLabel("Search drills").fill("");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "artifacts/training-library-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close navigation" }).click();
  await page.screenshot({
    path: "artifacts/training-library-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  const result = await page.request.get("/api/training");
  const bootstrap = await result.json();
  const original = bootstrap.sessions.find(
    (s: { id: string }) => s.id === originalId,
  );
  expect(original.status).toBe("COMPLETED");
  expect(original.data.roster).toHaveLength(6);
  expect(
    original.data.attendance[
      original.data.roster.find(
        (p: { name: string }) => p.name === "Diya Sharma",
      ).id
    ],
  ).toBe("EXCUSED");
  const copy = bootstrap.sessions.find(
    (s: { id: string }) => s.id === page.url().split("#")[1],
  );
  expect(copy.data.observations).toEqual([]);
  expect(copy.data.attendance).toEqual({});
  expect(copy.data.actuals).toEqual({});
  expect(errors).toEqual([]);
});
test("authentication, tenant scope, nonmember and request-origin checks", async ({
  playwright,
}) => {
  const anonymous = await playwright.request.newContext({ baseURL: base });
  expect((await anonymous.get("/api/training")).status()).toBe(401);
  const green = await playwright.request.newContext({ baseURL: base });
  await apiSignIn(green, "aman@greenfield.example");
  expect(
    (
      await green.post("/api/training/sessions", {
        headers: { origin: base },
        data: {},
      })
    ).ok(),
  ).toBeTruthy();
  const sessions = (await (await green.get("/api/training")).json()).sessions;
  expect(sessions.length).toBeGreaterThan(0);
  const blue = await playwright.request.newContext({ baseURL: base });
  await apiSignIn(blue, "maya@bluebird.example");
  const blueData = await (await blue.get("/api/training")).json();
  expect(blueData.academy.id).toBe("academy-blue");
  expect(
    blueData.sessions.some((s: { id: string }) => s.id === sessions[0].id),
  ).toBeFalsy();
  const forbidden = await blue.post(
    `/api/training/sessions/${sessions[0].id}`,
    {
      headers: { origin: base },
      data: { version: sessions[0].version, action: "start" },
    },
  );
  expect(forbidden.status()).toBe(404);
  const nonmember = await playwright.request.newContext({ baseURL: base });
  await apiSignIn(nonmember, "unassigned@example.test");
  expect((await nonmember.get("/api/training")).status()).toBe(403);
  expect(
    (
      await green.post("/api/training/sessions", {
        headers: { origin: "https://untrusted.example" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  for (const context of [anonymous, green, blue, nonmember])
    await context.dispose();
});
