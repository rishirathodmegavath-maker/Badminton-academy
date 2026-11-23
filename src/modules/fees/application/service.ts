import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import {
  unit,
  familyScope,
  guardianMayReceive,
  requireBillablePlayer,
  history,
  expectVersion,
  family,
  type Tx,
} from "../../academy/application/access";
import { CURRENCY_CODES, invoiceTotal, remaining } from "../domain/money";
import {
  MAX_PENDING_ATTEMPTS,
  REJECTION_KINDS,
  referenceDecision,
  referenceKey,
  type ReferenceDecision,
} from "../domain/reference";
import { academyCurrency } from "./currency";
const amount = z.number().int().positive().max(1_000_000_000);
type ReferenceRefusal = Extract<ReferenceDecision, { ok: false }>["code"];
const REFERENCE_MESSAGES: Record<ReferenceRefusal, string> = {
  PAYMENT_REFERENCE_DUPLICATE:
    "This payment reference was already submitted (case and spacing are ignored when references are compared).",
  PAYMENT_REFERENCE_BLOCKED:
    "This payment reference was rejected and cannot be used again. Use the reference of the actual payment.",
  PAYMENT_RESUBMISSION_INVALID:
    "This payment reference was rejected for a different invoice and can only be resubmitted for that invoice.",
};
const referenceError = (code: ReferenceRefusal) =>
  new DomainError(REFERENCE_MESSAGES[code], 409, code);
const pendingLimitError = () =>
  new DomainError(
    `This invoice already has ${MAX_PENDING_ATTEMPTS} payment references awaiting review. Wait for a decision before submitting another.`,
    409,
    "PAYMENT_PENDING_LIMIT",
  );
