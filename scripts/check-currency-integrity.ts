import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";
import { findCurrencyIssues, type MoneyRecords } from "../src/modules/fees/domain/currency";
import { checkTarget } from "./lib/currency-check-guard";
/**
 * Read-only check of money records against each academy's configured currency.
 *
 *   npm run check:currency -- --pglite <copy-of-database> --copy
 *   DATABASE_URL=postgres://… npm run check:currency
 *
 * It reports, per academy, the kinds and counts of inconsistencies (off-currency invoices and
 * plans, payments that disagree with their invoice, unsupported currency codes, non-integer amounts,
 * invoice totals that do not equal subtotal minus discount) with the record ids. It never repairs,
 * converts or writes anything, prints no names or contact details, and refuses the live embedded
 * development database. Exit status: 0 = consistent, 1 = findings, 2 = could not run.
 */
type Run = (sql: string) => Promise<Record<string, unknown>[]>;
async function main() {
  const target = checkTarget(process.argv.slice(2), process.env, process.cwd());
  if (!target.ok) {
    console.error(target.reason);
    process.exitCode = 2;
    return;
  }
  let run: Run;
  let close: () => Promise<void>;
  if (target.kind === "pglite") {
    const db = new PGlite(target.path);
    await db.waitReady;
    await db.query("set default_transaction_read_only = on");
    run = async (sql) => (await db.query(sql)).rows as Record<string, unknown>[];
    close = () => db.close();
  } else {
    const client = new Client({ connectionString: target.url });
    await client.connect();
    await client.query("begin read only");
    run = async (sql) => (await client.query(sql)).rows;
    close = async () => {
      await client.query("rollback");
      await client.end();
    };
  }
  try {
    const academies = await run(
      `select a.id, s.data->>'currency' as currency from academy a left join academy_settings s on s.academy_id = a.id order by a.id`,
    );
    const [invoices, payments, refunds, plans] = await Promise.all([
      run(`select id, academy_id, status, data from invoice`),
      run(`select id, academy_id, invoice_id, status, data from payment_reference`),
      run(`select academy_id, payment_id, amount from payment_refund`),
      run(`select id, academy_id, currency, amount, archived from fee_plan`),
    ]);
    let findings = 0;
    for (const academy of academies) {
      const id = String(academy.id);
      // An academy without a settings row bills in the application default (INR).
      const currency = String(academy.currency ?? "INR");
      const records: MoneyRecords = {
        invoices: invoices
          .filter((r) => r.academy_id === id)
          .map((r) => ({ id: String(r.id), status: String(r.status), data: r.data as MoneyRecords["invoices"][number]["data"] })),
        payments: payments
          .filter((r) => r.academy_id === id)
          .map((r) => ({
            id: String(r.id),
            invoiceId: String(r.invoice_id),
            status: String(r.status),
            data: r.data as MoneyRecords["payments"][number]["data"],
          })),
        refunds: refunds
          .filter((r) => r.academy_id === id)
          .map((r) => ({ paymentId: String(r.payment_id), amount: Number(r.amount) })),
        plans: plans
          .filter((r) => r.academy_id === id)
          .map((r) => ({
            id: String(r.id),
            currency: String(r.currency),
            amount: Number(r.amount),
            archived: Boolean(r.archived),
          })),
      };
      const issues = findCurrencyIssues(currency, records);
      findings += issues.length;
      console.log(
        `academy ${id}: currency ${currency}; ${records.invoices.length} invoices, ${records.payments.length} payments, ${records.plans.length} plans; ${issues.length} finding(s)`,
      );
      for (const issue of issues) console.log(`  ${issue.code}  ${issue.record} ${issue.id}`);
    }
    console.log(findings ? `${findings} finding(s). Nothing was changed.` : "No currency inconsistencies found.");
    process.exitCode = findings ? 1 : 0;
  } finally {
    await close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
