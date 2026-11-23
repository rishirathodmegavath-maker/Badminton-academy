import { test } from "node:test";
import assert from "node:assert/strict";
import { GUARDIAN_ACCESS_SCOPES, adultControlled, storedScopes } from "../src/modules/academy/domain/guardian-access";

/**
 * The pure rules of the dormant adult guardian-access code, kept after the adult-player suites were retired (the application no
 * longer creates an adult, but the code that protects a legacy adult record is still in place, so its fail-closed rules stay pinned):
 * which sections exist (never consent), that malformed stored scopes grant nothing, and that anything other than a clean minor
 * profile counts as adult-controlled (so a malformed profile narrows guardian access and never widens it).
 */
const SCOPES = GUARDIAN_ACCESS_SCOPES;

test("domain: scope parsing and the adult test fail closed", () => {
  assert.deepEqual([...SCOPES], ["SCHEDULE", "REPORTS", "NUTRITION", "HEALTH", "FEES", "MEDIA", "MESSAGES"]);
  assert.ok(!(SCOPES as readonly string[]).includes("CONSENT"), "consent is not a scope");
  assert.deepEqual([...storedScopes(["FEES", "MEDIA"])], ["FEES", "MEDIA"]);
  for (const bad of [null, undefined, "FEES", { 0: "FEES" }, ["FEES", "CONSENT"], ["FEES", "FEES"], ["fees"], [1], [["FEES"]], ["FEES", null]])
    assert.equal(storedScopes(bad).size, 0, `malformed scopes ${JSON.stringify(bad)} give nothing`);
  assert.equal(adultControlled(null), false, "no profile: a minor, as before");
  assert.equal(adultControlled({ adult: false, selfUserId: null }), false);
  for (const p of [{ adult: true }, { adult: "false" }, { adult: 0 }, {}, { adult: false, selfUserId: "u" }, { adult: null }])
    assert.equal(adultControlled(p), true, `${JSON.stringify(p)} is adult-controlled (fail closed)`);
});
