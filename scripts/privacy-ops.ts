import { closeDatabase } from "../src/infrastructure/database/client";
import { processDueErasures, reconcileFromLedger } from "../src/modules/privacy/application/process";
import { ledgerPath } from "../src/modules/privacy/application/ledger";
// Operator commands for retention and erasure (Phase 8). Run from a scheduler or by hand.
//   npm run privacy:process                    run approved erasures whose grace period has passed
//   npm run privacy:reconcile                  REPORT what a restored database brought back (changes nothing)
//   npm run privacy:reconcile -- --apply       erase it again, as recorded in the external erasure ledger
// Output holds counts and opaque ids only.
const command = process.argv[2];
try {
  if (command === "process") {
    const out = await processDueErasures({ limit: 50 });
    console.log(`Due erasures handled: ${out.length}`);
    for (const o of out) console.log(`  ${o.id}  ${o.status}${o.note ? `  (${o.note})` : ""}`);
  } else if (command === "reconcile") {
    const apply = process.argv.includes("--apply");
    console.log(`Ledger: ${ledgerPath() ?? "NOT CONFIGURED (set ERASURE_LEDGER_PATH)"}`);
    const r = await reconcileFromLedger({ apply });
    console.log(`Ledger entries checked: ${r.checked}; already erased or absent: ${r.alreadyErased}; found again: ${r.resurrected.length}${apply ? `; erased again: ${r.reapplied}` : " (report only; use --apply)"}`);
    for (const x of r.resurrected) console.log(`  request ${x.requestId} player ${x.playerId}: ${x.categories.join(", ")}`);
    if (!apply && r.resurrected.length) process.exitCode = 2;
  } else {
    console.error("Usage: privacy-ops.ts process | reconcile [--apply]");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  await closeDatabase().catch(() => {});
}
