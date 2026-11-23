import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  CANARY,
  ROLES,
  ROLE_USER,
  USERS,
  canaryValues,
  type FixtureUserKey,
  type Role,
} from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT, TEST_TIMEOUT } from "./helpers/paths";
import { assertNoLeak, assertPresent, assertShape } from "./helpers/payload";
/**
 * What each role actually receives from GET /api/academy (the whole-academy read model).
 *
 *  1. Positive controls prove every canary is reachable by a role that may see it, so an
 *     "absent" assertion is meaningful.
 *  2. An EXACT visibility matrix (which canary kinds each reviewed role receives, per subject)
 *     covers every collection: sessions, reviews, goals, messages, deliveries, templates, media,
 *     payments, refunds, credits, audits, fee plans, versions ... Any new disclosure to any of
 *     those roles fails here, whatever the collection.
 *  3. Finance and Nutrition Pro (formerly held to a frozen superset of an over-exposure, P1-01) are
 *     now covered by the same EXACT matrix, from the Phase 2.3 policy: Finance receives money
 *     records plus the bare billing roster (player names); Nutrition Pro receives only the players
 *     assigned to them and those players' nutrition records. The six tests that used to be `todo`
 *     proposals are ordinary, passing tests with their assertions unchanged.
 *  4. A value-free snapshot of every key path per role, with every collection populated, makes any
 *     change in what a role receives an explicit diff (record with UPDATE_SNAPSHOTS=1).
 *  5. A coverage guard fails if any collection is empty for every role, so a blind spot cannot
 *     return unnoticed.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("role-payload");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
type Payload = Record<string, unknown>;
async function payload(key: FixtureUserKey) {
  const response = await (await app.as(key)).get("/api/academy");
  assert.equal(response.status, 200, key);
  return response.json as Payload;
}
type Kind = keyof typeof CANARY.childA;
type SubjectKey = "childA" | "childB" | "adult" | "blue";
const SUBJECTS: SubjectKey[] = ["childA", "childB", "adult", "blue"];
const FULL = Object.keys(CANARY.childA) as Kind[];
const ADULT = Object.keys(CANARY.adult) as Kind[];
const minus = (from: readonly Kind[], ...drop: Kind[]) =>
  from.filter((k) => !drop.includes(k));
/** Which canary kinds of each subject occur anywhere in the serialised payload. */
function visibleKinds(p: Payload) {
  const text = JSON.stringify(p);
  const out: Partial<Record<SubjectKey, Kind[]>> = {};
  for (const s of SUBJECTS) {
    const kinds = (Object.entries(CANARY[s]) as [Kind, string][])
      .filter(([, value]) => text.includes(value))
      .map(([k]) => k);
    if (kinds.length) out[s] = kinds.sort();
  }
  return out;
}
const sorted = (kinds: readonly Kind[]) => [...kinds].sort();
const restricted: Kind[] = ["allergy", "question"];
const money: Kind[] = [
  "invoice",
  "feePlan",
  "paymentRef",
  "refundReason",
  "creditReason",
];
// Reviewed, current behaviour. Owners/admins see everything except family-restricted nutrition.
const OPS_A = minus(FULL, ...restricted);
const OPS_B = minus(FULL, ...restricted, "template", "feePlan"); // template and fee plan belong to the first child's set
const COACHING_A = minus(FULL, ...restricted, ...money, "auditAction");
const FAMILY = minus(
  FULL,
  "notes",
  "reportDraft",
  "nutritionDraft",
  "history",
  "sessionNote",
  "sessionRecap",
  "reviewText",
  "goal",
  "template",
  "feePlan",
  "mediaPrivate",
  "mediaPrivateFeedback",
  "auditAction",
);
const NUTRITION_SCOPE: Kind[] = [
  "name",
  "allergy",
  "question",
  "nutritionShared",
  "nutritionDraft",
];
const EXACT: Partial<
  Record<FixtureUserKey, Partial<Record<SubjectKey, Kind[]>>>
> = {
  owner: { childA: OPS_A, childB: OPS_B, adult: ADULT },
  admin: { childA: OPS_A, childB: OPS_B, adult: ADULT },
  headCoach: {
    childA: [...minus(COACHING_A), "auditAction"],
    childB: [...minus(COACHING_A, "template"), "auditAction"],
    adult: ADULT,
  },
  coach: { childA: COACHING_A, adult: ADULT },
  // FINANCE: names for billing and every money record; nothing else about any player.
  finance: {
    childA: ["name", ...money],
    childB: ["name", ...minus(money, "feePlan")],
    adult: ["name"],
  },
  // NUTRITION_PRO: only assigned players. `nutrition` has ALPHA (and a withdrawn BRAVO
  // assignment, which grants nothing); `nutrition2` has BRAVO; neither sees the adult.
  nutrition: { childA: NUTRITION_SCOPE },
  nutrition2: { childB: NUTRITION_SCOPE },
  blueNutrition: { blue: NUTRITION_SCOPE },
  guardian: { childA: FAMILY },
  adult: { adult: minus(ADULT, "notes", "history") },
  blueOwner: { blue: OPS_A },
  blueCoach: { blue: COACHING_A },
  blueGuardian: { blue: FAMILY },
  quietOwner: {},
};
const all = (...s: Record<string, string>[]) => s.flatMap(canaryValues);
const pick = (s: Record<string, string>, ...kinds: Kind[]) =>
  kinds.map((k) => s[k]);
