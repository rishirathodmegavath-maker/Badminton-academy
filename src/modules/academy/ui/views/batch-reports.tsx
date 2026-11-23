"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceProps } from "../context";
import { academyRequest, Status } from "../shared";
import { Pane, Blank } from "../workbench";
import { DispatchPanel } from "./dispatch-panel";
import { AutomaticDrafts } from "./automatic-drafts";
import { can } from "../../../identity/authority";
import { monthRange, previousMonth, type ReportIssue } from "../../../reports/domain/batch-rules";

type Row = {
  playerId: string;
  playerName: string;
  batchId: string;
  report: { id: string; status: string; version: number; title: string } | null;
  issues: ReportIssue[];
  warnings: { code: string; text: string }[];
  ready: boolean;
};
type DraftResult = { playerId: string; outcome: "CREATED" | "EXISTS" | "SKIPPED"; reason?: string };
type ApproveResult = { reportId: string; outcome: "PUBLISHED" | "BLOCKED" | "ALREADY_PUBLISHED" | "FAILED"; issues?: ReportIssue[]; reason?: string };

/**
 * The whole reporting workflow in one place:
 *   1. Pick the batch (or the whole academy) and the month. The previous month is already chosen.
 *   2. "Create drafts" makes a draft for every selected player who has none, from recorded sessions and attendance only; the
 *      coach's words are never written for them. Reports that are due under the academy's rules can also be prepared in one press
 *      (or by the background worker).
 *   3. Each row says whether the report is ready or why it is not, and lists what the records do not contain. A flagged report is
 *      left out of batch approval.
 *   4. The owner opens any row to read or edit it, then approves and publishes the ready ones in one step.
 *   5. Choose who receives the published reports (parents, players or both) and the channel, preview, approve, and watch delivery.
 */
