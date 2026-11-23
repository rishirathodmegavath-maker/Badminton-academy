import { userInfo } from "node:os";
import {
  MigrationError,
  assertSafeTarget,
  describeTarget,
  targetFromEnv,
} from "../src/infrastructure/database/migrations";
import { closeDatabase } from "../src/infrastructure/database/client";
import {
  RecoveryError,
  describeRecoveryTarget,
  recoverAccount,
} from "../src/modules/identity/operator-recovery";
import {
  approveOwnerRestore,
  describeOwnerRestore,
  requestOwnerRestore,
  verifyRecoveryChain,
} from "../src/modules/identity/owner-recovery";
/**
 * Operator account recovery (see operator-recovery.ts).
 *
 *   npm run auth:recover -- --email owner@example.com --reason "Owner lost access, verified by phone" --yes
 *   add --reset-authenticator when the authenticator device AND recovery codes are lost
 *
 * Owner restoration for an academy with no active owner (RC-2, TD-5 with a second approver; see
 * owner-recovery.ts). Two different operators, two commands:
 *
 *   npm run auth:recover -- --restore-owner former.owner@example.com --reason "Ticket 4411, identity verified by phone" --yes
 *   add --academy <academy id> when the person belongs to more than one academy (the restoration is about one of them;
 *   their password and sessions are then LEFT ALONE, so working in the other academies is not interrupted)
 *   npm run auth:recover -- --approve-owner-restore <request-id> --approval-code <code> --yes
 *   npm run auth:recover -- --verify-recovery-log
 *
 * Without --yes it only shows which database it would change (and, for --restore-owner, whether the
 * account is eligible). A database that is not on this machine additionally needs
 * MIGRATION_CONFIRM_TARGET=host:port/database, exactly as for migrations. Temporary passwords and
 * approval codes are printed once; neither is stored anywhere in readable form.
 *
 * The operator identity is the operating-system account running the command. The two steps must be
 * run from two different operator accounts.
 */
