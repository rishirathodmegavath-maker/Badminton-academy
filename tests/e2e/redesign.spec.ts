import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { loginContext } from "./support/roles";
const base = process.env.BETTER_AUTH_URL!;
async function nav(page: Page, name: string) {
  // At 1050px and below the sidebar is a drawer that must be opened first, as a person would.
  const opener = page.getByRole("button", { name: "Open navigation" });
  if (await opener.isVisible()) await opener.click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", {
      name: name === "Video & AI Analysis" ? /Video & AI Analysis/ : name,
      exact: name !== "Video & AI Analysis",
    })
    .click();
  await expect(page.locator(".academy-module .reference-view")).toBeVisible();
}
test("redesigned operational panels persist records, preview recipients and review timestamp notes", async ({
  page,
}) => {
  test.setTimeout(360000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The owner's session comes from the shared cache (support/roles.ts): sign-in allows 5 attempts a minute per client address and
  // that limit is not weakened for tests.
  await loginContext(page.context(), "OWNER");
  async function post(path: string, data: unknown) {
    const r = await page.request.post("/api/academy" + path, {
      headers: { origin: base },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  }
  const d = await (
    await page.request.get("/api/academy", { timeout: 60000 })
  ).json();
  // The seed has one completed session, attended by the first junior player, whom the Reports view also opens first.
  const player =
    d.players.find((p: { id: string }) => p.id === "academy-green-junior-p1") ??
    d.players[0];
  const unique = Date.now();
  const report = await post("/reports/create", {
    playerId: player.id,
    periodStart: "2026-01-01",
    periodEnd: "2035-12-31",
    title: `QA progress review ${unique}`,
  });
  await post("/nutrition/plan", {
    playerId: player.id,
    title: `QA structured guidance ${unique}`,
    guidance: "QA original human-authored guidance for professional review.",
    sections: {
      beforeTraining: "QA preparation section; awaiting professional review.",
      afterTraining: "QA recovery section; awaiting professional review.",
      dailyMeals: "QA meal section; awaiting professional review.",
      hydration: "QA hydration section; awaiting professional review.",
      trainingDay: "QA training-day section; awaiting professional review.",
    },
    action: "save",
    reviewNote: "",
  });
  const invoice = await post("/fees/invoice", {
    id: crypto.randomUUID(),
    playerIds: [player.id],
    familyUserId: null,
    planId: null,
    description: `QA local academy fee ${unique}`,
    subtotal: 120000,
    discount: 20000,
    currency: "INR",
    dueDate: "2028-01-31",
  });
  await page.goto("/training");
  await expect(page.locator(".drill-card").first()).toBeVisible();
  await nav(page, "Reports");
  // The monthly report studio: the numbered workflow on the left, the live report preview on the right.
  await expect(page.locator(".report-studio")).toBeVisible();
  await expect(page.locator(".report-studio .rs-step")).toHaveCount(4);
  await expect(page.locator(".rs-sheet")).toBeVisible();
  // Open the draft this test created. Which report the studio shows first depends on what else exists (a published or approved
  // report is read-only), so the test chooses its own instead of relying on the order.
  await page.getByLabel("Player", { exact: true }).selectOption(player.id);
  await page.getByLabel("Reporting month").selectOption(report.id);
  // The text is unique to this run: a fixed sentence saved by an earlier run would already equal the draft, nothing would be
  // "unsaved", and Save draft would (correctly) stay disabled.
  const summary = `QA saved coach summary ${unique}, no inferred performance.`;
  await page.getByLabel("Coach report summary").fill(summary);
  await expect(page.locator(".rs-sheet")).toContainText(summary);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Changes saved." }),
  ).toBeVisible();
  await nav(page, "Nutrition");
  await expect(
    page.getByText(
      "QA original human-authored guidance for professional review.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hydration", exact: true }).click();
  await expect(
    page.getByText("QA hydration section; awaiting professional review.", {
      exact: true,
    }),
  ).toBeVisible();
  await nav(page, "Fees");
  await page
    .getByLabel("Search invoices")
    .fill(`QA local academy fee ${unique}`);
  await page
    .getByRole("button", { name: `Select invoice ${invoice.data.number}` })
    .click();
  await expect(page.locator(".invoice-account")).toContainText("₹1,000");
  await expect(
    page.getByRole("heading", { name: "Payment verification", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Lesson credits", exact: true }),
  ).toBeVisible();
  await nav(page, "Communications");
  await page
    .getByLabel("Subject", { exact: true })
    .fill(`QA announcement ${unique}`);
  await page
    .getByLabel("Message", { exact: true })
    .fill("QA private draft only. No delivery is requested.");
  // The composer offers "All families" or a chosen audience; choosing one player lists that player's parents to pick from.
  await page
    .getByRole("radio", { name: /Only the batches \/ players I choose/ })
    .check();
  await page.getByLabel(/Players.+ parents/).selectOption([player.id]);
  // There is no preview button: the page checks the audience itself and says who would receive the message.
  await expect(
    page.getByRole("heading", { name: /^\d+ famil(y|ies) will receive this$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("");
  await expect(
    page
      .locator(".ops-table")
      .getByText(`QA announcement ${unique}`, { exact: true }),
  ).toBeVisible();
  // Video is not offered in the menu (UX-D8) but its address and its access rule are unchanged.
  await page.goto(`${base}/video`);
  await expect(page.locator(".academy-module .reference-view")).toBeVisible();
  await page.getByRole("button", { name: "Upload private media" }).click();
  const bytes = await readFile("tests/fixtures/qa-playback.webm");
  expect(bytes.length).toBeGreaterThan(500);
  await page.getByLabel("Private media file").setInputFiles({
    name: `qa-playback-${unique}.webm`,
    mimeType: "video/webm",
    buffer: Buffer.from(bytes),
  });
  await page
    .getByRole("button", { name: "Upload private file", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Changes saved." }),
  ).toBeVisible();
  await page
    .getByLabel("Choose media")
    .selectOption({ label: `qa-playback-${unique}.webm · ${player.name}` });
  const video = page.locator("video");
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(1);
  await video.evaluate((v) => (v as HTMLVideoElement).play());
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.2);
  await video.evaluate((v) => (v as HTMLVideoElement).pause());
  await page.getByLabel("Timestamp seconds").fill("0.5");
  await page
    .getByLabel("Timestamp feedback")
    .fill("QA timestamp evidence from actual local test video.");
  await page
    .getByRole("button", { name: "Add timestamp note", exact: true })
    .click();
  await expect(
    page.getByText("QA timestamp evidence from actual local test video.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Coach media feedback")
    .fill("QA manually reviewed playback and timestamp note.");
  await page.getByRole("button", { name: "Save private feedback" }).click();
  await expect(page.getByText("AI ANALYSISCOMING SOON")).toBeVisible();
  expect(errors).toEqual([]);
});

test("admissions and settings forms persist, and player links open the correct Training view", async ({
  page,
}) => {
  await loginContext(page.context(), "OWNER");
  await page.goto("/training");
  await expect(page.locator(".drill-card").first()).toBeVisible();
  await nav(page, "Players");
  await page
    .locator(".wb-roster-item")
    .filter({ hasText: "Meera Kapoor" })
    .click();
  await page.getByRole("button", { name: "Open player development" }).click();
  await expect(
    page.getByRole("heading", { name: "Keep the player in focus." }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Player", exact: true }),
  ).toHaveValue("academy-green-junior-p4");
  await nav(page, "Overview");
  await page
    .getByRole("button", { name: "Create session", exact: false })
    .click();
  await expect(page.getByLabel("Session title", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Session title", { exact: true })).toHaveValue(
    "",
  );
  await nav(page, "Admissions");
  await page.getByRole("button", { name: "Add enquiry", exact: false }).click();
  const name = `QA enquiry ${Date.now()}`;
  await page.getByLabel("Player / prospect name").fill(name);
  await page.getByLabel("Enquiry source", { exact: true }).fill("Local QA");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByLabel("Search enquiries").fill(name);
  await page.locator(".wb-roster-item").filter({ hasText: name }).click();
  await page
    .getByRole("button", { name: "Notes & feedback", exact: true })
    .click();
  await page
    .getByLabel("Private follow-up notes")
    .fill("QA follow-up note preserved after saving.");
  await page.getByRole("button", { name: "Save follow-up & feedback" }).click();
  // Saving reloads the enquiry and the panel returns to its Details tab. Wait for that (the button only the Details tab has)
  // before opening the notes again, or the reload resets the tab that was just opened.
  await expect(page.getByRole("button", { name: "Update follow-up & trial feedback →" })).toBeVisible();
  await page
    .getByRole("button", { name: "Notes & feedback", exact: true })
    .click();
  await expect(page.getByLabel("Private follow-up notes")).toHaveValue(
    "QA follow-up note preserved after saving.",
  );
  await nav(page, "Settings");
  const academyName = await page
    .getByLabel("Academy name", { exact: true })
    .inputValue();
  await page.getByLabel("Country defaults", { exact: true }).selectOption("US");
  await expect(page.getByLabel("Currency", { exact: true })).toHaveValue("USD");
  await expect(
    page.getByLabel("Academy timezone", { exact: true }),
  ).toHaveValue("America/New_York");
  await page.getByLabel("Country defaults", { exact: true }).selectOption("IN");
  await page.getByRole("button", { name: "Save academy settings" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Changes saved." }),
  ).toBeVisible();
  expect(
    (await (await page.request.get("/api/academy", { timeout: 60000 })).json())
      .academy.name,
  ).toBe(academyName);
  await page.setViewportSize({ width: 820, height: 1180 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await nav(page, "Calendar");
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
