import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { assertDisposablePath } from "./helpers/test-database";
import { DATA_DIR, REPO_ROOT } from "./helpers/paths";

/**
 * Test databases are always new `<label>-<random>` folders directly under .data. The development
 * database lives in `.data/development` and must be unreachable from any test helper.
 */
test("fresh <label>-<random> folders directly under .data are accepted", () => {
  for (const name of ["ops-0123456789ab", "training-fedcba987654", "access-audit-0a1b2c3d4e5f"])
    assert.equal(assertDisposablePath(join(DATA_DIR, name)), join(DATA_DIR, name));
});

test("the development database and anything outside a fresh .data folder are refused", () => {
  const refused = [
    join(DATA_DIR, "development"),
    join(DATA_DIR, "development", "base"),
    join(DATA_DIR, "development-0123456789ab", "nested"),
    join(DATA_DIR, "ops"),
    join(DATA_DIR, "ops-123"),
    join(DATA_DIR, "ops-0123456789ABCD"),
    DATA_DIR,
    REPO_ROOT,
    join(REPO_ROOT, "development"),
    join(DATA_DIR, "..", "ops-0123456789ab"),
    "C:\\temp\\ops-0123456789ab",
    "/tmp/ops-0123456789ab",
    "",
  ];
  for (const path of refused)
    assert.throws(() => assertDisposablePath(path), /Refusing to use/, path);
});

test("a custom data directory is honoured and the same rules apply", () => {
  const dir = join(REPO_ROOT, "elsewhere");
  assert.doesNotThrow(() => assertDisposablePath(join(dir, "x-0123456789ab"), dir));
  assert.throws(() => assertDisposablePath(join(DATA_DIR, "x-0123456789ab"), dir), /Refusing/);
});
