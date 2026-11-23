import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "../src/infrastructure/database/schema";
import { runMigrations } from "../src/infrastructure/database/migrations";
import { adminUrl, createPostgresDatabase } from "./helpers/test-database";
import { HOOK_TIMEOUT } from "./helpers/paths";
import {
  dispatchAuthEmailOutbox,
  enqueueAuthEmail,
  hashEmailRecipient,
  hashVerificationSecret,
  ResendEmailProvider,
  sealEmailPayload,
  unsealEmailPayload,
  verifyVerificationSecret,
  type EmailSendResult,
  type TransactionalEmailMessage,
  type TransactionalEmailProvider,
} from "../src/infrastructure/email";

const SECRET = "V9nK2pL6xR8wQ4mT7zB5cF1hJ3dG0sY2aE8uP4vN6kM=";
const ALT_SECRET = "A1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2xY3zZ4aB=";
const cleanups: (() => Promise<void> | void)[] = [];
after(
  async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  },
  { timeout: HOOK_TIMEOUT },
);

async function freshPgliteDb() {
  const dir = mkdtempSync(join(tmpdir(), "sportozen-outbox-"));
  const path = join(dir, "db");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  await runMigrations({ target: { kind: "pglite", path } });
  const client = new PGlite(path);
  cleanups.push(() => client.close());
  return drizzle(client, { schema });
}

const admin = adminUrl();
const PG_ONLY = admin ? false : "TEST_POSTGRES_ADMIN_URL not set — run `npm run test:pg`";

async function freshPostgresDb() {
  const created = await createPostgresDatabase(admin!);
  cleanups.push(created.drop);
  await runMigrations({ target: { kind: "postgres", url: created.url } });
  const pool = new Pool({ connectionString: created.url });
  cleanups.push(() => pool.end());
  return postgresDrizzle(pool, { schema }) as unknown as ReturnType<typeof drizzle<typeof schema>>;
}

test("keyed HMAC verification hashes differ from plain SHA-256 and enforce domain/context binding", () => {
  const otp = "482913";
  const plainSha256 = createHash("sha256").update(otp).digest("hex");
  const otpHash = hashVerificationSecret("email-otp", otp, "user-1", SECRET);

  assert.ok(otpHash.startsWith("hmac-sha256:v1:"));
  assert.ok(!otpHash.includes(plainSha256), "never plain unsalted SHA-256");
  assert.ok(!otpHash.includes(otp), "never plaintext OTP");
  assert.equal(verifyVerificationSecret(otpHash, "email-otp", otp, "user-1", SECRET), true);

  // Wrong code, wrong user context, cross-purpose replay, and wrong server secret all fail closed.
  assert.equal(verifyVerificationSecret(otpHash, "email-otp", "482914", "user-1", SECRET), false);
  assert.equal(verifyVerificationSecret(otpHash, "email-otp", otp, "user-2", SECRET), false);
  assert.equal(verifyVerificationSecret(otpHash, "reset-token", otp, "user-1", SECRET), false);
  assert.equal(verifyVerificationSecret(otpHash, "email-otp", otp, "user-1", ALT_SECRET), false);
  assert.equal(verifyVerificationSecret("plain:" + plainSha256, "email-otp", otp, "user-1", SECRET), false);
  assert.throws(() => hashVerificationSecret("email-otp", otp, "user-1", "short"), /at least 32/);
});

test("AES-256-GCM outbox sealing hides OTP/recipient and detects tampering", () => {
  const payload = {
    to: "player@example.test",
    subject: "Verify your Sportozen email",
    text: "Your code is 654321",
  };
  const sealed = sealEmailPayload(payload, SECRET);
  assert.ok(!sealed.includes("player@example.test"));
  assert.ok(!sealed.includes("654321"));

  const unsealed = unsealEmailPayload(sealed, SECRET);
  assert.deepEqual(unsealed, payload);

  assert.throws(() => unsealEmailPayload(sealed, ALT_SECRET), /Unable to decrypt/);
  const tampered = sealed.slice(0, -4) + "AAAA";
  assert.throws(() => unsealEmailPayload(tampered, SECRET), /Unable to decrypt/);

  const h1 = hashEmailRecipient("Player@Example.test ", SECRET);
  const h2 = hashEmailRecipient("player@example.test", SECRET);
  assert.equal(h1, h2);
  assert.ok(!h1.includes("player@example.test"));
});

