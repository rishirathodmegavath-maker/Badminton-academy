import { request, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The fictional development accounts used by the Phase 9 browser tests (one per role). ADMIN and FINANCE are
 * added to a DISPOSABLE copy of the development database by scripts/seed-e2e-roles.ts; the others come from the
 * normal development seeds. Passwords come from DEV_SEED_PASSWORD and are never written to a report.
 */
export const ROLE_ACCOUNTS = {
  OWNER: "admin@greenfield.example",
  ADMIN: "admin2@greenfield.example",
  HEAD_COACH: "headcoach@greenfield.example",
  COACH: "aman@greenfield.example",
  FINANCE: "finance@greenfield.example",
  NUTRITION_PRO: "nutrition@greenfield.example",
  GUARDIAN: "priya@greenfield.example",
  GUARDIAN_TWO: "raj@greenfield.example",
} as const;
export type RoleKey = keyof typeof ROLE_ACCOUNTS;

export const base = () => process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3100";
// The profile runner gives each run its own cache folder (and removes it afterwards); a developer without one shares a temp folder.
const dir = process.env.E2E_AUTH_CACHE_DIR || join(tmpdir(), "sportozen-e2e-auth");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Signs a role in once and caches the session cookies on disk (the sign-in endpoint is rate limited to a few
 * attempts a minute per client, and we do not weaken that for tests). A 429 waits for the window and retries.
 */
export async function sessionFor(role: RoleKey): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${role}.json`);
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (Date.now() - saved.savedAt < 20 * 60_000) {
      // A test may have signed this person out (revoking the session): only reuse one the server still accepts.
      const probe = await request.newContext({ baseURL: base(), storageState: { cookies: saved.cookies, origins: saved.origins } });
      let alive = false;
      try {
        const r = await probe.get("/api/auth/get-session");
        const body = r.ok() ? (await r.text()).trim() : "";
        alive = body.length > 0 && body !== "null";
      } catch {
        alive = false;
      }
      await probe.dispose();
      if (alive) return file;
    }
  }
  const api = await request.newContext({ baseURL: base() });
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await api.post("/api/auth/sign-in/email", {
        headers: { origin: base() },
        data: { email: ROLE_ACCOUNTS[role], password: process.env.DEV_SEED_PASSWORD },
        timeout: 60_000,
      });
      if (response.ok()) {
        const state = await api.storageState();
        writeFileSync(file, JSON.stringify({ ...state, savedAt: Date.now() }));
        return file;
      }
      if (response.status() !== 429) throw new Error(`Sign-in for ${role} failed with HTTP ${response.status()}`);
      await sleep(15_000);
    }
    throw new Error(`Sign-in for ${role} stayed rate limited`);
  } finally {
    await api.dispose();
  }
}

/** Playwright `storageState` object for a role (reads the cached session). */
export async function stateFor(role: RoleKey) {
  const file = await sessionFor(role);
  const { cookies, origins } = JSON.parse(readFileSync(file, "utf8"));
  return { cookies, origins };
}

/** An API client that carries the role's session, for direct (non-UI) permission checks. */
export async function apiFor(role: RoleKey): Promise<APIRequestContext> {
  return request.newContext({ baseURL: base(), storageState: await stateFor(role) });
}

export async function loginContext(context: BrowserContext, role: RoleKey) {
  const { cookies } = await stateFor(role);
  await context.addCookies(cookies);
}
