import { chromium } from "@playwright/test";
import fs from "node:fs";
process.loadEnvFile(".env.local");
const baseline = process.argv.includes("--baseline");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  const response = await context.request.post(
    "http://127.0.0.1:3100/api/auth/sign-in/email",
    {
      headers: { origin: "http://127.0.0.1:3100" },
      data: {
        email: "admin@greenfield.example",
        password: process.env.DEV_SEED_PASSWORD,
      },
      timeout: 60000,
    },
  );
  if (!response.ok()) throw Error(await response.text());
  const data = await (
    await context.request.get("http://127.0.0.1:3100/api/academy", {
      timeout: 60000,
    })
  ).json();
  const draft = data.sessions
    .filter((s) => s.status === "DRAFT" && s.data.activities.length)
    .sort((a, b) => b.data.activities.length - a.data.activities.length)[0];
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    "http://127.0.0.1:3100/" +
      (baseline ? "redesign-baseline" : "") +
      (draft ? "#" + draft.id : ""),
  );
  await page.locator(".drill-card").first().waitFor();
  const results = [];
  for (const name of [
    "Overview",
    "Admissions",
    "Players",
    "Calendar",
    "Training",
    "Reports",
    "Nutrition",
    "Video & AI Analysis",
    "Fees",
    "Communications",
    "Settings",
  ]) {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", {
        name: name === "Video & AI Analysis" ? /Video & AI Analysis/ : name,
        exact: name !== "Video & AI Analysis",
      })
      .click();
    if (name !== "Training")
      await page
        .locator(
          baseline ? ".academy-module" : ".academy-module .reference-view",
        )
        .waitFor();
    else await page.locator(".drill-card").first().waitFor();
    if (name === "Calendar" && !baseline) {
      const session = data.sessions.find(
        (s) => s.data.localDate && s.data.activities.length,
      );
      if (session)
        await page
          .getByLabel("Calendar date", { exact: true })
          .fill(session.data.localDate);
    }
    if (name === "Video & AI Analysis" && !baseline) {
      const media = data.media.find(
        (m) => m.mime.startsWith("video/") && m.size > 500,
      );
      if (media) {
        await page.getByLabel("Choose media").selectOption(media.id);
        await page.locator("video").waitFor();
        await page.waitForFunction(() => {
          const v = document.querySelector("video");
          return v && v.readyState >= 2;
        });
        await page.locator("video").evaluate(async (v) => {
          await v.play();
        });
        await page.waitForFunction(
          () => document.querySelector("video").currentTime > 0.2,
        );
        await page.locator("video").evaluate((v) => v.pause());
      }
    }
    if (baseline) {
      await page.evaluate(() => {
        for (const sheet of document.styleSheets) {
          try {
            if (
              [...sheet.cssRules].some((rule) =>
                rule.cssText.includes(".wb-pane"),
              )
            )
              sheet.disabled = true;
          } catch {}
        }
      });
      await page.addStyleTag({
        content:
          fs.readFileSync(
            "exports/Sportozen-UI-20261026-164745/src/app/globals.css",
            "utf8",
          ) +
          "\n" +
          fs.readFileSync(
            "exports/Sportozen-UI-20261026-164745/src/app/operations.css",
            "utf8",
          ),
      });
    }
    await page.addStyleTag({ content: "nextjs-portal{display:none}" });
    await page.evaluate(() => document.fonts.ready);
    const slug = name.replaceAll(/[^a-zA-Z]/g, "-").toLowerCase();
    await page.screenshot({
      path: `artifacts/redesign/${baseline ? "before" : "after"}/${slug}-desktop.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `artifacts/redesign/${baseline ? "before" : "after"}/${slug}-mobile.png`,
      fullPage: true,
      animations: "disabled",
    });
    results.push({
      name,
      overflow: await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    });
  }
  fs.writeFileSync(
    `artifacts/redesign/${baseline ? "before" : "after"}/checks.json`,
    JSON.stringify(
      {
        source: baseline
          ? "Pre-redesign UI export rendered against current authorised local records"
          : "Current redesigned UI",
        results,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ results, errors }));
} finally {
  await browser.close();
}