test("Resend adapter handles 200, 429 retryable, 5xx retryable, 4xx permanent, network timeout without leaking secrets", async () => {
  const apiKey = "re_secret_api_key_do_not_leak";
  const from = "Sportozen <no-reply@sportozen.example>";
  const sentHeaders: Record<string, string>[] = [];

  const mockFetch = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (async (_url: unknown, init?: RequestInit) => {
      sentHeaders.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify(body), { status, headers });
    }) as typeof fetch;

  const msg: TransactionalEmailMessage = {
    to: "user@example.test",
    subject: "Code",
    text: "OTP 112233",
    idempotencyKey: "verify:u1:1",
    kind: "EMAIL_VERIFICATION_OTP",
  };

  {
    const provider = new ResendEmailProvider({ apiKey, from, fetchImpl: mockFetch(200, { id: "msg_123" }) });
    const res = await provider.send(msg);
    assert.deepEqual(res, { ok: true, providerMessageId: "msg_123" });
    assert.equal(sentHeaders[0].Authorization, `Bearer ${apiKey}`);
    assert.equal(sentHeaders[0]["Idempotency-Key"], "verify:u1:1");
  }
  {
    const provider = new ResendEmailProvider({
      apiKey,
      from,
      fetchImpl: mockFetch(429, { message: "too many" }, { "retry-after": "12" }),
    });
    const res = await provider.send(msg);
    assert.deepEqual(res, {
      ok: false,
      retryable: true,
      errorCode: "RESEND_RATE_LIMITED",
      retryAfterSeconds: 12,
    });
  }
  {
    const provider = new ResendEmailProvider({
      apiKey,
      from,
      fetchImpl: mockFetch(503, { message: `bad ${apiKey} user@example.test` }),
    });
    const res = await provider.send(msg);
    assert.deepEqual(res, { ok: false, retryable: true, errorCode: "RESEND_HTTP_503" });
  }
  {
    const provider = new ResendEmailProvider({
      apiKey,
      from,
      fetchImpl: mockFetch(422, { message: `invalid user@example.test ${apiKey}` }),
    });
    const res = await provider.send(msg);
    assert.deepEqual(res, { ok: false, retryable: false, errorCode: "RESEND_HTTP_422" });
  }
  {
    const slowFetch = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const provider = new ResendEmailProvider({ apiKey, from, timeoutMs: 25, fetchImpl: slowFetch });
    const res = await provider.send(msg);
    assert.deepEqual(res, { ok: false, retryable: true, errorCode: "RESEND_TIMEOUT" });
  }
});

