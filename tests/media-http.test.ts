import { test } from "node:test";
import assert from "node:assert/strict";
import { privateMediaResponse } from "../src/modules/media/application/http";
test("private video responses honour bounded and suffix ranges and reject invalid seeks", async () => {
  const file = {
    bytes: new Uint8Array([10, 11, 12, 13, 14]),
    metadata: { mime: "video/webm", name: "test.webm" },
  };
  const partial = privateMediaResponse(file, "bytes=1-3");
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 1-3/5");
  assert.deepEqual(
    [...new Uint8Array(await partial.arrayBuffer())],
    [11, 12, 13],
  );
  assert.equal(partial.headers.get("cache-control"), "private, no-store");
  const suffix = privateMediaResponse(file, "bytes=-2");
  assert.deepEqual([...new Uint8Array(await suffix.arrayBuffer())], [13, 14]);
  for (const range of [
    "bytes=5-",
    "bytes=4-1",
    "bytes=-0",
    "bytes=1-2,3-4",
    "bytes=-",
  ]) {
    const response = privateMediaResponse(file, range);
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), "bytes */5");
  }
  const full = privateMediaResponse(file, null);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-length"), "5");
});
