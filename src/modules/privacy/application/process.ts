import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import { privateFiles } from "../../../infrastructure/storage/private-files";
import { systemUnit } from "../../academy/application/access";
import { DomainError } from "../../training/domain/rules";
import { EXECUTION_ORDER, LOCK_MINUTES, MAX_ATTEMPTS, backoffMinutes, categoryInfo, type CategoryKey, type RetentionAction, type Step } from "../domain";
import { perform, inspect } from "./categories";
import { appendLedger, ledgerPath, readLedger } from "./ledger";
import { activeHolds, loadRequest, logEvent, move, security, type Row } from "./service";
/**
 * Phase 8: durable execution of approved erasures. There is no queue platform: the erasure request row
 * is the job. Nothing here is reachable except through an APPROVED request whose grace period has
 * passed (or the ledger reconciliation, below).
 *
 *  claim      one atomic step under the academy lock: GRACE_PERIOD -> PROCESSING with a lock owner and
 *             expiry (a crashed runner's lock expires and the next run takes over: restart recovery)
 *  steps      one transaction per category, each re-checking: still processing and ours, no legal hold,
 *             the retention rule still approved for the same action, the player still there
 *  files      the database records which private files must go (outbox); they are removed AFTER the
 *             transaction commits and retried until done or explicitly failed
 *  ledger     the completed erasure is appended (and synced) to the external ledger BEFORE the request is
 *             marked COMPLETED, so a restored older database can be corrected (reconcile)
 *  failure    bounded attempts with exponential backoff, then an explicit FAILED. Nothing is "done" silently.
 */
export type RunOutcome = { id: string; status: string; note?: string };
const names = (error: unknown) => (error instanceof DomainError ? (error.code ?? "DOMAIN_ERROR") : error instanceof Error ? error.message === "LEDGER_NOT_CONFIGURED" ? "LEDGER_NOT_CONFIGURED" : error.name : "UNKNOWN").slice(0, 60);
/**
 * Runs the erasures that are due. `academyId` limits the run to ONE academy and is what every request-driven caller
 * passes (an owner's "run now" must neither process nor learn about another academy's requests). Without it the run
 * covers every academy: that is the operator command (`npm run privacy:process`), which has no academy of its own.
 */
