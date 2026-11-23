import assert from "node:assert/strict";
import test from "node:test";
import {
  BADMINTON_CATALOGUE,
  DRILL_CATEGORIES,
  categorySummary,
  findCatalogueDrill,
} from "../src/modules/training/domain/catalogue";
import { SKILL_GROUPS } from "../src/modules/reports/domain/report-sheet";

test("the badminton library holds exactly 50 drills, numbered 1 to 50", () => {
  assert.equal(BADMINTON_CATALOGUE.length, 50);
  assert.deepEqual(
    BADMINTON_CATALOGUE.map((d) => d.number),
    Array.from({ length: 50 }, (_, i) => i + 1),
  );
  assert.equal(new Set(BADMINTON_CATALOGUE.map((d) => d.id)).size, 50);
  assert.equal(new Set(BADMINTON_CATALOGUE.map((d) => d.title)).size, 50);
});

test("the five groups hold 10, 10, 10, 5 and 15 drills", () => {
  assert.deepEqual(
    categorySummary().map((c) => [c.id, c.initialCount, c.publishedCount]),
    [
      ["footwork", 10, 10],
      ["feeding", 10, 10],
      ["rally", 10, 10],
      ["solo", 5, 5],
      ["fitness", 15, 15],
    ],
  );
  const ids = new Set<string>(DRILL_CATEGORIES.map((c) => c.id));
  for (const d of BADMINTON_CATALOGUE) assert.ok(ids.has(d.category!), d.id);
});

test("every drill is fully written, in one of the known skills", () => {
  const skills = new Set<string>(SKILL_GROUPS.map((g) => g.skill));
  for (const d of BADMINTON_CATALOGUE) {
    const where = `${d.number} ${d.title}`;
    assert.equal(d.academyId, null, where);
    assert.ok(skills.has(d.skill), `${where}: skill ${d.skill}`);
    assert.ok(["Beginner", "Intermediate", "Advanced"].includes(d.level), where);
    assert.ok(["Singles", "Doubles", "Both"].includes(d.format), where);
    assert.ok(d.minutes >= 3 && d.minutes <= 30, where);
    assert.ok(d.players >= 1 && d.players <= 8, where);
    assert.ok(d.equipment.length >= 1, where);
    for (const field of ["objective", "setup", "easier", "harder"] as const)
      assert.ok(d[field].trim().length >= 15, `${where}: ${field}`);
    assert.ok(d.steps.length >= 3, `${where}: steps`);
    assert.ok(d.cues.length >= 2, `${where}: cues`);
    assert.ok(d.mistakes.length >= 2, `${where}: mistakes`);
    assert.ok((d.safety?.length ?? 0) >= 2, `${where}: safety`);
    for (const line of [...d.steps, ...d.cues, ...d.mistakes, ...(d.safety ?? [])])
      assert.ok(line.trim().length > 3, `${where}: empty line`);
    assert.match(d.review, /coach review required/, where);
    assert.match(d.source ?? "", /original to Sportozen/i, where);
  }
});

test("off-court strength drills carry a suggested minimum age and a load or landing safety line", () => {
  const off = BADMINTON_CATALOGUE.filter((d) => d.category === "fitness");
  assert.equal(off.length, 15);
  for (const d of off) {
    assert.ok((d.minimumAge ?? 0) >= 6, `${d.title} has a minimum age`);
    assert.equal(d.skill, "Fitness", d.title);
  }
  for (const title of [
    "Box jumps",
    "Single-leg pistol squats",
    "Multi-direction weighted lunges",
  ])
    assert.ok(
      (off.find((d) => d.title === title)?.minimumAge ?? 0) >= 12,
      title,
    );
});

test("the catalogue makes no medical or guaranteed-result claims", () => {
  const banned = /\b(cure|guarantee|prevent[s]? injur|rehab|diagnos|treat)/i;
  for (const d of BADMINTON_CATALOGUE) {
    const text = [d.objective, d.setup, d.easier, d.harder, ...d.steps, ...d.cues, ...(d.safety ?? [])].join(" ");
    assert.doesNotMatch(text, banned, d.title);
  }
});

test("a drill is found by id and version, and an unknown one is not", () => {
  assert.equal(findCatalogueDrill("bd-01", 1)?.title, "Six-corner shadow footwork");
  assert.equal(findCatalogueDrill("bd-01", 2), undefined);
  assert.equal(findCatalogueDrill("bd-51"), undefined);
});
