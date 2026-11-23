import { expect, type Page } from "@playwright/test";

/**
 * Chooses a batch and a month on the Batch reports screen, one change at a time.
 *
 * The screen reloads its rows for every change of batch or month, and a response for an earlier choice that arrives after the
 * response for the later one replaces it: the rows then no longer match the current choice and the section stays on "Loading…"
 * (batch-reports.tsx keeps the rows with the choice they were loaded for). A person changing both controls within a few
 * milliseconds can hit that; a test must not, so each change waits for its own rows before the next one is made. This waits on
 * the screen (the loading line going away), never for a fixed time.
 */
export async function chooseBatchAndMonth(page: Page, batchLabel: string, month: string) {
  const loading = page.getByRole("status").filter({ hasText: "Loading…" });
  await expect(loading, "the first rows of the screen").toHaveCount(0, { timeout: 90_000 });
  await page.getByLabel("Batch", { exact: true }).selectOption({ label: batchLabel });
  await expect(loading, `rows of ${batchLabel}`).toHaveCount(0, { timeout: 90_000 });
  await page.getByLabel("Month", { exact: true }).fill(month);
  await expect(loading, `rows of ${month}`).toHaveCount(0, { timeout: 90_000 });
}
