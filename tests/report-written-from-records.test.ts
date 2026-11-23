import assert from "node:assert/strict";
import test from "node:test";
import { writeFromRecords } from "../src/modules/reports/domain/batch-rules";

const evidence = [
  { date: "2026-10-01", title: "Footwork", attendance: "PRESENT" as const, practised: [{ title: "Shadow footwork", skill: "Movement" }], observationDetails: [{ text: "Kept a low ready position.", category: "TECHNICAL" }] },
  { date: "2026-10-03", title: "Net play", attendance: "ABSENT" as const, practised: [] },
  { date: "2026-10-06", title: "Serve", attendance: "EXCUSED" as const, practised: [] },
];

test("a report written from the records states counts, activities and recorded observations", () => {
  const out = writeFromRecords({ playerName: "Diya Sharma", periodStart: "2026-10-01", periodEnd: "2026-10-31", evidence });
  assert.match(out.summary, /Diya attended 1 of 3 recorded sessions/);
  assert.match(out.strengths, /present at 1 session of the 3 recorded sessions/);
  assert.match(out.strengths, /Shadow footwork \(1\)/);
  assert.match(out.strengths, /technical: Kept a low ready position\./);
  assert.doesNotMatch(out.strengths, /\.\./);
  assert.match(out.improvements, /1 absent \(2026-10-03\), 1 excused \(2026-10-06\)/);
});

test("it never praises, scores or predicts", () => {
  const out = writeFromRecords({ playerName: "Diya Sharma", periodStart: "2026-10-01", periodEnd: "2026-10-31", evidence });
  assert.doesNotMatch(`${out.summary} ${out.strengths} ${out.improvements}`, /excellent|great|improved|struggl|outstanding|poor|should/i);
});

test("a player with no missed sessions is told so", () => {
  const out = writeFromRecords({ playerName: "Kabir", periodStart: "2026-10-01", periodEnd: "2026-10-31", evidence: [evidence[0]] });
  assert.match(out.improvements, /No missed sessions were recorded/);
});
