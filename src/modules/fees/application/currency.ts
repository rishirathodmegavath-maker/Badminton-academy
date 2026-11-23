import { eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import { DomainError } from "../../training/domain/rules";
import { defaultSettings } from "../../academy/domain/types";
import type { Tx } from "../../academy/application/access";
import { currencyChangeBlockers } from "../domain/currency";
/**
 * The academy's billing currency, read inside the caller's transaction. It comes from the academy's
 * stored settings for the signed-in actor's academy, never from the request. An academy without a
 * settings row uses the application default.
 */
export async function academyCurrency(tx: Tx, academyId: string): Promise<string> {
  const [row] = await tx
    .select()
    .from(t.academySettings)
    .where(eq(t.academySettings.academyId, academyId));
  return (row?.data ?? defaultSettings).currency;
}
/**
 * Refuses to switch an academy to `target` while an unsettled invoice or a usable fee plan would be
 * left in the previous currency. Settled and void invoices, payments and refunds are history: they
 * keep the currency they were issued in and nothing is converted. Runs inside the academy-wide
 * write lock, so no invoice can be issued concurrently with the check.
 */
export async function assertCurrencyChangeAllowed(
  tx: Tx,
  academyId: string,
  target: string,
) {
  const [invoices, payments, refunds, plans] = await Promise.all([
    tx.select().from(t.invoices).where(eq(t.invoices.academyId, academyId)),
    tx.select().from(t.payments).where(eq(t.payments.academyId, academyId)),
    tx.select().from(t.refunds).where(eq(t.refunds.academyId, academyId)),
    tx.select().from(t.feePlans).where(eq(t.feePlans.academyId, academyId)),
  ]);
  const blockers = currencyChangeBlockers(
    {
      invoices,
      payments: payments.map((p) => ({
        id: p.id,
        invoiceId: p.invoiceId,
        status: p.status,
        data: { amount: p.data.amount, currency: p.data.currency },
      })),
      refunds,
      plans,
    },
    target,
  );
  if (!blockers.blocked) return;
  const parts = [];
  if (blockers.openInvoices.length)
    parts.push(
      `${blockers.openInvoices.length} issued invoice${blockers.openInvoices.length === 1 ? "" : "s"} with an outstanding balance or a pending payment`,
    );
  if (blockers.activePlans.length)
    parts.push(
      `${blockers.activePlans.length} active fee plan${blockers.activePlans.length === 1 ? "" : "s"}`,
    );
  throw new DomainError(
    `The academy currency cannot change to ${target} while there ${blockers.openInvoices.length + blockers.activePlans.length === 1 ? "is" : "are"} ${parts.join(" and ")} in another currency. Settle or void those invoices and archive those plans first. Existing records keep their currency; nothing is converted.`,
    409,
    "CURRENCY_CHANGE_BLOCKED",
  );
}
