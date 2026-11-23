import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
/**
 * Reusable assertions for API responses.
 *
 *  - `leaksIn` / `assertNoLeak` / `assertPresent`: substring search of the serialised response for
 *    canary values (fails if sensitive data is returned to a role that must not receive it, and
 *    its positive twin proves a canary is actually reachable so "absent" is meaningful).
 *  - `shapeOf` / `assertShape`: a value-free snapshot of every key path in a response, per role,
 *    so any change to what a role receives shows up as an explicit, reviewable diff.
 */
export const leaksIn = (payload: unknown, values: readonly string[]) => {
  const text = JSON.stringify(payload);
  return values.filter((value) => text.includes(value));
};
export function assertNoLeak(
  payload: unknown,
  values: readonly string[],
  context: string,
) {
  assert.deepEqual(
    leaksIn(payload, values),
    [],
    `${context}: response contains values it must not disclose`,
  );
}
export function assertPresent(
  payload: unknown,
  values: readonly string[],
  context: string,
) {
  const missing = values.filter((v) => !leaksIn(payload, [v]).length);
  assert.deepEqual(missing, [], `${context}: expected values are missing`);
}
export function shapeOf(payload: unknown) {
  const paths = new Set<string>();
  const walk = (value: unknown, path: string) => {
    if (value === null) paths.add(`${path}:null`);
    else if (Array.isArray(value)) {
      paths.add(`${path}:array`);
      value.forEach((item) => walk(item, `${path}[]`));
    } else if (typeof value === "object")
      for (const [key, item] of Object.entries(value))
        walk(item, `${path}.${key}`);
    else paths.add(`${path}:${typeof value}`);
  };
  walk(payload, "$");
  return [...paths].sort();
}
const SNAPSHOT = resolve("tests/__snapshots__/role-payload.shapes.json");
const read = (): Record<string, string[]> =>
  existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, "utf8")) : {};
/**
 * Compares a response's key paths with the recorded snapshot for `name`.
 * Review changes deliberately, then record them with UPDATE_SNAPSHOTS=1.
 */
export function assertShape(name: string, payload: unknown) {
  const actual = shapeOf(payload);
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    const all = read();
    all[name] = actual;
    mkdirSync(dirname(SNAPSHOT), { recursive: true });
    writeFileSync(
      SNAPSHOT,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(all).sort(([a], [b]) => a.localeCompare(b)),
        ),
        null,
        1,
      ) + "\n",
    );
    return;
  }
  const expected = read()[name];
  assert.ok(
    expected,
    `No snapshot recorded for "${name}". Run with UPDATE_SNAPSHOTS=1 after reviewing the response.`,
  );
  const added = actual.filter((p) => !expected.includes(p));
  const removed = expected.filter((p) => !actual.includes(p));
  assert.ok(
    !added.length && !removed.length,
    `${name}: response shape changed.\n  added:   ${added.slice(0, 15).join(", ") || "-"}\n  removed: ${removed.slice(0, 15).join(", ") || "-"}`,
  );
}
