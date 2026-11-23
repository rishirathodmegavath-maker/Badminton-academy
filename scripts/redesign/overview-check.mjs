import { chromium, expect as baseExpect } from "@playwright/test";
import fs from "node:fs";
const expect = baseExpect.configure({ timeout: 60000 });
process.loadEnvFile(".env.local");
const base = "http://127.0.0.1:3100";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const out = "artifacts/overview";
fs.mkdirSync(out, { recursive: true });
const results = [];
async function login(email) {
  const context = await browser.newContext({
    viewport: { width: 1672, height: 941 },
  });
  const res = await context.request.post(base + "/api/auth/sign-in/email", {
    headers: { origin: base },
    data: { email, password: process.env.DEV_SEED_PASSWORD },
    timeout: 120000,
  });
  if (!res.ok()) throw Error("Sign in " + res.status());
  return context;
}
try {
  const context = await login("admin@greenfield.example");
  const post = async (path, data) => {
    const r = await context.request.post(base + path, {
      headers: { origin: base },
      data,
      timeout: 120000,
    });
    if (!r.ok()) throw Error(await r.text());
    return r.json();
  };
  let initial = await (
    await context.request.get(base + "/api/academy", { timeout: 120000 })
  ).json();
  if (
    process.argv.includes("--with-qa-session") &&
    !initial.sessions.some(
      (s) =>
        s.data.title === "QA overview layout · local draft" &&
        s.data.localDate === initial.currentDate,
    )
  ) {
    const draft = await post("/api/training/sessions", {});
    const batch = initial.batches[0];
    await post("/api/training/sessions/" + draft.id, {
      version: draft.version,
      action: "save",
      payload: {
        ...draft.data,
        title: "QA overview layout · local draft",
        branchId: batch.branchId,
        batchId: batch.id,
        coachId: batch.coachId,
        localDate: initial.currentDate,
        localTime: "17:00",
        duration: 60,
      },
    });
  }
  const data = await (
    await context.request.get(base + "/api/academy", { timeout: 120000 })
  ).json();
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base, { timeout: 120000 });
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name, exact: true })
      .click();
  await nav("Overview");
  await page.locator(".ov-dashboard").waitFor();
  await expect(page.locator(".ov-metric").nth(0)).toContainText(
    String(data.players.filter((p) => p.profile.status === "ACTIVE").length),
  );
  await expect(page.locator(".ov-metric").nth(1)).toContainText(
    String(
      data.sessions.filter(
        (s) =>
          s.data.localDate === data.currentDate && s.status !== "CANCELLED",
      ).length,
    ),
  );
  for (const width of [1672, 768, 375]) {
    await page.setViewportSize({ width, height: width === 1672 ? 941 : 1000 });
    await page.screenshot({
      path: `${out}/overview-${width}.png`,
      fullPage: true,
    });
    const size = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    if (size.scroll > size.width)
      throw Error("Overflow " + JSON.stringify(size));
    results.push({ viewport: width, overflow: false });
  }
  await page.setViewportSize({ width: 1672, height: 941 });
  if (await page.locator(".ov-training-row").count()) {
    await page.locator(".ov-training-row").first().click();
    await expect(
      page.getByRole("heading", { name: "Training Studio", exact: true }),
    ).toBeVisible();
    await nav("Overview");
  }
  await page.setViewportSize({ width: 375, height: 1000 });
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close navigation" }).click();
  await page.setViewportSize({ width: 1672, height: 941 });
  for (const b of data.branches) {
    await page.getByLabel("Overview branch").selectOption(b.id);
    const expected = data.sessions.filter(
      (s) =>
        s.data.localDate === data.currentDate &&
        s.status !== "CANCELLED" &&
        s.data.branchId === b.id,
    ).length;
    await expect(page.locator(".ov-metric").nth(1)).toContainText(
      String(expected),
    );
  }
  await page.getByLabel("Overview branch").selectOption("");
  await page.locator(".ov-metric").nth(0).click();
  await expect(page.getByLabel("Player status filter")).toHaveValue("ACTIVE");
  await nav("Overview");
  await page.locator(".ov-metric").nth(1).click();
  await expect(page.getByLabel("Calendar date", { exact: true })).toHaveValue(
    data.currentDate,
  );
  await nav("Overview");
  await page.locator(".ov-metric").nth(2).click();
  await expect(page.getByLabel("Outstanding only")).toBeChecked();
  await nav("Overview");
  await page.locator(".ov-metric").nth(3).click();
  await expect(page.getByLabel("Awaiting review only")).toBeChecked();
  await nav("Overview");
  await page.getByRole("button", { name: "View trials", exact: true }).click();
  await expect(page.locator(".tabs button.active")).toContainText("follow-up");
  await nav("Overview");
  await page
    .getByRole("button", { name: "Review payments", exact: true })
    .click();
  await expect(page.getByLabel("Awaiting verification only")).toBeChecked();
  await nav("Overview");
  await page
    .getByRole("button", { name: "Create session", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Training Studio", exact: true }),
  ).toBeVisible();
  await nav("Overview");
  results.push({
    interactions:
      "summary cards, branch filtering, follow-ups, payment verification filter and Create session passed",
    errors,
  });
  if (errors.length) throw Error(errors.join("\n"));
  await context.close();
  const coach = await login("aman@greenfield.example");
  const cd = await (
    await coach.request.get(base + "/api/academy", { timeout: 120000 })
  ).json();
  if (cd.permissions.finance || cd.invoices.length || cd.payments.length)
    throw Error("Coach finance leak");
  if (cd.sessions.some((s) => s.coachId !== cd.actor.id))
    throw Error("Coach session leak");
  if (
    cd.players.some(
      (p) =>
        !cd.batches.some(
          (b) => b.id === p.batchId && b.coachId === cd.actor.id,
        ),
    )
  )
    throw Error("Coach roster leak");
  const cp = await coach.newPage();
  cp.setDefaultTimeout(60000);
  await cp.goto(base);
  await cp
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await expect(cp.locator(".ov-metric").nth(2)).toBeDisabled();
  await expect(cp.locator(".ov-metric").nth(2)).toContainText("Restricted");
  await expect(cp.locator('.ov-metric').nth(3)).toBeDisabled();
  await coach.close();
  results.push({ coach: "assigned sessions/players only; finance restricted" });
  const other = await login('maya@bluebird.example');
  const od = await (await other.request.get(base+'/api/academy',{timeout:120000})).json();
  if(od.actor.academyId===data.actor.academyId || od.players.some(p=>data.players.some(pl=>pl.id===p.id)) || od.sessions.some(s=>data.sessions.some(original=>original.id===s.id))) throw Error('Academy isolation failed');
  const messageId=data.messages[0]?.id;
  if(messageId && od.messages.some(m=>m.id===messageId))throw Error('Cross academy message activity leak');
  await other.close();results.push({isolation:'Different academy has separate players, sessions and communications'});
  fs.writeFileSync(out + "/checks.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
