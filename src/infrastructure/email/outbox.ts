import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { database } from "../database/client";
import { authEmailOutbox } from "../database/schema";
import type {
  TransactionalEmailKind,
  TransactionalEmailProvider,
} from "./provider";
import {
  OutboxSealError,
  hashEmailRecipient,
  sealEmailPayload,
  unsealEmailPayload,
  type OutboxEmailPayload,
} from "./seal";

type DbClient = ReturnType<typeof database>;
type DbTx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
export type OutboxExecutor = Pick<DbClient, "insert" | "select" | "update" | "execute"> | DbTx;

export const AUTH_EMAIL_OUTBOX_STATUSES = [
  "PENDING",
  "SENDING",
  "SENT",
  "FAILED_RETRYABLE",
  "FAILED_PERMANENT",
] as const;

export type AuthEmailOutboxStatus = (typeof AUTH_EMAIL_OUTBOX_STATUSES)[number];

export type EnqueueAuthEmailInput = {
  kind: TransactionalEmailKind;
  userId?: string | null;
  idempotencyKey: string;
  payload: OutboxEmailPayload;
  expiresAt: Date;
  nextAttemptAt?: Date;
  authSecret?: string;
};

export type EnqueueAuthEmailResult = {
  id: string;
  inserted: boolean;
};

export type DispatchOutboxOptions = {
  batchSize?: number;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  staleSendingMs?: number;
  now?: Date;
  authSecret?: string;
  signal?: AbortSignal;
};

export type DispatchOutboxSummary = {
  claimed: number;
  sent: number;
  retried: number;
  failedPermanent: number;
  expiredBeforeSend: number;
};

type ClaimedRow = {
  id: string;
  kind: string;
  idempotency_key: string;
  sealed_payload: string | null;
  attempts: number;
  expires_at: Date | string;
};

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_RETRY_DELAY_MS = 15_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 15 * 60_000;
const DEFAULT_STALE_SENDING_MS = 5 * 60_000;

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Enqueues an email inside the caller's transaction (or DB handle).
 * Recipient and payload secrets are encrypted at rest with AES-256-GCM before insertion.
 * Duplicate idempotency keys become a safe no-op returning the existing row id.
 */
export async function enqueueAuthEmail(
  db: OutboxExecutor,
  input: EnqueueAuthEmailInput,
): Promise<EnqueueAuthEmailResult> {
  const recipientHash = hashEmailRecipient(input.payload.to, input.authSecret);
  const sealedPayload = sealEmailPayload(input.payload, input.authSecret);
  const now = new Date();
  const nextAttemptAt = input.nextAttemptAt ?? now;

  const insertedRows = await db
    .insert(authEmailOutbox)
    .values({
      kind: input.kind,
      userId: input.userId ?? null,
      recipientHash,
      idempotencyKey: input.idempotencyKey,
      sealedPayload,
      status: "PENDING",
      attempts: 0,
      nextAttemptAt,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: authEmailOutbox.idempotencyKey })
    .returning({ id: authEmailOutbox.id });

  if (insertedRows.length > 0) {
    return { id: insertedRows[0].id, inserted: true };
  }

  const existing = await db
    .select({ id: authEmailOutbox.id })
    .from(authEmailOutbox)
    .where(eq(authEmailOutbox.idempotencyKey, input.idempotencyKey))
    .limit(1);

  return { id: existing[0].id, inserted: false };
}

function computeNextAttemptAt(
  attemptsAfterFailure: number,
  now: Date,
  options: {
    baseRetryDelayMs: number;
    maxRetryDelayMs: number;
    retryAfterSeconds?: number;
  },
): Date {
  const expMs = Math.min(
    options.maxRetryDelayMs,
    options.baseRetryDelayMs * 2 ** Math.max(0, attemptsAfterFailure - 1),
  );
  const retryAfterMs = options.retryAfterSeconds ? options.retryAfterSeconds * 1000 : 0;
  const delayMs = Math.max(expMs, retryAfterMs);
  return new Date(now.getTime() + delayMs);
}

/**
 * Claims due outbox rows using `FOR UPDATE SKIP LOCKED`, dispatches outside the DB transaction,
 * and wipes `sealed_payload` to NULL immediately on terminal outcomes (`SENT` or `FAILED_PERMANENT`).
 */