/** Maps the database's own refusal of a payment attempt to the same codes as the checks. */
function paymentConstraintError(error: unknown) {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, constraint, message } = e as { code?: string; constraint?: string; message?: string };
    if (code === "23505" && constraint === "payment_reference_live_key")
      return referenceError("PAYMENT_REFERENCE_DUPLICATE");
    if (code === "23514" && message?.startsWith("PAYMENT_PENDING_LIMIT"))
      return pendingLimitError();
  }
  return null;
}
export async function invoiceAccess(a: Actor, id: string, tx: Tx) {
  const [invoice] = await tx
    .select()
    .from(t.invoices)
    .where(and(eq(t.invoices.academyId, a.academyId), eq(t.invoices.id, id)));
  if (!invoice) throw new DomainError("Invoice not found.", 404);
  if (family(a)) {
    const listed: unknown = invoice.data.playerIds;
    if (!Array.isArray(listed)) throw new DomainError("Invoice not found.", 404);
    // Owner decision D-5b: an invoice that names no player is visible only to the family account it is explicitly
    // addressed to (this actor: an active family membership of this academy); without that address, to no family.
    // Issuing always requires at least one player, so only data written outside the application can look like this.
    if (listed.length === 0) {
      if (typeof invoice.data.familyUserId !== "string" || invoice.data.familyUserId !== a.id)
        throw new DomainError("Invoice not found.", 404);
      return invoice;
    }
    // Every invoiced player must be one of this account's children (one scope read, not one per player).
    // RC-4: and the FEES section must be held for each of them, so one adult child who has not granted FEES
    // hides a shared invoice (and its payments, receipt and paying) from the guardian.
    const feePlayers = (await familyScope(a, tx)).ids("FEES");
    if (!listed.every((pid) => typeof pid === "string" && feePlayers.has(pid)))
      throw new DomainError("Player not found.", 404);
    if (invoice.data.familyUserId && invoice.data.familyUserId !== a.id)
      throw new DomainError("Invoice not found.", 404);
  } else requireCapability(a, "finance.manage");
  return invoice;
}
export async function ledger(tx: Tx, academyId: string, invoiceId: string) {
  const payments = await tx
    .select()
    .from(t.payments)
    .where(
      and(
        eq(t.payments.academyId, academyId),
        eq(t.payments.invoiceId, invoiceId),
      ),
    );
  // Only the refunds of this invoice's own payments (Stage 5F: no academy-wide refund read).
  const refunds = payments.length
    ? await tx
        .select()
        .from(t.refunds)
        .where(
          and(
            eq(t.refunds.academyId, academyId),
            inArray(
              t.refunds.paymentId,
              payments.map((p) => p.id),
            ),
          ),
        )
    : [];
  const verified = payments
    .filter((p) => p.status === "VERIFIED")
    .reduce((sum, p) => sum + p.data.amount, 0);
  const refunded = refunds
    .filter((r) =>
      payments.some((p) => p.id === r.paymentId && p.status === "VERIFIED"),
    )
    .reduce((sum, r) => sum + r.amount, 0);
  return { verified, refunded, net: verified - refunded };
}
export async function saveFeePlan(a: Actor, input: unknown) {
  requireCapability(a, "finance.manage");
  const v = z
    .object({
      id: z.string().optional(),
      name: z.string().trim().min(2).max(100),
      amount,
      currency: z.enum(CURRENCY_CODES),
      archived: z.boolean(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    const id = v.id ?? crypto.randomUUID();
    // Plans are priced in the academy currency. The academy is the signed-in actor's and the
    // currency is read from its stored settings: neither is taken from the request.
    const academy = await academyCurrency(tx, a.academyId);
    if (v.id) {
      const [current] = await tx
        .select()
        .from(t.feePlans)
        .where(
          and(eq(t.feePlans.academyId, a.academyId), eq(t.feePlans.id, id)),
        );
      if (!current) throw new DomainError("Fee plan not found.", 404);
      // A plan's amount only means something in its own currency, so the currency never changes.
      if (v.currency !== current.currency)
        throw new DomainError(
          "A fee plan's currency cannot be changed. Archive the plan and create a new one in the academy currency.",
          409,
          "PLAN_CURRENCY_LOCKED",
        );
      // A plan left over in another currency can be retired unchanged, nothing more.
      if (
        v.currency !== academy &&
        !(v.archived && v.name === current.name && v.amount === current.amount)
      )
        throw new DomainError(
          `This fee plan is in ${v.currency} but the academy bills in ${academy}. It can only be archived.`,
          422,
          "CURRENCY_MISMATCH",
        );
      const [old] = await tx
        .update(t.feePlans)
        .set({
          name: v.name,
          amount: v.amount,
          currency: v.currency,
          archived: v.archived,
        })
        .where(
          and(eq(t.feePlans.academyId, a.academyId), eq(t.feePlans.id, id)),
        )
        .returning();
      if (!old) throw new DomainError("Fee plan not found.", 404);
    } else {
      if (v.currency !== academy)
        throw new DomainError(
          `Fee plans must be priced in the academy currency (${academy}). This plan is in ${v.currency}; no conversion is performed.`,
          422,
          "CURRENCY_MISMATCH",
        );
      await tx.insert(t.feePlans).values({ ...v, id, academyId: a.academyId });
    }
    await tx
      .insert(t.audit)
      .values({
        id: crypto.randomUUID(),
        academyId: a.academyId,
        actorId: a.id,
        entityId: id,
        action: "fee-plan-save",
        version: 1,
        detail: {},
      });
    return { id };
  });
}
export async function issueInvoice(a: Actor, input: unknown) {
  requireCapability(a, "finance.manage");
  const v = z
    .object({
      id: z.uuid(),
      playerIds: z.array(z.string()).min(1).max(30),
      familyUserId: z.string().nullable(),
      planId: z.string().nullable(),
      description: z.string().trim().min(2).max(500),
      subtotal: amount,
      discount: z.number().int().min(0),
      currency: z.enum(CURRENCY_CODES),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(input);
  return unit(a, async (tx) => {
    const [existing] = await tx
      .select()
      .from(t.invoices)
      .where(eq(t.invoices.id, v.id));
    if (existing) {
      if (existing.academyId !== a.academyId)
        throw new DomainError("Invoice ID unavailable.", 409);
      const d = existing.data;
      if (
        JSON.stringify(d.playerIds) !==
          JSON.stringify([...new Set(v.playerIds)]) ||
        d.total !== invoiceTotal(v.subtotal, v.discount) ||
        d.currency !== v.currency ||
        d.description !== v.description ||
        d.dueDate !== v.dueDate ||
        d.familyUserId !== v.familyUserId ||
        d.planId !== v.planId
      )
        throw new DomainError(
          "Invoice request ID was already used with different values.",
          409,
        );
      return existing;
    }
    // New invoices are issued in the academy currency only. (A retry of an invoice that already
    // exists was answered above from the stored record, whatever the academy bills in today.)
    const academy = await academyCurrency(tx, a.academyId);
    if (v.currency !== academy)
      throw new DomainError(
        `Invoices must be issued in the academy currency (${academy}). This invoice is in ${v.currency}; no conversion is performed.`,
        422,
        "CURRENCY_MISMATCH",
      );
    for (const pid of v.playerIds) await requireBillablePlayer(a, pid, tx);
    if (v.familyUserId) {
      for (const pid of v.playerIds) {
        const [link] = await tx
          .select()
          .from(t.guardianLinks)
          .where(
            and(
              eq(t.guardianLinks.academyId, a.academyId),
              eq(t.guardianLinks.playerId, pid),
              eq(t.guardianLinks.userId, v.familyUserId),
              eq(t.guardianLinks.active, true),
            ),
          );
        // RC-4: an invoice for an adult player is addressed to a guardian only while that adult grants them FEES.
        if (!link || !(await guardianMayReceive(a.academyId, pid, v.familyUserId, "FEES", tx)))
          throw new DomainError(
            "Family account must be authorised for every invoiced player.",
          );
      }
    }
    if (v.planId) {
      const [plan] = await tx
        .select()
        .from(t.feePlans)
        .where(
          and(
            eq(t.feePlans.academyId, a.academyId),
            eq(t.feePlans.id, v.planId),
            eq(t.feePlans.archived, false),
          ),
        );
      if (!plan || plan.currency !== v.currency || plan.amount !== v.subtotal)
        throw new DomainError("Recheck the fee plan amount and currency.");
    }
    const data = {
      number: `INV-${v.id.slice(0, 8).toUpperCase()}`,
      playerIds: [...new Set(v.playerIds)],
      familyUserId: v.familyUserId,
      planId: v.planId,
      description: v.description,
      currency: v.currency,
      subtotal: v.subtotal,
      discount: v.discount,
      total: invoiceTotal(v.subtotal, v.discount),
      dueDate: v.dueDate,
      issuedAt: new Date().toISOString(),
      voidReason: "",
    };
    const [saved] = await tx
      .insert(t.invoices)
      .values({ id: v.id, academyId: a.academyId, data })
      .returning();
    await history(tx, a, "invoice", v.id, 1, data);
    return saved;
  });
}
export async function submitPayment(a: Actor, input: unknown) {
  if (!family(a)) requireCapability(a, "finance.pay");
  const v = z
    .object({
      invoiceId: z.string(),
      idempotencyKey: z.uuid(),
      amount,
      reference: z.string().trim().min(3).max(150),
      method: z.enum(["BANK", "CASH", "UPI", "OTHER"]),
    })
    .parse(input);
  return unit(a, async (tx) => {
    const invoice = await invoiceAccess(a, v.invoiceId, tx);
    if (invoice.status !== "ISSUED")
      throw new DomainError("This invoice is not payable.");
    const [existing] = await tx
      .select()
      .from(t.payments)
      .where(
        and(
          eq(t.payments.academyId, a.academyId),
          eq(t.payments.idempotencyKey, v.idempotencyKey),
        ),
      );
    if (existing) {
      if (
        existing.invoiceId !== v.invoiceId ||
        existing.data.amount !== v.amount ||
        existing.reference !== v.reference ||
        existing.data.method !== v.method
      )
        throw new DomainError("Payment request ID already used.", 409);
      return existing;
    }
    // Duplicates are judged on the canonical reference (case and spacing ignored), across the
    // academy. Rejected attempts are never changed: a correctable one may be followed by a new
    // attempt on the same invoice, an invalid one keeps its reference blocked.
    const key = referenceKey(v.reference);
    const sameKey = await tx
      .select({
        id: t.payments.id,
        invoiceId: t.payments.invoiceId,
        status: t.payments.status,
        rejectionKind: t.payments.rejectionKind,
        data: t.payments.data,
      })
      .from(t.payments)
      .where(
        and(
          eq(t.payments.academyId, a.academyId),
          eq(t.payments.referenceKey, key),
        ),
      );
    const decision = referenceDecision(sameKey, invoice.id);
    if (!decision.ok) throw referenceError(decision.code);
    const pending = await tx
      .select({ id: t.payments.id })
      .from(t.payments)
      .where(
        and(
          eq(t.payments.academyId, a.academyId),
          eq(t.payments.invoiceId, invoice.id),
          eq(t.payments.status, "SUBMITTED"),
        ),
      );
    if (pending.length >= MAX_PENDING_ATTEMPTS) throw pendingLimitError();
    const balance = await ledger(tx, a.academyId, invoice.id);
    if (
      v.amount >
      remaining(invoice.data.total, balance.verified, balance.refunded)
    )
      throw new DomainError("Payment exceeds the current outstanding balance.");
    const id = crypto.randomUUID();
    const data = {
      invoiceId: invoice.id,
      amount: v.amount,
      currency: invoice.data.currency,
      reference: v.reference,
      method: v.method,
      submittedBy: a.id,
      verifiedBy: null,
      reason: "",
      receiptNumber: null,
      // A resubmission is its own attempt with its own id; it names the rejected attempt it follows.
      ...(decision.previous
        ? {
            previousAttemptId: decision.previous.id,
            attemptNo: (decision.previous.data.attemptNo ?? 1) + 1,
          }
        : {}),
    };
    let saved;
    try {
      [saved] = await tx
        .insert(t.payments)
        .values({
          id,
          academyId: a.academyId,
          invoiceId: invoice.id,
          idempotencyKey: v.idempotencyKey,
          reference: v.reference,
          data,
        })
        .returning();
    } catch (error) {
      // The database enforces the same rules (unique live reference, three pending attempts); its
      // refusal is reported with the same codes as the checks above.
      throw paymentConstraintError(error) ?? error;
    }
    await history(tx, a, "payment", id, 1, { data, status: "SUBMITTED" });
    return saved;
  });
}
export async function verifyPayment(a: Actor, input: unknown) {
  requireCapability(a, "finance.manage");
  const v = z
    .object({
      id: z.string(),
      version: z.number().int(),
      decision: z.enum(["VERIFIED", "REJECTED"]),
      reason: z.string().trim().min(3).max(500),
      // Only for a rejection. CORRECTABLE lets the same reference come back as a new attempt on the
      // same invoice; INVALID keeps it blocked. When omitted a rejection is INVALID (the behaviour
      // before Stage 5C: a rejected reference could not be used again).
      rejectionKind: z.enum(REJECTION_KINDS).optional(),
    })
    .parse(input);
  if (v.decision === "VERIFIED" && v.rejectionKind)
    throw new DomainError(
      "A rejection type applies only to a rejection.",
      422,
      "PAYMENT_DECISION_INVALID",
    );
  const rejectionKind =
    v.decision === "REJECTED" ? (v.rejectionKind ?? "INVALID") : null;
  return unit(a, async (tx) => {
    const [p] = await tx
      .select()
      .from(t.payments)
      .where(
        and(eq(t.payments.academyId, a.academyId), eq(t.payments.id, v.id)),
      );
    if (!p) throw new DomainError("Payment not found.", 404);
    if (p.status === v.decision) return p;
    expectVersion(p.version, v.version);
    if (p.status !== "SUBMITTED")
      throw new DomainError(
        "Payment decision is final. Use the refund ledger for verified payments.",
      );
    const invoice = await invoiceAccess(a, p.invoiceId, tx);
    if (v.decision === "VERIFIED") {
      if (invoice.status !== "ISSUED")
        throw new DomainError("Invoice is void.");
      // A payment is always in its invoice's currency; refuse to count one that is not.
      if (p.data.currency !== invoice.data.currency)
        throw new DomainError(
          "This payment's currency does not match its invoice, so it cannot be verified.",
          409,
          "CURRENCY_MISMATCH",
        );
      const l = await ledger(tx, a.academyId, invoice.id);
      if (p.data.amount > remaining(invoice.data.total, l.verified, l.refunded))
        throw new DomainError(
          "Verifying this payment would overpay the invoice.",
        );
    }
    const data = {
      ...p.data,
      verifiedBy: a.id,
      reason: v.reason,
      receiptNumber:
        v.decision === "VERIFIED"
          ? `RCT-${p.id.slice(0, 8).toUpperCase()}`
          : null,
      ...(rejectionKind ? { rejectionKind } : {}),
    };
    // The only change a decided attempt ever gets: once REJECTED, the database refuses any update.
    const [saved] = await tx
      .update(t.payments)
      .set({ status: v.decision, version: p.version + 1, data, rejectionKind })
      .where(
        and(eq(t.payments.academyId, a.academyId), eq(t.payments.id, p.id)),
      )
      .returning();
    await history(tx, a, "payment", p.id, p.version + 1, {
      data,
      status: v.decision,
    });
    return saved;
  });
}
export async function recordRefund(a: Actor, input: unknown) {
  requireCapability(a, "finance.manage");
  const v = z
    .object({
      paymentId: z.string(),
      amount,
      reason: z.string().trim().min(3).max(500),
      idempotencyKey: z.uuid(),
      confirmedExternalRefund: z.literal(true),
    })
    .parse(input);
  return unit(a, async (tx) => {
    const [existing] = await tx
      .select()
      .from(t.refunds)
      .where(
        and(
          eq(t.refunds.academyId, a.academyId),
          eq(t.refunds.idempotencyKey, v.idempotencyKey),
        ),
      );
    if (existing) {
      if (
        existing.paymentId !== v.paymentId ||
        existing.amount !== v.amount ||
        existing.reason !== v.reason
      )
        throw new DomainError("Refund request ID already used.", 409);
      return existing;
    }
    const [p] = await tx
      .select()
      .from(t.payments)
      .where(
        and(
          eq(t.payments.academyId, a.academyId),
          eq(t.payments.id, v.paymentId),
        ),
      );
    if (!p || p.status !== "VERIFIED")
      throw new DomainError("Only verified payments can be refunded.");
    const rows = await tx
      .select()
      .from(t.refunds)
      .where(
        and(
          eq(t.refunds.academyId, a.academyId),
          eq(t.refunds.paymentId, p.id),
        ),
      );
    if (rows.reduce((sum, r) => sum + r.amount, 0) + v.amount > p.data.amount)
      throw new DomainError("Refund exceeds the verified payment.");
    const [saved] = await tx
      .insert(t.refunds)
      .values({
        id: crypto.randomUUID(),
        academyId: a.academyId,
        paymentId: p.id,
        amount: v.amount,
        reason: v.reason,
        idempotencyKey: v.idempotencyKey,
      })
      .returning();
    await history(tx, a, "refund", saved.id, 1, {
      paymentId: p.id,
      amount: v.amount,
      reason: v.reason,
    });
    return saved;
  });
}
export async function adjustCredits(a: Actor, input: unknown) {
  requireCapability(a, "finance.manage");
  const v = z
    .object({
      playerId: z.string(),
      units: z
        .number()
        .int()
        .min(-1000)
        .max(1000)
        .refine((n) => n !== 0),
      reason: z.string().trim().min(3).max(500),
      idempotencyKey: z.uuid(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    await requireBillablePlayer(a, v.playerId, tx);
    const rows = await tx
      .select()
      .from(t.lessonCredits)
      .where(eq(t.lessonCredits.academyId, a.academyId));
    const existing = rows.find((r) => r.idempotencyKey === v.idempotencyKey);
    if (existing) {
      if (
        existing.playerId !== v.playerId ||
        existing.units !== v.units ||
        existing.reason !== v.reason
      )
        throw new DomainError("Credit request ID already used.", 409);
      return existing;
    }
    const balance = rows
      .filter((r) => r.playerId === v.playerId)
      .reduce((sum, r) => sum + r.units, 0);
    if (balance + v.units < 0)
      throw new DomainError("Lesson credit balance cannot become negative.");
    const [saved] = await tx
      .insert(t.lessonCredits)
      .values({ id: crypto.randomUUID(), academyId: a.academyId, ...v })
      .returning();
    await history(tx, a, "lesson-credit", saved.id, 1, {
      playerId: v.playerId,
      units: v.units,
    });
    return saved;
  });
}
export async function voidInvoice(a: Actor, input: unknown) {
  requireCapability(a, "finance.manage");
  const v = z
    .object({
      id: z.string(),
      version: z.number().int(),
      reason: z.string().trim().min(3).max(500),
    })
    .parse(input);
  return unit(a, async (tx) => {
    const invoice = await invoiceAccess(a, v.id, tx);
    if (invoice.status === "VOID") return invoice;
    expectVersion(invoice.version, v.version);
    const l = await ledger(tx, a.academyId, v.id);
    if (l.net > 0)
      throw new DomainError("Refund verified payments before voiding.");
    const pending = await tx
      .select()
      .from(t.payments)
      .where(
        and(
          eq(t.payments.academyId, a.academyId),
          eq(t.payments.invoiceId, v.id),
          eq(t.payments.status, "SUBMITTED"),
        ),
      );
    if (pending.length)
      throw new DomainError(
        "Review pending payment references before voiding.",
      );
    const data = { ...invoice.data, voidReason: v.reason };
    await tx
      .update(t.invoices)
      .set({ status: "VOID", version: invoice.version + 1, data })
      .where(
        and(eq(t.invoices.academyId, a.academyId), eq(t.invoices.id, v.id)),
      );
    await history(tx, a, "invoice", v.id, invoice.version + 1, {
      ...data,
      status: "VOID",
    });
    return { ok: true };
  });
}
