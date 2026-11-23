import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "./helpers/fixtures";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
} from "../src/modules/identity/password-policy";
import {
  TEMPORARY_PASSWORD_TTL_MS,
  generateTemporaryPassword,
  temporaryPasswordExpiry,
} from "../src/modules/identity/temporary-password";
import {
  DENIAL_RESPONSE,
  resetDecision,
  type ResetDenial,
} from "../src/modules/identity/reset-policy";
import {
  MfaPolicyError,
  mfaPolicy,
  mfaRequiredFor,
} from "../src/modules/identity/mfa-policy";
import { gateAllowsPath } from "../src/modules/identity/account-gate";
import { throttleKey } from "../src/modules/identity/sign-in-throttle";
import {
  base32Decode,
  hotp,
  parseProvisioningUri,
  totpAt,
} from "./helpers/totp";
/**
 * Pure rules (no server, no database): password policy, temporary-password generation, the
 * administrative-reset authorization matrix, the MFA rollout policy, the forced-rotation endpoint
 * allow-lists, and the independent TOTP implementation the other suites rely on.
 */
const ctx = { email: "jordan.fixture@example.test", name: "Jordan Fixture" };
test("password policy: accepts long, unrelated passphrases", () => {
  for (const ok of [
    "correct horse battery staple",
    "Tr4velling-Quokka-Ember-Window",
    "a".repeat(5) + "-purple-lantern-" + "b".repeat(5),
    "ünïcödé passphrase 密碼 long enough",
  ])
    assert.equal(passwordProblem(ok, ctx), null, ok);
});
test("password policy: rejects short, long, blank, repeated, sequential, common and personal passwords", () => {
  const cases: [string, RegExp][] = [
    ["Short-1aB", /at least 12/],
    ["x".repeat(PASSWORD_MAX_LENGTH + 1), /at most/],
    [" ".repeat(PASSWORD_MIN_LENGTH + 2), /only spaces/],
    ["aaaaaaaaaaaaaaaa", /repeated|sequential/],
    ["abcdefghijklmnop", /repeated|sequential/],
    ["1234567890123", /repeated|sequential/],
    ["Password12345", /easy to guess/],
    ["P@ssw0rd!2026", /easy to guess/],
    ["Welcome-2026!!", /easy to guess/],
    ["Sportozen#Academy1", /easy to guess/],
    ["qwertyuiop-12", /easy to guess/],
    ["xx-jordan.fixture-xx-123", /email/],
    ["Carefully-Fixture-77", /name/],
  ];
  for (const [candidate, expected] of cases)
    assert.match(passwordProblem(candidate, ctx) ?? "ACCEPTED", expected, candidate);
});
test("password policy messages never echo the password", () => {
  for (const candidate of ["Password12345", "short", "xx-jordan.fixture-xx-123"]) {
    const message = passwordProblem(candidate, ctx) ?? "";
    assert.ok(message && !message.includes(candidate), candidate);
  }
});
test("temporary passwords: format, alphabet, uniqueness and distribution", () => {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (let i = 0; i < 4000; i++) {
    const value = generateTemporaryPassword();
    assert.match(value, /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/, value);
    // The generated value satisfies the length floor, so it is also acceptable as a password.
    assert.ok(value.length >= PASSWORD_MIN_LENGTH);
    seen.add(value);
    for (const ch of value.replace(/-/g, ""))
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  assert.equal(seen.size, 4000, "no repeats in 4000 draws");
  // 31 symbols, 64 000 draws: each expects ~2065. A biased or constant generator fails loudly.
  assert.equal(counts.size, 31);
  for (const [ch, n] of counts) assert.ok(n > 1800 && n < 2330, `${ch}: ${n}`);
});
test("temporary passwords are not derived from the clock or a counter", () => {
  const a = generateTemporaryPassword();
  const b = generateTemporaryPassword();
  assert.notEqual(a, b);
  const joined = a.replace(/-/g, "");
  assert.ok(!/^\d+$/.test(joined) && !/^(.)\1+$/.test(joined));
});
test("temporary password validity is exactly 72 hours", () => {
  const issued = new Date("2030-01-01T00:00:00.000Z");
  assert.equal(TEMPORARY_PASSWORD_TTL_MS, 72 * 3600 * 1000);
  assert.equal(
    temporaryPasswordExpiry(issued).toISOString(),
    "2030-01-04T00:00:00.000Z",
  );
});
const green = "academy-green";
const blue = "academy-blue";
const owner = { id: "o", academyId: green, role: "OWNER" };
const member = (id: string, role: string, academyId = green) => ({
  id,
  memberships: [{ academyId, role }],
});
test("reset authorization: only an OWNER may initiate, for every role", () => {
  for (const role of ROLES) {
    const result = resetDecision(
      { id: "actor", academyId: green, role },
      member("target", "COACH"),
    );
    if (role === "OWNER") assert.deepEqual(result, { allowed: true });
    else assert.deepEqual(result, { allowed: false, reason: "NOT_OWNER" }, role);
  }
});
test("reset authorization: every target role and relationship", () => {
  const expected: [string, ReturnType<typeof resetDecision>][] = [];
  for (const role of ROLES)
    expected.push([
      role,
      role === "OWNER"
        ? { allowed: false, reason: "TARGET_IS_OWNER" }
        : { allowed: true },
    ]);
  for (const [role, outcome] of expected)
    assert.deepEqual(resetDecision(owner, member("t", role)), outcome, role);
  // self
  assert.deepEqual(resetDecision(owner, member("o", "COACH")), {
    allowed: false,
    reason: "SELF",
  });
  // another academy's member, and a person with no membership at all
  assert.deepEqual(resetDecision(owner, member("t", "COACH", blue)), {
    allowed: false,
    reason: "TARGET_NOT_MEMBER",
  });
  assert.deepEqual(resetDecision(owner, { id: "t", memberships: [] }), {
    allowed: false,
    reason: "TARGET_NOT_MEMBER",
  });
  // a person who belongs to this academy and another
  assert.deepEqual(
    resetDecision(owner, {
      id: "t",
      memberships: [
        { academyId: green, role: "COACH" },
        { academyId: blue, role: "COACH" },
      ],
    }),
    { allowed: false, reason: "TARGET_MULTI_ACADEMY" },
  );
});
test("reset denial responses never distinguish a foreign member from an unknown id", () => {
  assert.deepEqual(
    DENIAL_RESPONSE.TARGET_NOT_MEMBER,
    { status: "NOT_FOUND", message: "Member not found." },
  );
  const reasons = Object.keys(DENIAL_RESPONSE) as ResetDenial[];
  assert.equal(new Set(reasons.map((r) => DENIAL_RESPONSE[r].message)).size, reasons.length);
});
test("MFA policy: safe defaults, explicit modes, loud failure on typos", () => {
  assert.deepEqual(mfaPolicy({}), { mode: "off", roles: [] });
  // A copied .env.example leaves the variables present but empty.
  assert.deepEqual(mfaPolicy({ MFA_ENFORCEMENT: "", MFA_REQUIRED_ROLES: " " }), { mode: "off", roles: [] });
  assert.deepEqual(mfaPolicy({ MFA_ENFORCEMENT: "off", MFA_REQUIRED_ROLES: "COACH" }), {
    mode: "off",
    roles: [],
  });
  // Approved default (Phase 4): every staff role; GUARDIAN and ADULT_PLAYER stay optional.
  assert.deepEqual(mfaPolicy({ MFA_ENFORCEMENT: "warn" }), {
    mode: "warn",
    roles: ["OWNER", "ADMIN", "HEAD_COACH", "COACH", "FINANCE", "NUTRITION_PRO"],
  });
  assert.deepEqual(
    mfaPolicy({ MFA_ENFORCEMENT: " Enforce ", MFA_REQUIRED_ROLES: "owner, finance" }),
    { mode: "enforce", roles: ["OWNER", "FINANCE"] },
  );
  assert.throws(() => mfaPolicy({ MFA_ENFORCEMENT: "yes" }), MfaPolicyError);
  assert.throws(
    () => mfaPolicy({ MFA_ENFORCEMENT: "warn", MFA_REQUIRED_ROLES: "OWNER,CHEF" }),
    /CHEF/,
  );
  const policy = mfaPolicy({ MFA_ENFORCEMENT: "enforce" });
  assert.equal(mfaRequiredFor(policy, "OWNER"), true);
  assert.equal(mfaRequiredFor(policy, "COACH"), true);
  assert.equal(mfaRequiredFor(policy, "GUARDIAN"), false);
  assert.equal(mfaRequiredFor(policy, "ADULT_PLAYER"), false);
  assert.equal(mfaRequiredFor(policy, null), false);
  assert.equal(mfaRequiredFor(mfaPolicy({}), "OWNER"), false);
});
test("forced-rotation allow-lists: a gated session reaches only what it needs", () => {
  const changePassword = "/account/change-password";
  assert.equal(gateAllowsPath("PASSWORD_CHANGE_REQUIRED", changePassword), true);
  assert.equal(gateAllowsPath("TEMPORARY_PASSWORD_EXPIRED", changePassword), false);
  for (const code of [
    "PASSWORD_CHANGE_REQUIRED",
    "TEMPORARY_PASSWORD_EXPIRED",
    "MFA_ENROLLMENT_REQUIRED",
  ] as const) {
    assert.equal(gateAllowsPath(code, "/sign-out"), true, code);
    assert.equal(gateAllowsPath(code, "/list-sessions"), false, code);
    assert.equal(gateAllowsPath(code, "/update-user"), false, code);
    assert.equal(gateAllowsPath(code, "/account/admin/reset-password"), false, code);
    assert.equal(gateAllowsPath(code, "/two-factor/disable"), false, code);
    assert.equal(gateAllowsPath(code, "/two-factor/generate-backup-codes"), false, code);
  }
  assert.equal(gateAllowsPath("MFA_ENROLLMENT_REQUIRED", "/two-factor/enable"), true);
  assert.equal(gateAllowsPath("PASSWORD_CHANGE_REQUIRED", "/two-factor/enable"), false);
});
test("sign-in throttle keys are keyed, case-insensitive and scoped", () => {
  const a = throttleKey("secret-one", "sign-in", "Person@Example.test ");
  assert.equal(a, throttleKey("secret-one", "sign-in", "person@example.test"));
  assert.notEqual(a, throttleKey("secret-two", "sign-in", "person@example.test"));
  assert.notEqual(a, throttleKey("secret-one", "change-password", "person@example.test"));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.ok(!a.includes("example"));
});
test("independent TOTP implementation matches the RFC 6238 test vectors", () => {
  const key = Buffer.from("12345678901234567890");
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [seconds, code] of vectors)
    assert.equal(totpAt(key, 0, { now: seconds * 1000, digits: 8 }), code, String(seconds));
  // RFC 4226 appendix D counter vectors
  assert.deepEqual(
    [0, 1, 2, 3].map((n) => hotp(key, n)),
    ["755224", "287082", "359152", "969429"],
  );
  assert.equal(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").toString(), "12345678901234567890");
  const uri = parseProvisioningUri(
    "otpauth://totp/Sportozen:a%40b.test?secret=GEZDGNBVGY3TQOJQ&issuer=Sportozen&digits=6&period=30",
  );
  assert.equal(uri.account, "Sportozen:a@b.test");
  assert.equal(uri.period, 30);
});
