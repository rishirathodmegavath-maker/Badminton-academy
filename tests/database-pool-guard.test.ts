import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { guardPool } from "../src/infrastructure/database/pool-guard";

// A pool that never connects: only its event behaviour is under test (the real driver class, not a stand-in).
const unconnected = () => new Pool({ connectionString: "postgres://nobody:nothing@127.0.0.1:1/none" });

test("without the guard an idle-connection failure is an uncaught exception (the defect this guards against)", async () => {
  const pool = unconnected();
  try {
    assert.throws(() => pool.emit("error", new Error("idle client lost")), /idle client lost/);
  } finally {
    await pool.end();
  }
});

test("with the guard the failure is logged by name and code only, and never throws or leaks the message", async () => {
  const pool = guardPool(unconnected(), { error: (...a: unknown[]) => lines.push(a.join(" ")) });
  const lines: string[] = [];
  try {
    const failure = Object.assign(new Error("connect failed postgres://user:hunter2@db.internal/app"), { code: "ECONNRESET" });
    assert.doesNotThrow(() => pool.emit("error", failure));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /ECONNRESET/);
    assert.doesNotMatch(lines[0], /hunter2|postgres:\/\//);
  } finally {
    await pool.end();
  }
});
