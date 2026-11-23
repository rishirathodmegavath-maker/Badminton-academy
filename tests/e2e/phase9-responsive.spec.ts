import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { base, stateFor, type RoleKey } from "./support/roles";

/**
 * Phase 9 responsive checks: at each required width every module opens, the page never scrolls sideways, and
 * (on touch-sized widths) controls in the shell meet the 44px touch target. Screenshots are the visual evidence
 * (set SHOT_DIR to keep them).
 */
const VIEWPORTS = [
  { name: "1536", width: 1536, height: 960 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1050", width: 1050, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
  { name: "375", width: 375, height: 812 },
];
const MODULES = ["overview", "admissions", "players", "calendar", "training", "reports", "nutrition", "video", "fees", "communications", "settings"];
const SHOT_DIR = process.env.SHOT_DIR;
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

async function overflow(page: import("@playwright/test").Page) {
  return page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
    // widest element that pokes out of the viewport, to make a failure actionable
    culprit: (() => {
      let worst: { tag: string; cls: string; right: number } | null = null;
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth + 1 && r.width > 0 && getComputedStyle(el).position !== "fixed") {
          // ignore anything inside a horizontally scrollable region
          let p: HTMLElement | null = el.parentElement;
          let scrollable = false;
          while (p && p !== document.body) {
            const o = getComputedStyle(p).overflowX;
            if (o === "auto" || o === "scroll" || o === "hidden") scrollable = true;
            p = p.parentElement;
          }
          if (!scrollable && (!worst || r.right > worst.right)) worst = { tag: el.tagName, cls: el.className.toString().slice(0, 60), right: Math.round(r.right) };
        }
      }
      return worst;
    })(),
  }));
}

for (const vp of VIEWPORTS) {
  test(`Owner: every module fits at ${vp.name}px with no sideways scroll`, async ({ browser }) => {
    test.setTimeout(600_000);
    const context = await browser.newContext({ storageState: await stateFor("OWNER"), viewport: { width: vp.width, height: vp.height }, baseURL: base() });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const failures: string[] = [];
    for (const slug of MODULES) {
      await page.goto(`/${slug}`);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 90_000 });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const o = await overflow(page);
      if (o.scroll > o.inner + 1) failures.push(`${slug}: scrollWidth ${o.scroll} > ${o.inner} (${o.culprit ? `${o.culprit.tag}.${o.culprit.cls} right=${o.culprit.right}` : "unknown"})`);
      if (SHOT_DIR && ["overview", "players", "calendar", "training", "settings"].includes(slug))
        await page.screenshot({ path: join(SHOT_DIR, `owner-${slug}-${vp.name}.png`), fullPage: false });
    }
    expect(failures, failures.join("\n")).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  });
}

for (const [role, slugs] of [
  ["COACH", ["overview", "training"]],
  ["FINANCE", ["overview", "fees"]],
  ["NUTRITION_PRO", ["overview", "nutrition"]],
  ["HEAD_COACH", ["overview"]],
] as [RoleKey, string[]][]) {
  test(`${role}: role homes fit at 390px and 1440px`, async ({ browser }) => {
    test.setTimeout(300_000);
    for (const vp of [VIEWPORTS[1], VIEWPORTS[4]]) {
      const context = await browser.newContext({ storageState: await stateFor(role), viewport: { width: vp.width, height: vp.height }, baseURL: base() });
      const page = await context.newPage();
      for (const slug of slugs) {
        await page.goto(`/${slug}`);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 90_000 });
        await page.waitForLoadState("networkidle").catch(() => undefined);
        const o = await overflow(page);
        expect(o.scroll, `${role} ${slug} at ${vp.name}: ${JSON.stringify(o.culprit)}`).toBeLessThanOrEqual(o.inner + 1);
        if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, `${role.toLowerCase()}-${slug}-${vp.name}.png`) });
      }
      await context.close();
    }
  });
}

test("Family portal fits at 390, 768 and 1440; touch targets in the shell are at least 44px", async ({ browser }) => {
  test.setTimeout(300_000);
  for (const vp of [VIEWPORTS[4], VIEWPORTS[3], VIEWPORTS[1]]) {
    const context = await browser.newContext({ storageState: await stateFor("GUARDIAN"), viewport: { width: vp.width, height: vp.height }, baseURL: base(), hasTouch: vp.width < 800 });
    const page = await context.newPage();
    await page.goto("/family");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 90_000 });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const o = await overflow(page);
    expect(o.scroll, `family at ${vp.name}: ${JSON.stringify(o.culprit)}`).toBeLessThanOrEqual(o.inner + 1);
    if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, `family-home-${vp.name}.png`) });
    if (vp.width < 800) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("#ax-sidebar a, #ax-sidebar button")]
          .map((e) => ({ name: (e.innerText || e.getAttribute("aria-label") || "").trim().slice(0, 30), h: Math.round(e.getBoundingClientRect().height) }))
          .filter((e) => e.h < 44),
      );
      expect(small).toEqual([]);
      // The drawer slides in over 0.2s; wait for it to settle so the picture shows the final state.
      await page.waitForTimeout(500);
      if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, `family-drawer-${vp.name}.png`) });
    }
    await context.close();
  }
});