for (const engine of [
  { name: "PGlite", open: freshPgliteDb, opts: {} },
  { name: "PostgreSQL", open: freshPostgresDb, opts: { skip: PG_ONLY } },
]) {
  test(`[${engine.name}] transactional outbox enqueues atomically, deduplicates idempotency keys, and wipes sealed_payload on SENT`, engine.opts, async () => {
    const db = await engine.open();
    const now = new Date("2026-11-12T12:00:00Z");
    const expires = new Date("2026-11-12T12:15:00Z");

    const { first, duplicate } = await db.transaction(async (tx) => {
      await tx.insert(schema.user).values({
        id: "u-signup",
        name: "Public Signup",
        email: "signup@example.test",
        emailVerified: false,
        emailVerificationRequired: true,
        termsAcceptedAt: now,
        termsVersion: "2026-11",
      });
      const first = await enqueueAuthEmail(tx, {
        kind: "EMAIL_VERIFICATION_OTP",
        userId: "u-signup",
        idempotencyKey: "verify:u-signup:nonce-1",
        payload: {
          to: "signup@example.test",
          subject: "Verify your account",
          text: "Your verification code is 778899",
        },
        expiresAt: expires,
        nextAttemptAt: now,
        authSecret: SECRET,
      });
      const duplicate = await enqueueAuthEmail(tx, {
        kind: "EMAIL_VERIFICATION_OTP",
        userId: "u-signup",
        idempotencyKey: "verify:u-signup:nonce-1",
        payload: {
          to: "signup@example.test",
          subject: "Verify your account",
          text: "Your verification code is 778899",
        },
        expiresAt: expires,
        nextAttemptAt: now,
        authSecret: SECRET,
      });
      return { first, duplicate };
    });

    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.id, first.id);

    const [queued] = await db
      .select()
      .from(schema.authEmailOutbox)
      .where(eq(schema.authEmailOutbox.id, first.id));
    assert.equal(queued.status, "PENDING");
    assert.ok(queued.sealedPayload && !queued.sealedPayload.includes("778899"));
    assert.ok(!queued.recipientHash.includes("signup@example.test"));

    const delivered: TransactionalEmailMessage[] = [];
    const fakeProvider: TransactionalEmailProvider = {
      name: "mock",
      async send(m) {
        delivered.push(m);
        return { ok: true, providerMessageId: "re_msg_1" };
      },
    };

    const summary = await dispatchAuthEmailOutbox(db, fakeProvider, {
      now,
      authSecret: SECRET,
    });
    assert.deepEqual(summary, {
      claimed: 1,
      sent: 1,
      retried: 0,
      failedPermanent: 0,
      expiredBeforeSend: 0,
    });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].to, "signup@example.test");
    assert.match(delivered[0].text, /778899/);

    const [afterSend] = await db
      .select()
      .from(schema.authEmailOutbox)
      .where(eq(schema.authEmailOutbox.id, first.id));
    assert.equal(afterSend.status, "SENT");
    assert.equal(afterSend.sealedPayload, null, "sealed_payload wiped immediately on SENT");
    assert.equal(afterSend.providerMessageId, "re_msg_1");
    assert.equal(afterSend.attempts, 1);
  });

  test(`[${engine.name}] outbox retries transient failure with backoff and wipes sealed_payload on permanent failure`, engine.opts, async () => {
    const db = await engine.open();
    const t0 = new Date("2026-11-12T12:00:00Z");
    const expires = new Date("2026-11-12T12:30:00Z");

    const row = await enqueueAuthEmail(db, {
      kind: "PASSWORD_RESET_LINK",
      idempotencyKey: "reset:key-1",
      payload: {
        to: "reset@example.test",
        subject: "Reset your password",
        text: "Reset token xyz",
      },
      expiresAt: expires,
      nextAttemptAt: t0,
      authSecret: SECRET,
    });

    let call = 0;
    const provider: TransactionalEmailProvider = {
      name: "mock",
      async send(): Promise<EmailSendResult> {
        call++;
        if (call === 1) return { ok: false, retryable: true, errorCode: "RESEND_HTTP_503" };
        return { ok: false, retryable: false, errorCode: "RESEND_HTTP_422" };
      },
    };

    const s1 = await dispatchAuthEmailOutbox(db, provider, {
      now: t0,
      baseRetryDelayMs: 5_000,
      authSecret: SECRET,
    });
    assert.equal(s1.retried, 1);

    const [mid] = await db
      .select()
      .from(schema.authEmailOutbox)
      .where(eq(schema.authEmailOutbox.id, row.id));
    assert.equal(mid.status, "FAILED_RETRYABLE");
    assert.ok(mid.sealedPayload !== null, "sealed_payload retained while retryable");

    const sEarly = await dispatchAuthEmailOutbox(db, provider, {
      now: new Date(t0.getTime() + 1_000),
      authSecret: SECRET,
    });
    assert.equal(sEarly.claimed, 0);

    const s2 = await dispatchAuthEmailOutbox(db, provider, {
      now: new Date(t0.getTime() + 10_000),
      authSecret: SECRET,
    });
    assert.equal(s2.failedPermanent, 1);
    const [done] = await db
      .select()
      .from(schema.authEmailOutbox)
      .where(eq(schema.authEmailOutbox.id, row.id));
    assert.equal(done.status, "FAILED_PERMANENT");
    assert.equal(done.sealedPayload, null, "sealed_payload wiped immediately on FAILED_PERMANENT");
    assert.equal(done.lastErrorCode, "RESEND_HTTP_422");
  });
}