export async function dispatchAuthEmailOutbox(
  db: DbClient,
  provider: TransactionalEmailProvider,
  options: DispatchOutboxOptions = {},
): Promise<DispatchOutboxSummary> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseRetryDelayMs = Math.max(100, options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS);
  const maxRetryDelayMs = Math.max(
    baseRetryDelayMs,
    options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
  );
  const staleSendingMs = Math.max(1_000, options.staleSendingMs ?? DEFAULT_STALE_SENDING_MS);
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - staleSendingMs);

  // Sweep already-expired unsent items first and claim due work in a short transaction.
  const claimed = await db.transaction(async (tx) => {
    await tx
      .update(authEmailOutbox)
      .set({
        status: "FAILED_PERMANENT",
        sealedPayload: null,
        lastErrorCode: "EXPIRED",
        updatedAt: now,
      })
      .where(
        and(
          inArray(authEmailOutbox.status, ["PENDING", "FAILED_RETRYABLE"]),
          lte(authEmailOutbox.expiresAt, now),
        ),
      );

    // Reclaim any row left in SENDING longer than staleSendingMs (crashed worker recovery).
    const rows = await tx.execute<ClaimedRow>(sql`
      WITH due AS (
        SELECT id
        FROM auth_email_outbox
        WHERE (
          status IN ('PENDING', 'FAILED_RETRYABLE')
          AND next_attempt_at <= ${now}
          AND expires_at > ${now}
        ) OR (
          status = 'SENDING'
          AND updated_at <= ${staleBefore}
          AND expires_at > ${now}
        )
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE auth_email_outbox o
      SET status = 'SENDING',
          updated_at = ${now}
      FROM due
      WHERE o.id = due.id
      RETURNING o.id, o.kind, o.idempotency_key, o.sealed_payload, o.attempts, o.expires_at
    `);

    return rows.rows;
  });

  const summary: DispatchOutboxSummary = {
    claimed: claimed.length,
    sent: 0,
    retried: 0,
    failedPermanent: 0,
    expiredBeforeSend: 0,
  };

  for (const row of claimed) {
    const expiresAt = asDate(row.expires_at);
    const currentTime = options.now ?? new Date();
    if (expiresAt.getTime() <= currentTime.getTime()) {
      await db
        .update(authEmailOutbox)
        .set({
          status: "FAILED_PERMANENT",
          sealedPayload: null,
          lastErrorCode: "EXPIRED",
          updatedAt: currentTime,
        })
        .where(eq(authEmailOutbox.id, row.id));
      summary.expiredBeforeSend++;
      summary.failedPermanent++;
      continue;
    }

    if (!row.sealed_payload) {
      await db
        .update(authEmailOutbox)
        .set({
          status: "FAILED_PERMANENT",
          sealedPayload: null,
          lastErrorCode: "MISSING_SEALED_PAYLOAD",
          updatedAt: currentTime,
        })
        .where(eq(authEmailOutbox.id, row.id));
      summary.failedPermanent++;
      continue;
    }

    let payload: OutboxEmailPayload;
    try {
      payload = unsealEmailPayload(row.sealed_payload, options.authSecret);
    } catch (err) {
      const code = err instanceof OutboxSealError ? "UNSEAL_FAILED" : "PAYLOAD_ERROR";
      await db
        .update(authEmailOutbox)
        .set({
          status: "FAILED_PERMANENT",
          sealedPayload: null,
          lastErrorCode: code,
          updatedAt: currentTime,
        })
        .where(eq(authEmailOutbox.id, row.id));
      summary.failedPermanent++;
      continue;
    }

    const sendResult = await provider.send(
      {
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        tags: payload.tags,
        idempotencyKey: row.idempotency_key,
        kind: row.kind as TransactionalEmailKind,
      },
      options.signal,
    );

    const finishTime = options.now ?? new Date();
    const nextAttempts = row.attempts + 1;

    if (sendResult.ok) {
      await db
        .update(authEmailOutbox)
        .set({
          status: "SENT",
          attempts: nextAttempts,
          providerMessageId: sendResult.providerMessageId,
          lastErrorCode: null,
          sealedPayload: null,
          sentAt: finishTime,
          updatedAt: finishTime,
        })
        .where(eq(authEmailOutbox.id, row.id));
      summary.sent++;
      continue;
    }

    const nextAttemptAt = computeNextAttemptAt(nextAttempts, finishTime, {
      baseRetryDelayMs,
      maxRetryDelayMs,
      retryAfterSeconds: sendResult.retryAfterSeconds,
    });
    const exhaustRetries =
      !sendResult.retryable ||
      nextAttempts >= maxAttempts ||
      nextAttemptAt.getTime() >= expiresAt.getTime();

    if (exhaustRetries) {
      await db
        .update(authEmailOutbox)
        .set({
          status: "FAILED_PERMANENT",
          attempts: nextAttempts,
          lastErrorCode: sendResult.errorCode,
          sealedPayload: null,
          updatedAt: finishTime,
        })
        .where(eq(authEmailOutbox.id, row.id));
      summary.failedPermanent++;
    } else {
      await db
        .update(authEmailOutbox)
        .set({
          status: "FAILED_RETRYABLE",
          attempts: nextAttempts,
          nextAttemptAt,
          lastErrorCode: sendResult.errorCode,
          updatedAt: finishTime,
        })
        .where(eq(authEmailOutbox.id, row.id));
      summary.retried++;
    }
  }

  return summary;
}