const enquiry = Object.values(CANARY.enquiry);
const emailsExcept = (...keep: FixtureUserKey[]) =>
  (Object.keys(USERS) as FixtureUserKey[])
    .filter((k) => !keep.includes(k))
    .map((k) => USERS[k].email);
test(
  "the exact canary-visibility matrix holds for every reviewed role, across every collection",
  { timeout: TEST_TIMEOUT },
  async () => {
    for (const [key, expected] of Object.entries(EXACT) as [
      FixtureUserKey,
      (typeof EXACT)[FixtureUserKey],
    ][]) {
      const actual = visibleKinds(await payload(key));
      const want = Object.fromEntries(
        Object.entries(expected ?? {}).map(([s, k]) => [
          s,
          sorted(k as Kind[]),
        ]),
      );
      assert.deepEqual(
        actual,
        want,
        `${key}: visible canary kinds differ from the reviewed matrix`,
      );
    }
  },
);
test(
  "positive controls: finance and nutrition keep the data their jobs need",
  { timeout: TEST_TIMEOUT },
  async () => {
    assertPresent(
      await payload("finance"),
      pick(
        CANARY.childA,
        "invoice",
        "feePlan",
        "paymentRef",
        "refundReason",
        "creditReason",
      ),
      "FINANCE",
    );
    assertPresent(
      await payload("nutrition"),
      pick(
        CANARY.childA,
        "allergy",
        "question",
        "nutritionShared",
        "nutritionDraft",
      ),
      "NUTRITION_PRO",
    );
  },
);
test(
  "GUARDIAN receives only their own child's family-safe data, in every collection",
  { timeout: TEST_TIMEOUT },
  async () => {
    const p = await payload("guardian");
    assertNoLeak(
      p,
      all(CANARY.childB, CANARY.adult, CANARY.blue),
      "GUARDIAN: other players",
    );
    assertNoLeak(p, enquiry, "GUARDIAN: enquiries");
    assertNoLeak(p, emailsExcept("guardian"), "GUARDIAN: other accounts");
    // Staff-only material about their own child, per collection.
    assertNoLeak(
      p,
      pick(
        CANARY.childA,
        "notes",
        "reportDraft",
        "nutritionDraft",
        "history",
        "sessionNote",
        "sessionRecap",
        "reviewText",
        "goal",
        "template",
        "mediaPrivate",
        "mediaPrivateFeedback",
        "auditAction",
      ),
      "GUARDIAN: staff-only records",
    );
    const sessions = p.sessions as {
      data: { observations: unknown[]; recap: string; roster: unknown[] };
    }[];
    assert.ok(sessions.length === 1);
    assert.deepEqual(
      [
        sessions[0].data.observations,
        sessions[0].data.roster,
        sessions[0].data.recap,
      ],
      [[], [], ""],
      "family session rows must be stripped of coach observations, roster and recap",
    );
    const second = await payload("guardian2");
    assertNoLeak(
      second,
      all(CANARY.childA, CANARY.adult, CANARY.blue),
      "GUARDIAN 2: other players",
    );
    assertPresent(
      second,
      pick(CANARY.childB, "name", "sessionObjective", "mediaShared"),
      "GUARDIAN 2 own child",
    );
  },
);
test(
  "other tenants and the empty academy never receive green data (and vice versa)",
  { timeout: TEST_TIMEOUT },
  async () => {
    const green = [
      ...all(CANARY.childA, CANARY.childB, CANARY.adult),
      ...enquiry,
      ...emailsExcept(
        "blueOwner",
        "blueCoach",
        "blueGuardian",
        "blueNutrition",
        "quietOwner",
      ),
    ];
    for (const key of [
      "blueOwner",
      "blueCoach",
      "blueGuardian",
      "blueNutrition",
      "quietOwner",
    ] as const)
      assertNoLeak(await payload(key), green, key);
    const blue = [
      ...all(CANARY.blue),
      USERS.blueOwner.email,
      USERS.blueCoach.email,
      USERS.blueGuardian.email,
      USERS.blueNutrition.email,
    ];
    for (const key of [
      "owner",
      "admin",
      "headCoach",
      "coach",
      "finance",
      "nutrition",
      "guardian",
      "guardian2",
      "adult",
      "quietOwner",
    ] as const)
      assertNoLeak(
        await payload(key),
        blue,
        `${key} must not see the blue academy`,
      );
  },
);
test(
  "a brand-new academy returns well-formed, completely empty collections",
  { timeout: TEST_TIMEOUT },
  async () => {
    const p = await payload("quietOwner");
    const arrays = Object.entries(p).filter(([, v]) => Array.isArray(v));
    assert.ok(arrays.length >= 25, "expected the full set of collections");
    for (const [name, value] of arrays) {
      if (name === "members")
        assert.equal((value as unknown[]).length, 1, "only the owner");
      else
        assert.deepEqual(
          value,
          [],
          `${name} must be an empty array, not missing or null`,
        );
    }
    assertShape("QUIET_OWNER", p);
  },
);
test(
  "coverage guard: every collection in the payload is populated for at least one role",
  { timeout: TEST_TIMEOUT },
  async () => {
    const populated = new Set<string>();
    const collections = new Set<string>();
    for (const key of Object.keys(USERS) as FixtureUserKey[]) {
      if (key === "quietOwner") continue;
      for (const [name, value] of Object.entries(await payload(key)))
        if (Array.isArray(value)) {
          collections.add(name);
          if (value.length) populated.add(name);
        }
    }
    const blind = [...collections].filter((c) => !populated.has(c));
    assert.deepEqual(
      blind,
      [],
      `collections with no fixture data (undetectable fields): ${blind.join(", ")}`,
    );
    for (const required of [
      "sessions",
      "reviews",
      "goals",
      "messages",
      "deliveries",
      "templates",
      "media",
      "payments",
      "refunds",
      "credits",
      "audits",
      "feePlans",
      "assignments",
    ])
      assert.ok(populated.has(required), `${required} must be populated`);
  },
);
/*
 * POLICY (Phase 2.3, resolves PHASE1_FINDINGS P1-01). These six tests were `todo` proposals while
 * the read model over-shared; the policy is now implemented, so they run as ordinary tests with the
 * original assertions untouched:
 *   FINANCE       no profile data, clinical/operational records, member e-mails, or consent links
 *   NUTRITION_PRO the same, and only for players assigned to them
 */
