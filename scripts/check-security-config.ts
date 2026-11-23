import {
  checkSecurityConfig,
  formatFindings,
  hasErrors,
} from "../src/modules/identity/security-config";
/**
 * Reviews the account-security settings of the environment it runs in, without starting the
 * application or touching the database. Output never contains a secret value.
 *
 *   npm run auth:check-config                 review as the current NODE_ENV
 *   npm run auth:check-config -- --production review as production (use before deploying)
 *
 * Exit code 1 when any error is found.
 */
const asProduction = process.argv.includes("--production");
const findings = checkSecurityConfig(
  process.env,
  asProduction || process.env.NODE_ENV === "production"
    ? "production"
    : "development",
);
console.log(
  findings.length
    ? formatFindings(findings).join("\n")
    : "No findings.",
);
console.log(
  hasErrors(findings)
    ? "Result: errors found."
    : "Result: no errors (warnings and notes above, if any, need a human decision).",
);
process.exitCode = hasErrors(findings) ? 1 : 0;
