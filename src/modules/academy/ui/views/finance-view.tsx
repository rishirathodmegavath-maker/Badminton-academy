"use client";
import { useState } from "react";
import { Wallet, Clock, FileText, ShieldCheck, Layers } from "lucide-react";
import type { WorkspaceProps } from "../context";
import { Tabs, Status, money, GridTable, Action } from "../shared";
import { label as displayLabel, formatDate } from "../labels";
import {
  Pane,
  Metrics,
  SearchBox,
  Person,
  Blank,
  ContextNote,
  Toolbar,
} from "../workbench";
export function FeesView(
  p: WorkspaceProps & {
    plan: () => void;
    invoice: () => void;
    payment: (id: string) => void;
    verify: (id: string) => void;
    refund: (id: string) => void;
    credits: () => void;
  },
) {
  const d = p.data;
  const [tab, setTab] = useState(
    !!p.focusId?.startsWith("filter:submitted")
      ? "Payments & refunds"
      : "Invoices",
  );
  const [outstandingOnly, setOutstandingOnly] = useState(
    !!p.focusId?.startsWith("filter:outstanding"),
  );
  const [submittedOnly, setSubmittedOnly] = useState(
    !!p.focusId?.startsWith("filter:submitted"),
  );
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [month, setMonth] = useState("");
  const [selectedId, setSelectedId] = useState(
    p.focusId ?? d.invoices[0]?.id ?? "",
  );
  const allowed = d.permissions.finance;
  const invoices = d.invoices.filter(
    (i) =>
      (!status || invoiceStatus(i, d.currentDate) === status) &&
      (!outstandingOnly || i.balance > 0) &&
      (!p.focusId?.split("|")[1] ||
        i.data.playerIds.some((id) =>
          d.players.some(
            (pl) =>
              pl.id === id &&
              d.batches.some(
                (b) =>
                  b.id === pl.batchId &&
                  b.branchId === p.focusId?.split("|")[1],
              ),
          ),
        )) &&
      (!month || i.data.issuedAt.slice(0, 7) === month) &&
      `${i.data.number} ${i.data.description} ${i.data.playerIds.map((id) => d.players.find((pl) => pl.id === id)?.name).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const selected = invoices.find((i) => i.id === selectedId) ?? invoices[0];
  const player = selected
    ? d.players.find((pl) => pl.id === selected.data.playerIds[0])
    : d.players[0];
  const payments = d.payments.filter((pay) => pay.invoiceId === selected?.id);
  const credits = player
    ? d.credits.filter((c) => c.playerId === player.id)
    : [];
  const collected =
    d.payments
      .filter(
        (pay) =>
          pay.status === "VERIFIED" &&
          pay.data.currency === d.settings.data.currency,
      )
      .reduce((sum, p) => sum + p.data.amount, 0) -
    d.refunds
      .filter(
        (r) =>
          d.payments.find((pay) => pay.id === r.paymentId)?.data.currency ===
          d.settings.data.currency,
      )
      .reduce((sum, r) => sum + r.amount, 0);
  return (
    <div className="reference-view">
      <Toolbar>
        <Tabs
          items={[
            "Invoices",
            "Fee plans",
            "Payments & refunds",
            "Lesson credits",
          ]}
          value={tab}
          onChange={setTab}
        />
        {allowed && (
          <div className="button-row">
            <button className="secondary" onClick={p.plan}>
              ＋ Create plan
            </button>
            <button className="primary" onClick={p.invoice}>
              ＋ Create invoice
            </button>
          </div>
        )}
      </Toolbar>
      {!allowed && !d.permissions.family ? (
        <ContextNote>
          Financial records require owner, administrator or finance access.
        </ContextNote>
      ) : (
        <>
          <Metrics
            items={[
              {
                label: `Collected (${d.settings.data.currency})`,
                value: money(collected, d.settings.data.currency),
                icon: Wallet,
                help: "Verified funds less recorded refunds",
              },
              {
                label: "Pending",
                value: money(d.summary.outstanding, d.settings.data.currency),
                icon: Clock,
                tone: "amber",
                help: "All outstanding balances, including overdue",
              },
              {
                label: "Overdue",
                value: money(d.summary.overdue, d.settings.data.currency),
                icon: FileText,
                tone: "purple",
                help: "Included in pending, not added again",
              },
              {
                label: "Verification",
                value: d.summary.pendingPayments,
                icon: ShieldCheck,
                tone: "blue",
                help: "References awaiting independent verification",
              },
            ]}
          />
          {tab === "Invoices" ? (
            <div className="fees-workbench">
              <Pane title="Invoices">
                <Toolbar>
                  <SearchBox
                    label="Search invoices"
                    placeholder="Search player, invoice or fee plan…"
                    value={query}
                    onChange={setQuery}
                  />
                  <select
                    aria-label="Invoice status filter"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="">All statuses</option>
                    {["PENDING", "PART_PAID", "PAID", "OVERDUE", "VOID"].map(
                      (s) => (
                        <option key={s} value={s}>
                          {displayLabel(s)}
                        </option>
                      ),
                    )}
                  </select>
                  <label className="wb-check">
                    <input
                      type="checkbox"
                      checked={outstandingOnly}
                      onChange={(e) => setOutstandingOnly(e.target.checked)}
                    />
                    <span>Outstanding only</span>
                  </label>
                  <input
                    aria-label="Invoice month filter"
                    type="month"
                    value={month}
                    onChange={(e) => setMonth(e.target.value)}
                  />
                </Toolbar>
                {invoices.length ? (
                  <div className="wb-table-wrap">
                    <table className="wb-table">
                      <thead>
                        <tr>
                          <th>Player / family</th>
                          <th>Invoice / plan</th>
                          <th>Total</th>
                          <th>Verified net</th>
                          <th>Balance</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {invoices.map((i) => {
                          const playerNames = i.data.playerIds
                            .map(
                              (id) =>
                                d.players.find((pl) => pl.id === id)?.name ??
                                "Player",
                            )
                            .join(" & ");
                          return (
                          <tr
                            key={i.id}
                            className={selected?.id === i.id ? "selected" : ""}
                            onClick={() => setSelectedId(i.id)}
                          >
                            <td>
                              {/* No aria-label: it replaced the visible player name in the button's name (WCAG 2.5.3, label in name).
                                  The name now comes from the content: the visible player name, then a visually hidden "select invoice
                                  <number>", so two invoices of the same player stay distinguishable. */}
                              <button
                                className="wb-cell-button"
                                onClick={() => setSelectedId(i.id)}
                              >
                                <Person name={playerNames} />
                                <span className="sr-only">, select invoice {i.data.number}</span>
                              </button>
                            </td>
                            <td>
                              <strong>{i.data.number}</strong>
                              <small>{i.data.description}</small>
                            </td>
                            <td>{money(i.data.total, i.data.currency)}</td>
                            <td>
                              {money(i.verified - i.refunded, i.data.currency)}
                            </td>
                            <td>{money(i.balance, i.data.currency)}</td>
                            <td>
                              <Status value={invoiceStatus(i, d.currentDate)} />
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Blank
                    title={
                      d.invoices.length
                        ? "No invoices match these filters"
                        : "No invoices yet"
                    }
                    text={
                      d.invoices.length
                        ? "Try a different search, status or month."
                        : "Create an invoice for an authorised player or family account. Payment references remain unverified until confirmed."
                    }
                    icon={FileText}
                    action={
                      d.invoices.length
                        ? {
                            label: "Clear filters",
                            onClick: () => {
                              setQuery("");
                              setStatus("");
                              setMonth("");
                              setOutstandingOnly(false);
                            },
                          }
                        : allowed
                          ? {
                              label: "Create your first invoice",
                              onClick: p.invoice,
                            }
                          : undefined
                    }
                  />
                )}
              </Pane>
              <Pane
                title="Player / family account"
                action={
                  player && (
                    <button
                      className="text-button"
                      onClick={() =>
                        p.nav(
                          d.permissions.family ? "Home" : "Players",
                          player.id,
                        )
                      }
                    >
                      View profile →
                    </button>
                  )
                }
              >
                {player ? (
                  <>
                    <Person
                      name={
                        selected?.data.familyUserId
                          ? (d.members.find(
                              (m) => m.id === selected.data.familyUserId,
                            )?.name ?? player.name)
                          : player.name
                      }
                      subtitle={
                        selected?.data.playerIds
                          .map(
                            (id) => d.players.find((pl) => pl.id === id)?.name,
                          )
                          .join(" · ") ?? "Player account"
                      }
                      large
                    />
                    {selected ? (
                      <>
                        <section className="wb-inset invoice-account">
                          <h3>Current invoice · {selected.data.number}</h3>
                          <div className="wb-invoice-breakdown">
                            {[
                              ["Fee amount", selected.data.subtotal],
                              ["Discount", selected.data.discount],
                              ["Total", selected.data.total],
                              [
                                "Verified net",
                                selected.verified - selected.refunded,
                              ],
                              ["Due", selected.balance],
                            ].map(([label, value]) => (
                              <div key={label}>
                                <span>{label}</span>
                                <strong>
                                  {money(
                                    value as number,
                                    selected.data.currency,
                                  )}
                                </strong>
                              </div>
                            ))}
                          </div>
                          <small>
                            Due {formatDate(selected.data.dueDate)} ·{" "}
                            <Status
                              value={invoiceStatus(selected, d.currentDate)}
                            />
                          </small>
                        </section>
                        <div className="account-control-grid">
                          <section className="wb-inset">
                            <h3>
                              <ShieldCheck size={17} />
                              Payment verification
                            </h3>
                            {payments
                              .filter((pay) => pay.status === "SUBMITTED")
                              .map((pay) => (
                                <div
                                  className="payment-review-card"
                                  key={pay.id}
                                >
                                  <Status value="SUBMITTED" />
                                  <strong>
                                    {money(pay.data.amount, pay.data.currency)}
                                  </strong>
                                  <p>{pay.data.reference}</p>
                                  {allowed && (
                                    <button
                                      className="secondary"
                                      onClick={() => p.verify(pay.id)}
                                    >
                                      Review reference
                                    </button>
                                  )}
                                </div>
                              ))}
                            {!payments.some(
                              (pay) => pay.status === "SUBMITTED",
                            ) && (
                              <p className="muted">
                                No pending references for this invoice.
                              </p>
                            )}
                            {payments
                              .filter((pay) => pay.status === "REJECTED")
                              .map((pay) => (
                                <p className="muted" key={pay.id}>
                                  Rejected: {pay.data.reference} ·{" "}
                                  {money(pay.data.amount, pay.data.currency)} ·{" "}
                                  {pay.data.rejectionKind === "CORRECTABLE"
                                    ? "may be resubmitted"
                                    : "reference blocked"}
                                  {pay.data.reason ? ` · ${pay.data.reason}` : ""}
                                </p>
                              ))}
                            {selected.balance > 0 &&
                              selected.status === "ISSUED" && (
                                <button
                                  className="secondary full"
                                  onClick={() => p.payment(selected.id)}
                                >
                                  Submit payment reference
                                </button>
                              )}
                          </section>
                          <section className="wb-inset">
                            <h3>
                              <Layers size={17} />
                              Lesson credits
                            </h3>
                            <strong className="credit-balance">
                              {credits.reduce((sum, c) => sum + c.units, 0)}
                            </strong>
                            <p>lessons remaining for {player.name}</p>
                            <button
                              className="text-button"
                              onClick={() => setTab("Lesson credits")}
                            >
                              View credit ledger →
                            </button>
                          </section>
                        </div>
                        <h3>Verified receipts & refunds</h3>
                        {payments
                          .filter((pay) => pay.status === "VERIFIED")
                          .map((pay) => (
                            <div className="wb-receipt-row" key={pay.id}>
                              <span>
                                {money(pay.data.amount, pay.data.currency)}
                                <small>{pay.data.reference}</small>
                              </span>
                              <a
                                href={`/api/academy/fees/${pay.id}/receipt`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-button"
                              >
                                Receipt PDF
                              </a>
                              {allowed && (
                                <button
                                  className="text-button"
                                  onClick={() => p.refund(pay.id)}
                                >
                                  Record refund
                                </button>
                              )}
                            </div>
                          ))}
                        {allowed && selected.status === "ISSUED" && (
                          <button
                            className="text-button"
                            onClick={() =>
                              p.open({
                                title: "Void invoice",
                                initial: { reason: "" },
                                fields: [
                                  {
                                    name: "reason",
                                    label: "Reason for voiding",
                                    kind: "textarea",
                                    required: true,
                                  },
                                ],
                                notice:
                                  "Verified funds must be refunded and submitted references reviewed first.",
                                submit: (v) =>
                                  p.mutate("/fees/void", {
                                    id: selected.id,
                                    version: selected.version,
                                    reason: String(v.reason),
                                  }),
                              })
                            }
                          >
                            Void invoice with reason
                          </button>
                        )}
                      </>
                    ) : (
                      <Blank
                        title="No invoice selected"
                        text="Select an invoice to review its account and verification history."
                      />
                    )}
                  </>
                ) : (
                  <Blank
                    title="Select a player account"
                    text="Real player and family balances will appear beside the invoice list."
                    icon={Wallet}
                  />
                )}
                <ContextNote>
                  Academy fees only. Sportozen subscription billing is separate.
                </ContextNote>
              </Pane>
            </div>
          ) : tab === "Fee plans" ? (
            <GridTable
              rows={d.feePlans}
              columns={[
                { label: "Plan", render: (pl) => pl.name },
                {
                  label: "Amount",
                  render: (pl) => money(pl.amount, pl.currency),
                },
                {
                  label: "Status",
                  render: (pl) => (
                    <Status value={pl.archived ? "ARCHIVED" : "ACTIVE"} />
                  ),
                },
              ]}
              actions={(pl) =>
                allowed ? (
                  <Action
                    onClick={() =>
                      p.mutate("/fees/plan", { ...pl, archived: !pl.archived })
                    }
                  >
                    {pl.archived ? "Restore" : "Archive"}
                  </Action>
                ) : null
              }
            />
          ) : tab === "Payments & refunds" ? (
            <div className="wb-two-panels">
              <Pane title="Payment verification & receipts">
                <label>
                  <input
                    type="checkbox"
                    checked={submittedOnly}
                    onChange={(e) => setSubmittedOnly(e.target.checked)}
                  />{" "}
                  Awaiting verification only
                </label>
                <GridTable
                  rows={d.payments.filter(
                    (pay) =>
                      (!submittedOnly || pay.status === "SUBMITTED") &&
                      invoices.some((i) => i.id === pay.invoiceId),
                  )}
                  columns={[
                    {
                      label: "Reference",
                      render: (pay) => (
                        <>
                          <strong>{pay.data.reference}</strong>
                          <small>
                            {
                              d.invoices.find((i) => i.id === pay.invoiceId)
                                ?.data.number
                            }
                          </small>
                        </>
                      ),
                    },
                    {
                      label: "Amount",
                      render: (pay) =>
                        money(pay.data.amount, pay.data.currency),
                    },
                    {
                      label: "State",
                      render: (pay) => <Status value={pay.status} />,
                    },
                  ]}
                  actions={(pay) => (
                    <>
                      {allowed && pay.status === "SUBMITTED" && (
                        <Action onClick={() => p.verify(pay.id)}>
                          Verify / reject
                        </Action>
                      )}
                      {pay.status === "VERIFIED" && (
                        <>
                          <a
                            href={`/api/academy/fees/${pay.id}/receipt`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-button"
                          >
                            Receipt
                          </a>
                          {allowed && (
                            <Action onClick={() => p.refund(pay.id)}>
                              Record refund
                            </Action>
                          )}
                        </>
                      )}
                    </>
                  )}
                />
              </Pane>
              <Pane title="Recorded external refunds">
                {d.refunds.map((r) => (
                  <article className="wb-inset" key={r.id}>
                    <strong>
                      {money(
                        r.amount,
                        d.payments.find((pay) => pay.id === r.paymentId)?.data
                          .currency ?? d.settings.data.currency,
                      )}
                    </strong>
                    <p>{r.reason}</p>
                    <small>{formatDate(r.createdAt)}</small>
                  </article>
                ))}
                {!d.refunds.length && (
                  <Blank text="No refund entries have been recorded. This app does not move money through an unconfigured gateway." />
                )}
              </Pane>
            </div>
          ) : (
            <Pane
              title="Lesson-credit ledger"
              action={
                allowed && (
                  <button className="secondary" onClick={p.credits}>
                    Grant / redeem lessons
                  </button>
                )
              }
            >
              <GridTable
                rows={d.players}
                columns={[
                  { label: "Player", render: (pl) => pl.name },
                  {
                    label: "Lesson balance",
                    render: (pl) =>
                      d.credits
                        .filter((c) => c.playerId === pl.id)
                        .reduce((sum, c) => sum + c.units, 0),
                  },
                  {
                    label: "History",
                    render: (pl) =>
                      d.credits
                        .filter((c) => c.playerId === pl.id)
                        .map((c) => (
                          <p key={c.id}>
                            {c.units > 0 ? "+" : ""}
                            {c.units} · {c.reason}
                          </p>
                        )),
                  },
                ]}
              />
              <ContextNote>
                Lesson units are recorded separately from money, invoices and
                refunds.
              </ContextNote>
            </Pane>
          )}
        </>
      )}
    </div>
  );
}
function invoiceStatus(
  i: WorkspaceProps["data"]["invoices"][number],
  currentDate: string,
) {
  return i.status === "VOID"
    ? "VOID"
    : i.balance === 0
      ? "PAID"
      : i.data.dueDate < currentDate
        ? "OVERDUE"
        : i.verified - i.refunded > 0
          ? "PART_PAID"
          : "PENDING";
}