export function BatchReports(p: WorkspaceProps & { openReport: (reportId: string) => void }) {
  const d = p.data;
  const canDraft = can(d.actor, "reports.author");
  const canApprove = can(d.actor, "reports.approve");
  const defaults = useMemo(() => previousMonth(new Date().toLocaleDateString("en-CA", { timeZone: d.academy.timezone })), [d.academy.timezone]);
  const [month, setMonth] = useState(defaults.start.slice(0, 7));
  const [batchId, setBatchId] = useState("");
  // The rows are kept with the batch and month they were loaded for, so rows of an earlier choice are never acted on.
  const [loaded, setLoaded] = useState<{ key: string; rows: Row[] } | null>(null);
  const key = `${batchId}|${month}`;
  const rows = loaded && loaded.key === key ? loaded.rows : null;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<DraftResult[] | null>(null);
  const [approval, setApproval] = useState<ApproveResult[] | null>(null);
  const range = monthRange(month);
  const nameOf = (id: string) => d.players.find((x) => x.id === id)?.name ?? "A player";

  const load = useCallback(async () => {
    if (!range) return;
    setError("");
    try {
      const out = await academyRequest<{ rows: Row[] }>("/reports/batch-view", {
        periodStart: range.start,
        periodEnd: range.end,
        ...(batchId ? { batchId } : {}),
      });
      setLoaded({ key: `${batchId}|${month}`, rows: out.rows });
      setPicked((old) => new Set([...old].filter((id) => out.rows.some((r) => r.playerId === id))));
    } catch (e) {
      setError((e as Error).message);
    }
    // `range` is derived from `month`, which is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, batchId]);
  useEffect(() => {
    setDrafts(null);
    setApproval(null);
    void load();
  }, [load]);

  const selected = (rows ?? []).filter((r) => picked.has(r.playerId));
  const chosen = selected.length ? selected : (rows ?? []);
  const needDraft = chosen.filter((r) => !r.report);
  const readyRows = chosen.filter((r) => r.ready);
  const flagged = chosen.filter((r) => r.report && !r.ready && r.report.status !== "PUBLISHED");
  const sendable = chosen.filter((r) => r.report?.status === "PUBLISHED");

  async function refresh() {
    await load();
    await p.reload?.();
  }
  async function createDrafts() {
    if (!range || !needDraft.length) return;
    setWorking(true);
    setError("");
    try {
      const out = await academyRequest<{ results: DraftResult[] }>("/reports/batch-drafts", {
        periodStart: range.start,
        periodEnd: range.end,
        title: range.title,
        playerIds: needDraft.map((r) => r.playerId),
      });
      setDrafts(out.results);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  function confirmApprove() {
    const ids = readyRows.map((r) => r.report!.id);
    if (!ids.length) return;
    p.open({
      title: `Approve and publish ${ids.length} report${ids.length === 1 ? "" : "s"}?`,
      initial: {},
      fields: [],
      button: `Approve and publish ${ids.length}`,
      notice: (
        <>
          <p>
            Parents will be able to read {ids.length === 1 ? "this report" : "these reports"} in their portal. Reports with a flag
            are not included{flagged.length ? ` (${flagged.length} left out)` : ""}.
          </p>
          <ul>
            {readyRows.map((r) => (
              <li key={r.playerId}>{r.playerName}</li>
            ))}
          </ul>
        </>
      ),
      submit: async () => {
        try {
          const out = await academyRequest<{ results: ApproveResult[] }>("/reports/batch-approve", { reportIds: ids });
          setApproval(out.results);
          await refresh();
          return true;
        } catch (e) {
          p.error((e as Error).message);
          return false;
        }
      },
    });
  }
  const toggle = (id: string) =>
    setPicked((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="br-batch">
      <AutomaticDrafts {...p} onChanged={refresh} />
      <Pane title="1 · Choose the batch and the month">
        <div className="rs-select-row">
          <label>
            Batch
            <select aria-label="Batch" value={batchId} onChange={(e) => setBatchId(e.target.value)}>
              <option value="">All my players</option>
              {d.batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Month
            <input aria-label="Month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
        </div>
        <p className="muted">
          Pick specific players below to work on only them, or leave every box empty to work on everyone listed.
        </p>
      </Pane>

      <Pane title="2 · Players and reports">
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {!rows ? (
          <p role="status">Loading…</p>
        ) : rows.length === 0 ? (
          <Blank title="No players here" text="Choose another batch, or add players first." />
        ) : (
          <>
            <div className="button-row">
              {canDraft && (
                <button type="button" className="secondary" disabled={working || !needDraft.length} onClick={() => void createDrafts()}>
                  {working ? "Creating…" : `Create drafts (${needDraft.length})`}
                </button>
              )}
              {canApprove && (
                <button type="button" className="primary" disabled={working || !readyRows.length} onClick={confirmApprove}>
                  Approve and publish ready reports ({readyRows.length})
                </button>
              )}
              <small className="muted">
                {readyRows.length} ready · {flagged.length} flagged · {needDraft.length} without a draft
              </small>
            </div>
            <table className="grid-table br-table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Select</span>
                  </th>
                  <th scope="col">Player</th>
                  <th scope="col">Report</th>
                  <th scope="col">Ready?</th>
                  <th scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.playerId}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.playerName}`}
                        checked={picked.has(r.playerId)}
                        onChange={() => toggle(r.playerId)}
                      />
                    </td>
                    <td>
                      <strong>{r.playerName}</strong>
                    </td>
                    <td>{r.report ? <Status value={r.report.status} /> : <span className="muted">No draft yet</span>}</td>
                    <td>
                      {!r.report ? (
                        <span className="muted">—</span>
                      ) : r.report.status === "PUBLISHED" ? (
                        <span>Published</span>
                      ) : r.ready ? (
                        <>
                          <strong className="br-ok">Ready</strong>
                          {r.warnings.length > 0 && (
                            <details className="br-warn">
                              <summary>Missing from the records ({r.warnings.length})</summary>
                              <ul className="br-issues">
                                {r.warnings.map((w) => (
                                  <li key={w.code}>{w.text}</li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </>
                      ) : (
                        <ul className="br-issues">
                          {r.issues.map((i) => (
                            <li key={i.code}>{i.text}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>
                      {r.report && (
                        <button type="button" className="text-button" onClick={() => p.openReport(r.report!.id)}>
                          {r.ready || r.report.status === "PUBLISHED" ? "Open" : "Edit"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {drafts && (
          <div role="status" className="notice">
            <strong>
              {drafts.filter((x) => x.outcome === "CREATED").length} draft{drafts.filter((x) => x.outcome === "CREATED").length === 1 ? "" : "s"} created.
            </strong>
            {drafts
              .filter((x) => x.outcome === "SKIPPED")
              .map((x) => (
                <p key={x.playerId}>
                  {nameOf(x.playerId)}: skipped. {x.reason}
                </p>
              ))}
            <p className="muted">Open a report to add the coach's own words, or use the facts line as the summary.</p>
          </div>
        )}
        {approval && (
          <div role="status" className="notice">
            <strong>{approval.filter((x) => x.outcome === "PUBLISHED").length} published.</strong>
            {approval
              .filter((x) => x.outcome === "BLOCKED" || x.outcome === "FAILED")
              .map((x) => (
                <p key={x.reportId}>
                  {rows?.find((r) => r.report?.id === x.reportId)?.playerName ?? "A report"}: not approved.{" "}
                  {x.reason ?? x.issues?.map((i) => i.text).join(" ")}
                </p>
              ))}
          </div>
        )}
      </Pane>

      {sendable.length > 0 && can(d.actor, "comms.author") && (
        <Pane title="3 · Send the published reports">
          <p className="muted">
            {sendable.length} published report{sendable.length === 1 ? "" : "s"} {selected.length ? "among the players you ticked" : "in this view"}. Choose who receives them, preview, approve, then watch delivery.
          </p>
          <DispatchPanel {...p} publishedIds={sendable.map((r) => r.report!.id)} />
        </Pane>
      )}
    </div>
  );
}