export async function processDueErasures(opts: { now?: Date; limit?: number; academyId?: string } = {}): Promise<RunOutcome[]> {
  const now = opts.now ?? new Date();
  const db = database();
  const due = await db
    .select({ id: t.erasureRequests.id, academyId: t.erasureRequests.academyId })
    .from(t.erasureRequests)
    .where(
      and(
        opts.academyId === undefined ? undefined : eq(t.erasureRequests.academyId, opts.academyId),
        inArray(t.erasureRequests.status, ["GRACE_PERIOD", "PROCESSING"]),
        lte(t.erasureRequests.executeAfter, now),
        or(isNull(t.erasureRequests.nextAttemptAt), lte(t.erasureRequests.nextAttemptAt, now)),
        or(isNull(t.erasureRequests.lockedUntil), lte(t.erasureRequests.lockedUntil, now)),
      ),
    )
    .orderBy(t.erasureRequests.executeAfter)
    .limit(opts.limit ?? 10);
  const out: RunOutcome[] = [];
  for (const d of due) out.push(await runRequest(d.academyId, d.id, now));
  return out;
}
async function claim(academyId: string, id: string, now: Date, runner: string): Promise<Row | null> {
  return systemUnit(academyId, async (tx) => {
    const row = await loadRequest(tx, academyId, id);
    const lock = { lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000), lockedBy: runner, attempts: row.attempts + 1, nextAttemptAt: null, failureCode: null };
    if (row.status === "GRACE_PERIOD") {
      if (!row.executeAfter || row.executeAfter.getTime() > now.getTime()) return null;
      if ((await activeHolds(tx, academyId, row.playerId)).length) {
        await move(tx, row, "BLOCKED", { blockedReason: "LEGAL_HOLD" }, null, { event: "BLOCKED_BY_HOLD", detail: { at: "claim" } });
        await security(tx, null, academyId, "ERASURE_BLOCKED", { ref: id });
        return null;
      }
      return move(tx, row, "PROCESSING", lock, null, { event: "PROCESSING_STARTED", detail: { attempt: lock.attempts } });
    }
    if (row.status !== "PROCESSING") return null;
    if ((row.lockedUntil && row.lockedUntil.getTime() > now.getTime()) || (row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime())) return null;
    const [saved] = await tx.update(t.erasureRequests).set({ ...lock, version: row.version + 1, updatedAt: now }).where(eq(t.erasureRequests.id, id)).returning();
    await logEvent(tx, null, id, academyId, { event: "RECOVERED", detail: { attempt: lock.attempts } });
    return saved;
  });
}
async function failAttempt(academyId: string, id: string, runner: string, code: string, now: Date) {
  await systemUnit(academyId, async (tx) => {
    const row = await loadRequest(tx, academyId, id);
    if (row.status !== "PROCESSING" || row.lockedBy !== runner) return;
    if (row.attempts >= MAX_ATTEMPTS) {
      await move(tx, row, "FAILED", { failureCode: code, lockedUntil: null, lockedBy: null }, null, { event: "FAILED", detail: { code, attempts: row.attempts } });
      await security(tx, null, academyId, "ERASURE_FAILED", { ref: id });
      return;
    }
    const next = new Date(now.getTime() + backoffMinutes(row.attempts) * 60_000);
    await tx.update(t.erasureRequests).set({ failureCode: code, nextAttemptAt: next, lockedUntil: null, lockedBy: null, version: row.version + 1, updatedAt: now }).where(eq(t.erasureRequests.id, id));
    await logEvent(tx, null, id, academyId, { event: "RETRY_SCHEDULED", detail: { code, attempt: row.attempts, nextAttemptAt: next.toISOString() } });
  });
}
type StepResult = "DONE" | "BLOCKED" | "LOST";
async function runStep(academyId: string, id: string, runner: string, category: CategoryKey, now: Date): Promise<StepResult> {
  return systemUnit(academyId, async (tx) => {
    const row = await loadRequest(tx, academyId, id);
    if (row.status !== "PROCESSING" || row.lockedBy !== runner) return "LOST";
    const steps = row.steps as Step[];
    const step = steps.find((s) => s.category === category)!;
    // Revalidated NOW, in the same transaction that would erase: holds, rule, subject.
    if ((await activeHolds(tx, academyId, row.playerId)).length) {
      await move(tx, row, "BLOCKED", { blockedReason: "LEGAL_HOLD", lockedUntil: null, lockedBy: null }, null, { event: "BLOCKED_BY_HOLD", detail: { at: "step", category } });
      await security(tx, null, academyId, "ERASURE_BLOCKED", { ref: id, category });
      return "BLOCKED";
    }
    const save = async (patch: Partial<Step>, event: string, detail: Record<string, unknown>) => {
      const next = steps.map((s) => (s.category === category ? { ...s, ...patch } : s));
      await tx.update(t.erasureRequests).set({ steps: next, updatedAt: now }).where(eq(t.erasureRequests.id, id));
      await logEvent(tx, null, id, academyId, { event, detail: { category, ...detail } });
    };
    const [policy] = await tx.select().from(t.retentionPolicies).where(and(eq(t.retentionPolicies.academyId, academyId), eq(t.retentionPolicies.category, category)));
    if (!policy || policy.status !== "APPROVED" || policy.action !== step.action) return (await save({ status: "SKIPPED", code: "POLICY_CHANGED" }, "STEP_SKIPPED", { code: "POLICY_CHANGED" }), "DONE");
    const [player] = await tx.select({ id: t.players.id }).from(t.players).where(and(eq(t.players.academyId, academyId), eq(t.players.id, row.playerId)));
    if (!player) return (await save({ status: "SKIPPED", code: "SUBJECT_MISSING" }, "STEP_SKIPPED", { code: "SUBJECT_MISSING" }), "DONE");
    const records = await perform(category, tx, academyId, row.playerId, id);
    await save({ status: "DONE", records, code: undefined }, "STEP_DONE", { records, action: step.action });
    return "DONE";
  });
}
export async function runRequest(academyId: string, id: string, now = new Date()): Promise<RunOutcome> {
  const runner = crypto.randomUUID();
  const claimed = await claim(academyId, id, now, runner);
  if (!claimed) return { id, status: (await database().select({ s: t.erasureRequests.status }).from(t.erasureRequests).where(eq(t.erasureRequests.id, id)))[0]?.s ?? "UNKNOWN", note: "not claimed" };
  try {
    const plan = (claimed.plan as { category: CategoryKey; action: RetentionAction }[]).slice().sort((a, b) => EXECUTION_ORDER.indexOf(a.category) - EXECUTION_ORDER.indexOf(b.category));
    for (const s of plan) {
      const current = ((await database().select({ steps: t.erasureRequests.steps }).from(t.erasureRequests).where(eq(t.erasureRequests.id, id)))[0].steps as Step[]).find((x) => x.category === s.category);
      if (current && (current.status === "DONE" || current.status === "SKIPPED")) continue;
      let result: StepResult;
      try {
        result = await runStep(academyId, id, runner, s.category, now);
      } catch (error) {
        await markStepFailed(academyId, id, s.category, names(error));
        await failAttempt(academyId, id, runner, `STEP_${s.category}`, now);
        return { id, status: "PROCESSING", note: `step ${s.category} failed` };
      }
      if (result === "BLOCKED") return { id, status: "BLOCKED" };
      if (result === "LOST") return { id, status: "PROCESSING", note: "lock lost" };
    }
    // Files: removed after the commit, retried until done or explicitly failed.
    const files = await processStorageDeletions({ requestId: id, now });
    if (files.failed) {
      await failTerminal(academyId, id, runner, "STORAGE_FAILED");
      return { id, status: "FAILED", note: "private files could not be removed" };
    }
    if (files.pending) {
      await failAttempt(academyId, id, runner, "STORAGE_PENDING", now);
      return { id, status: "PROCESSING", note: "private files still to remove" };
    }
    const final = await database().select().from(t.erasureRequests).where(eq(t.erasureRequests.id, id));
    const row = final[0];
    await appendLedger({ v: 1, requestId: id, academyId, playerId: row.playerId, completedAt: now.toISOString(), categories: plan });
    await systemUnit(academyId, async (tx) => {
      const r = await loadRequest(tx, academyId, id);
      if (r.status !== "PROCESSING" || r.lockedBy !== runner) return;
      const steps = r.steps as Step[];
      await move(tx, r, "COMPLETED", { completedAt: now, lockedUntil: null, lockedBy: null, failureCode: null }, null, {
        event: "COMPLETED",
        detail: { steps: steps.map((s) => ({ category: s.category, status: s.status, records: s.records ?? 0 })), reconciliation: "ledger entry written" },
      });
      await security(tx, null, academyId, "ERASURE_COMPLETED", { ref: id });
    });
    return { id, status: "COMPLETED" };
  } catch (error) {
    // Anything unexpected (for example the ledger): a recorded retry, never a silent success.
    await failAttempt(academyId, id, runner, names(error), now);
    return { id, status: "PROCESSING", note: names(error) };
  }
}
async function markStepFailed(academyId: string, id: string, category: CategoryKey, code: string) {
  await systemUnit(academyId, async (tx) => {
    const row = await loadRequest(tx, academyId, id);
    const steps = (row.steps as Step[]).map((s) => (s.category === category ? { ...s, status: "FAILED" as const, code } : s));
    await tx.update(t.erasureRequests).set({ steps, updatedAt: new Date() }).where(eq(t.erasureRequests.id, id));
    await logEvent(tx, null, id, academyId, { event: "STEP_FAILED", detail: { category, code } });
  });
}
async function failTerminal(academyId: string, id: string, runner: string, code: string) {
  await systemUnit(academyId, async (tx) => {
    const row = await loadRequest(tx, academyId, id);
    if (row.status !== "PROCESSING" || row.lockedBy !== runner) return;
    await move(tx, row, "FAILED", { failureCode: code, lockedUntil: null, lockedBy: null }, null, { event: "FAILED", detail: { code } });
    await security(tx, null, academyId, "ERASURE_FAILED", { ref: id });
  });
}
/** Removes the private files recorded in the outbox. Idempotent: a file that is already gone counts as done. */
export async function processStorageDeletions(opts: { requestId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const db = database();
  const rows = await db
    .select()
    .from(t.storageDeletions)
    .where(and(eq(t.storageDeletions.status, "PENDING"), opts.requestId ? eq(t.storageDeletions.requestId, opts.requestId) : undefined));
  for (const r of rows) {
    if (r.nextAttemptAt && r.nextAttemptAt.getTime() > now.getTime() && !opts.requestId) continue;
    try {
      await privateFiles.remove(r.storageKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const attempts = r.attempts + 1;
        await db.update(t.storageDeletions).set({ attempts, lastError: names(error), status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING", nextAttemptAt: new Date(now.getTime() + backoffMinutes(attempts) * 60_000) }).where(eq(t.storageDeletions.id, r.id));
        continue;
      }
    }
    await db.update(t.storageDeletions).set({ status: "DONE", doneAt: now, lastError: null }).where(eq(t.storageDeletions.id, r.id));
  }
  const left = await db.select({ status: t.storageDeletions.status }).from(t.storageDeletions).where(and(inArray(t.storageDeletions.status, ["PENDING", "FAILED"]), opts.requestId ? eq(t.storageDeletions.requestId, opts.requestId) : undefined));
  return { pending: left.filter((l) => l.status === "PENDING").length, failed: left.filter((l) => l.status === "FAILED").length };
}
export type Reconciliation = { checked: number; alreadyErased: number; resurrected: { requestId: string; academyId: string; playerId: string; categories: CategoryKey[] }[]; reapplied: number };
/**
 * After a database restore: compares the external ledger with the database and, with `apply`, erases again
 * what a restore brought back. The ledger is the authority: the category list recorded when the erasure was
 * approved is applied as is (the restored database may have an older retention rule or none), and legal holds
 * are not consulted (a hold cannot preserve data that was lawfully erased before the hold existed).
 */
export async function reconcileFromLedger(opts: { apply?: boolean; path?: string | null } = {}): Promise<Reconciliation> {
  const path = opts.path ?? ledgerPath();
  const entries = await readLedger(path);
  const seen = new Set<string>();
  const report: Reconciliation = { checked: 0, alreadyErased: 0, resurrected: [], reapplied: 0 };
  const touched: string[] = [];
  for (const e of entries) {
    if (seen.has(e.requestId)) continue;
    seen.add(e.requestId);
    report.checked++;
    const outcome = await systemUnit(e.academyId, async (tx) => {
      const [academy] = await tx.select({ id: t.academies.id }).from(t.academies).where(eq(t.academies.id, e.academyId));
      const [player] = await tx.select({ id: t.players.id }).from(t.players).where(and(eq(t.players.academyId, e.academyId), eq(t.players.id, e.playerId)));
      if (!academy || !player) return { state: "ABSENT" as const };
      const dirty: CategoryKey[] = [];
      for (const c of e.categories) if (categoryInfo(c.category)?.actions.length && (await inspect(c.category, tx, e.academyId, e.playerId)).records > 0) dirty.push(c.category);
      if (!dirty.length) return { state: "CLEAN" as const };
      if (!opts.apply) return { state: "DIRTY" as const, dirty };
      const id = crypto.randomUUID();
      const now = new Date();
      const steps: Step[] = [];
      // A completed request row first (outbox rows refer to it), then the same category code as normal erasure.
      await tx.insert(t.erasureRequests).values({ id, academyId: e.academyId, playerId: e.playerId, source: "RECONCILIATION", reason: `Re-applying completed erasure ${e.requestId} after a restore`, requestedBy: "system", status: "COMPLETED", plan: e.categories, steps, completedAt: now, updatedAt: now });
      for (const c of e.categories.filter((x) => dirty.includes(x.category)))
        steps.push({ category: c.category, action: c.action, status: "DONE", records: await perform(c.category, tx, e.academyId, e.playerId, id) });
      await tx.update(t.erasureRequests).set({ steps }).where(eq(t.erasureRequests.id, id));
      await logEvent(tx, null, id, e.academyId, { event: "RECONCILED", to: "COMPLETED", detail: { original: e.requestId, categories: dirty.length } });
      await security(tx, null, e.academyId, "ERASURE_COMPLETED", { ref: id });
      return { state: "DIRTY" as const, dirty, id };
    });
    if (outcome.state === "CLEAN" || outcome.state === "ABSENT") report.alreadyErased++;
    else {
      report.resurrected.push({ requestId: e.requestId, academyId: e.academyId, playerId: e.playerId, categories: outcome.dirty });
      if ("id" in outcome && outcome.id) {
        report.reapplied++;
        touched.push(outcome.id);
      }
    }
  }
  for (const id of touched) await processStorageDeletions({ requestId: id });
  return report;
}
