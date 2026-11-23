import {
  MigrationError,
  runMigrations,
  targetFromEnv,
} from "../src/infrastructure/database/migrations";
// DATABASE_URL set  -> hosted PostgreSQL (remote targets need MIGRATION_CONFIRM_TARGET).
// otherwise         -> embedded development database at LOCAL_DATABASE_PATH.
// --plan            -> list pending migrations and change nothing.
const dryRun = process.argv.includes("--plan");
try {
  const report = await runMigrations({
    target: targetFromEnv(process.env),
    dryRun,
  });
  console.log(`Target: ${report.target}`);
  console.log(`Already applied: ${report.applied.length}`);
  console.log(
    report.pending.length
      ? `${dryRun ? "Would apply" : "Applied"}: ${report.pending.join(", ")}`
      : "Database is up to date.",
  );
} catch (error) {
  console.error(
    error instanceof MigrationError
      ? error.message
      : `Migration failed; all pending migrations run in one transaction, so none were kept. ${error instanceof Error ? error.message : ""}`,
  );
  process.exitCode = 1;
}