const profilePrivate = (s: Record<string, string>) =>
  pick(s, "notes", "phone", "email", "birthDate");
test(
  "FINANCE must not receive player contact details, notes or birth dates",
  { timeout: TEST_TIMEOUT },
  async () => {
    const p = await payload("finance");
    assertNoLeak(
      p,
      [CANARY.childA, CANARY.childB, CANARY.adult].flatMap(profilePrivate),
      "FINANCE profile data",
    );
  },
);
test(
  "FINANCE must not receive report revisions, player history, events or other accounts' emails",
  { timeout: TEST_TIMEOUT },
  async () => {
    const p = await payload("finance");
    assertNoLeak(
      p,
      [CANARY.childA, CANARY.childB].flatMap((s) =>
        pick(s, "reportDraft", "reportPublished", "history", "event"),
      ),
      "FINANCE clinical/operational data",
    );
    assertNoLeak(p, emailsExcept("finance"), "FINANCE: member emails");
  },
);
test(
  "FINANCE must not receive nutrition plans (they currently arrive through revision history)",
  { timeout: TEST_TIMEOUT },
  async () => {
    const p = await payload("finance");
    assertNoLeak(
      p,
      [CANARY.childA, CANARY.childB].flatMap((s) =>
        pick(s, "nutritionShared", "nutritionDraft"),
      ),
      "FINANCE nutrition plans",
    );
  },
);
test(
  "NUTRITION_PRO must not receive player contact details, notes or birth dates",
  { timeout: TEST_TIMEOUT },
  async () => {
    const p = await payload("nutrition");
    assertNoLeak(
      p,
      [CANARY.childA, CANARY.childB, CANARY.adult].flatMap(profilePrivate),
      "NUTRITION_PRO profile data",
    );
  },
);
test(
  "NUTRITION_PRO must not receive report revisions, history, events or other accounts' emails",
  { timeout: TEST_TIMEOUT },
  async () => {
    const p = await payload("nutrition");
    assertNoLeak(
      p,
      [CANARY.childA, CANARY.childB].flatMap((s) =>
        pick(s, "reportDraft", "reportPublished", "history", "event"),
      ),
      "NUTRITION_PRO clinical/operational data",
    );
    assertNoLeak(p, emailsExcept("nutrition"), "NUTRITION_PRO: member emails");
  },
);
test(
  "FINANCE and NUTRITION_PRO must not receive guardian consent records",
  { timeout: TEST_TIMEOUT },
  async () => {
    for (const key of ["finance", "nutrition"] as const) {
      const p = await payload(key);
      assert.deepEqual(p.guardianLinks, [], `${key} guardianLinks`);
    }
  },
);
test(
  "key-path snapshot of the response for each role, every collection populated (change = reviewed diff)",
  { timeout: TEST_TIMEOUT },
  async () => {
    for (const role of ROLES as readonly Role[])
      assertShape(role, await payload(ROLE_USER[role]));
  },
);
