import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  containersWithLabel,
  dockerAvailable,
  withDisposablePostgres,
} from "../scripts/lib/disposable-postgres";
import { TEST_TIMEOUT } from "./helpers/paths";
/**
 * The disposable-container lifecycle: the container must be gone after success, an exception, a
 * readiness failure, an overall timeout, and a SIGINT/SIGTERM. Needs Docker; reported as SKIPPED
 * (never passed) when it is unavailable.
 */
const docker = dockerAvailable();
const skip = docker ? false : "Docker is not available";
const hasImage = (image: string) =>
  docker &&
  spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" })
    .status === 0;
const exists = (name: string) => containersWithLabel().includes(name);
/** Only containers created by THIS file are judged (the outer test:pg container shares the label). */
const created: string[] = [];
test(
  "the container is removed after a successful run",
  { skip, timeout: TEST_TIMEOUT },
  async () => {
    let name = "";
    const result = await withDisposablePostgres(async (pg) => {
      name = pg.name;
      created.push(name);
      assert.ok(exists(name), "container should be running during the run");
      assert.match(
        pg.url,
        /^postgres:\/\/postgres:[0-9a-f]+@127\.0\.0\.1:\d+\/postgres$/,
      );
      return "done";
    });
    assert.equal(result, "done");
    assert.equal(exists(name), false);
  },
);
test(
  "the container is removed when the work throws",
  { skip, timeout: TEST_TIMEOUT },
  async () => {
    let name = "";
    await assert.rejects(
      withDisposablePostgres(async (pg) => {
        name = pg.name;
        created.push(name);
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(exists(name), false);
  },
);
test(
  "a container that never becomes ready is removed (original leak)",
  {
    skip:
      skip ||
      (hasImage("nginx:stable") ? false : "nginx:stable not available locally"),
    timeout: TEST_TIMEOUT,
  },
  async () => {
    const before = new Set(containersWithLabel());
    await assert.rejects(
      withDisposablePostgres(async () => "unreachable", {
        image: "nginx:stable",
        readyTimeoutMs: 3000,
      }),
      /did not become ready/,
    );
    assert.deepEqual(
      containersWithLabel().filter((n) => !before.has(n)),
      [],
    );
  },
);
test(
  "an overall timeout aborts the work and removes the container",
  { skip, timeout: TEST_TIMEOUT },
  async () => {
    let name = "";
    let aborted = false;
    await assert.rejects(
      withDisposablePostgres(
        async (pg, signal) => {
          name = pg.name;
          created.push(name);
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            }),
          );
        },
        { totalTimeoutMs: 2_000 },
      ),
      /timed out/,
    );
    assert.ok(aborted, "the work must be told to stop");
    assert.equal(exists(name), false);
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  test(
    `${signal} removes the container and exits with the conventional code`,
    { skip, timeout: TEST_TIMEOUT },
    async () => {
      let name = "";
      const exits: number[] = [];
      const before = process.listenerCount(signal);
      await assert.rejects(
        withDisposablePostgres(
          async (pg, abort) => {
            name = pg.name;
            created.push(name);
            assert.equal(process.listenerCount(signal), before + 1);
            // Deliver the signal to the handler exactly as the OS would (without ending the test runner).
            setTimeout(() => process.emit(signal), 50);
            await new Promise<void>((_, reject) =>
              abort.addEventListener("abort", () => reject(abort.reason)),
            );
          },
          { exit: (code) => exits.push(code) },
        ),
        new RegExp(signal),
      );
      assert.deepEqual(exits, [signal === "SIGINT" ? 130 : 143]);
      assert.equal(exists(name), false);
      assert.equal(
        process.listenerCount(signal),
        before,
        "signal handler leaked",
      );
    },
  );
test("no container created by this file is left behind", { skip }, () => {
  assert.ok(
    created.length >= 5,
    "the scenarios above must have created containers",
  );
  assert.deepEqual(created.filter(exists), []);
});
