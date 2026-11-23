import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CategoryKey, RetentionAction } from "../domain";
/**
 * The erasure ledger: an append-only file, OUTSIDE the database, with one line per COMPLETED erasure.
 *
 * Why a file: a database restore brings back the database as it was, including data erased later. The
 * ledger is the one record that survives such a restore, so `privacy:reconcile` can erase it again.
 * It holds identifiers only (request, academy and player ids, category names, time) - no names, no content.
 *
 * What it guarantees and what it does not (PRIVACY_LIFECYCLE.md): protection against restoring the
 * DATABASE (and re-applying the erasure to it). It does not delete anything from backups themselves,
 * and it protects nothing if the file is lost or stored inside the same backup set as the database.
 */
export type LedgerEntry = {
  v: 1;
  requestId: string;
  academyId: string;
  playerId: string;
  completedAt: string;
  categories: { category: CategoryKey; action: RetentionAction }[];
};
export function ledgerPath(env: Record<string, string | undefined> = process.env): string | null {
  if (env.ERASURE_LEDGER_PATH) return resolve(env.ERASURE_LEDGER_PATH);
  // Development and tests have a default; production must say where the ledger lives.
  return env.NODE_ENV === "production" ? null : resolve(".data/erasure-ledger.jsonl");
}
export async function appendLedger(entry: LedgerEntry, path = ledgerPath()) {
  if (!path) throw new Error("LEDGER_NOT_CONFIGURED");
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "a");
  try {
    await file.write(`${JSON.stringify(entry)}\n`);
    // Durable before the request is marked complete.
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function readLedger(path = ledgerPath()): Promise<LedgerEntry[]> {
  if (!path) throw new Error("LEDGER_NOT_CONFIGURED");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      if (e?.v === 1 && e.requestId && e.academyId && e.playerId && Array.isArray(e.categories)) out.push(e);
    } catch {
      /* a torn final line (crash mid-write) is ignored; earlier lines are intact */
    }
  }
  return out;
}
