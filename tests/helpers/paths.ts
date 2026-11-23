import { fileURLToPath } from "node:url";
import { join } from "node:path";
/**
 * Every test path is anchored to the repository, never to the caller's working directory, so the
 * suite behaves identically from the repo root, a subdirectory, an IDE or CI.
 */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const repoPath = (...parts: string[]) => join(REPO_ROOT, ...parts);
export const DATA_DIR = repoPath(".data");
export const MIGRATIONS_DIR = repoPath("migrations");
export const SNAPSHOT_FILE = repoPath(
  "tests",
  "__snapshots__",
  "role-payload.shapes.json",
);
/** Per-test and per-hook ceilings (ms): a hung server must fail the run, not freeze it. */
export const TEST_TIMEOUT = 240_000;
export const HOOK_TIMEOUT = 240_000;