const args = process.argv.slice(2);
const value = (flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
// Tests run both steps from one OS account; the override is honoured only under NODE_ENV=test.
const operator = () =>
  process.env.NODE_ENV === "test" && process.env.RECOVERY_OPERATOR
    ? process.env.RECOVERY_OPERATOR
    : userInfo().username;
async function restoreOwner(email: string) {
  const reason = value("--reason");
  const academyId = value("--academy");
  if (!reason)
    throw new RecoveryError(
      'Usage: npm run auth:recover -- --restore-owner <address> --reason "<why>" --yes',
    );
  const found = await describeOwnerRestore(email, academyId);
  console.log(`Account:  ${email}`);
  console.log(`Person:   ${found.name} (${found.currentRole}${found.active ? "" : ", inactive"} @ ${found.academy})`);
  console.log(`Eligible: yes, as ${found.candidateType}`);
  console.log(
    found.credentialsShared
      ? "Credentials: this person also works in another academy, so their password and sessions will NOT be changed (only the role here)."
      : "Credentials: a one-time temporary password will be issued and every session of theirs ended.",
  );
  if (!args.includes("--yes")) {
    console.log("Nothing changed. Repeat the command with --yes to record the request.");
    return;
  }
  const request = await requestOwnerRestore({ email, reason, operator: operator(), academyId });
  console.log(`Request recorded. Nothing has changed yet. It expires ${request.expiresAt.toISOString()} (24 hours).`);
  console.log(`Request ID:    ${request.requestId}`);
  console.log("Approval code (shown once; give it privately to the SECOND operator):");
  console.log(request.approvalCode);
  console.log(
    "A different operator completes it with: npm run auth:recover -- --approve-owner-restore <request-id> --approval-code <code> --yes",
  );
}
async function approveOwner(requestId: string) {
  const code = value("--approval-code");
  if (!code)
    throw new RecoveryError(
      "Usage: npm run auth:recover -- --approve-owner-restore <request-id> --approval-code <code> --yes",
    );
  if (!args.includes("--yes")) {
    console.log("Nothing changed. Repeat the command with --yes to approve and restore the owner.");
    return;
  }
  const result = await approveOwnerRestore({ requestId, approvalCode: code, operator: operator() });
  console.log(`Owner restored (${result.candidateType}).`);
  if (!result.credentialsChanged || !result.expiresAt || !result.temporaryPassword) {
    console.log("Credentials unchanged: the person also works in another academy, so their password and sessions were left alone.");
    console.log("If they have also lost their password, run the separate account recovery (it lists every academy it affects).");
    return;
  }
  console.log(`Sessions revoked: ${result.revokedSessions}`);
  console.log(`Valid until: ${result.expiresAt.toISOString()} (72 hours)`);
  console.log("Temporary password (shown once; give it to the person privately):");
  console.log(result.temporaryPassword);
}
async function accountRecovery() {
  const email = value("--email");
  const reason = value("--reason");
  if (!email || !reason)
    throw new RecoveryError(
      'Usage: npm run auth:recover -- --email <address> --reason "<why>" [--reset-authenticator] --yes',
    );
  console.log(`Account:  ${email}`);
  // Show who this is before anything changes, so a mistyped address is caught.
  const found = await describeRecoveryTarget(email);
  if (!found) throw new RecoveryError("No account matches that email address.");
  console.log(
    `Person:   ${found.name} (${found.roles.length ? found.roles.join("; ") : "no active membership"})`,
  );
  console.log(`Authenticator enrolled: ${found.authenticatorEnrolled}`);
  if (found.roles.length > 1)
    console.log(
      `WARNING: this login is active in ${found.roles.length} academies. Account recovery replaces the password and ends the sessions in ALL of them, not only one. To restore ownership of a single academy without touching the credentials, use --restore-owner ... --academy <id>.`,
    );
  if (!found.roles.length)
    console.log(
      "Note: this account has no active membership; a new password will not give it access to any academy.",
    );
  if (!args.includes("--yes")) {
    console.log("Nothing changed. Repeat the command with --yes to proceed.");
  } else {
    const result = await recoverAccount({
      email,
      reason,
      resetAuthenticator: args.includes("--reset-authenticator"),
      operator: userInfo().username,
    });
    console.log(`Sessions revoked: ${result.revokedSessions}`);
    console.log(`Authenticator removed: ${result.authenticatorRemoved}`);
    console.log(`Valid until: ${result.expiresAt.toISOString()} (72 hours)`);
    console.log(
      "Temporary password (shown once; give it to the person privately):",
    );
    console.log(result.temporaryPassword);
  }
}
try {
  const restore = value("--restore-owner");
  const approve = value("--approve-owner-restore");
  const ownerMode = !!restore || !!approve || args.includes("--verify-recovery-log");
  // Unchanged order for account recovery: the usage error comes before any database is touched.
  if (!ownerMode && (!value("--email") || !value("--reason")))
    throw new RecoveryError(
      'Usage: npm run auth:recover -- --email <address> --reason "<why>" [--reset-authenticator] --yes',
    );
  const target = targetFromEnv(process.env);
  assertSafeTarget(target, process.env);
  console.log(`Database: ${describeTarget(target)}`);
  if (restore) await restoreOwner(restore);
  else if (approve) await approveOwner(approve);
  else if (args.includes("--verify-recovery-log")) {
    const check = await verifyRecoveryChain();
    console.log(
      `Recovery log: ${check.events} event(s) in ${check.academies} academy chain(s): ${check.ok ? "intact" : "PROBLEMS FOUND"}`,
    );
    for (const problem of check.problems) console.log(`  ${problem}`);
    if (!check.ok) process.exitCode = 1;
  } else await accountRecovery();
} catch (error) {
  console.error(
    error instanceof RecoveryError || error instanceof MigrationError
      ? error.message
      : "Recovery failed; nothing was changed.",
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
