"use client";
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceProps } from "../context";
import { academyRequest } from "../shared";
import { BatchReportShare } from "../sharing";
import { can } from "../../../identity/authority";

type Mode = "PARENTS" | "PLAYERS" | "BOTH";
type Channel = "EMAIL" | "WHATSAPP";
type Skipped = {
  recipient: string;
  kind: string;
  children: string[];
  channel: Channel | null;
  reason: string;
  detail: string;
  subject: { kind: "ACCOUNT" | "PLAYER"; id: string } | null;
  playerId: string | null;
};
type Preview = {
  messages: number;
  byChannel: Record<Channel, number>;
  sharedAddress: number;
  reports: number;
  notPublished: number;
  skipped: Skipped[];
  sample: { channel: Channel; to: string; recipients: string[]; subject: string | null; text: string }[];
  channels: Record<Channel, "NONE" | "TEST" | "LIVE">;
};
type Counts = Record<"QUEUED" | "SENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED_RETRYABLE" | "FAILED" | "SKIPPED" | "CANCELLED", number>;
type BatchRow = { id: string; title: string; mode: string; consolidation: string; channels: string[]; status: string; createdAt: string; counts: Counts };
type Detail = {
  batch: { id: string; title: string; status: string };
  counts: Counts;
  items: { id: string; recipients: string[]; channel: Channel; to: string; reports: number; status: string; attempts: number; error: string | null; skipReason: string | null; sentAt: string | null; deliveredAt: string | null }[];
};

/** What each state means, in the words the owner sees. "Delivered" appears only when the provider reported it. */
const LABEL: Record<string, string> = {
  QUEUED: "Queued",
  SENDING: "Sending",
  SENT: "Sent (accepted by the provider)",
  DELIVERED: "Delivered",
  READ: "Read",
  FAILED_RETRYABLE: "Retrying",
  FAILED: "Failed",
  SKIPPED: "Not sent",
  CANCELLED: "Cancelled",
};
const MODE_TEXT: Record<Mode, string> = { PARENTS: "Parents", PLAYERS: "Players only", BOTH: "Parents and players" };
const CHANNEL_NOTE: Record<"NONE" | "TEST" | "LIVE", string> = {
  NONE: "not set up yet",
  TEST: "test mode: nothing leaves this computer",
  LIVE: "live",
};
const REASON_LABEL: Record<string, string> = {
  NO_CONTACT: "No address or number",
  UNREADABLE_NUMBER: "Number cannot be read",
  NOT_OPTED_IN: "No WhatsApp opt-in",
  SUPPRESSED: "Sending stopped",
  NO_PARENT: "No parent linked",
  ALREADY_SENT: "Already sent or queued",
};
const ACTIVE = ["QUEUED", "SENDING", "FAILED_RETRYABLE"];

/**
 * Steps 4 to 8 of the reporting workflow: choose who receives the published reports (parents, players or both) and by which
 * channel, preview exactly who is reached and who is left out, approve (owner-level) to queue the messages, then watch each one
 * move from queued to delivered or failed and retry the failures. A background worker sends; this screen only queues and shows.
 * The free WhatsApp click-to-chat and mail-app links stay below as a clearly labelled MANUAL fallback.
 */
export function DispatchPanel(p: WorkspaceProps & { publishedIds: string[] }) {
  const canApprove = can(p.data.actor, "comms.approve");
  const [mode, setMode] = useState<Mode>("PARENTS");
  const [channels, setChannels] = useState<Channel[]>(["EMAIL"]);
  const [consolidation, setConsolidation] = useState<"PER_PARENT" | "PER_CHILD">("PER_PARENT");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [batches, setBatches] = useState<BatchRow[] | null>(null);
  const [channelState, setChannelState] = useState<Record<Channel, { mode: "NONE" | "TEST" | "LIVE"; problems: string[] }> | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [optInSource, setOptInSource] = useState<"OWNER_WRITTEN" | "OWNER_VERBAL" | "PARENT_FORM">("OWNER_WRITTEN");
  const body = { reportIds: p.publishedIds, mode, channels, consolidation };

  const loadBatches = useCallback(async () => {
    try {
      const out = await academyRequest<{ batches: BatchRow[]; channels: Record<Channel, { mode: "NONE" | "TEST" | "LIVE"; problems: string[] }> }>("/dispatch/batches", {});
      setBatches(out.batches);
      setChannelState(out.channels);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await academyRequest<Detail>("/dispatch/status", { batchId: id }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);
  // While anything is still moving, refresh by itself so the owner sees queued turn into sent and delivered.
  const moving = !!batches?.some((b) => ACTIVE.some((s) => b.counts[s as keyof Counts] > 0));
  useEffect(() => {
    if (!moving) return;
    const timer = window.setInterval(() => {
      void loadBatches();
      if (detail) void loadDetail(detail.batch.id);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [moving, detail, loadBatches, loadDetail]);
  useEffect(() => setPreview(null), [mode, channels.join(), consolidation, p.publishedIds.join()]);

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  const doPreview = () => run(async () => setPreview(await academyRequest<Preview>("/dispatch/preview", body)));
  function confirm() {
    if (!preview) return;
    p.open({
      title: `Approve and send ${preview.messages} message${preview.messages === 1 ? "" : "s"}?`,
      initial: {},
      fields: [],
      button: `Approve and send ${preview.messages}`,
      notice: (
        <>
          <p>
            This queues {preview.messages} message{preview.messages === 1 ? "" : "s"} ({preview.byChannel.EMAIL} by e-mail, {preview.byChannel.WHATSAPP} by WhatsApp) for{" "}
            {preview.reports} published report{preview.reports === 1 ? "" : "s"}. A background worker sends them; you can watch each one and retry any that fail.
          </p>
          {preview.skipped.length > 0 && <p>{preview.skipped.length} recipient{preview.skipped.length === 1 ? "" : "s"} will be left out (shown in the preview).</p>}
          <p>Each message carries a private link per child. It opens only for that child's signed-in parent.</p>
        </>
      ),
      submit: async () => {
        const out = await run(() => academyRequest<{ batchId: string; queued: number }>("/dispatch/queue", body));
        if (!out) return false;
        setNote(`${out.queued} message${out.queued === 1 ? "" : "s"} queued.`);
        setPreview(null);
        await loadBatches();
        await loadDetail(out.batchId);
        return true;
      },
    });
  }
  const toggle = (c: Channel) => setChannels((old) => (old.includes(c) ? old.filter((x) => x !== c) : [...old, c]));
  const stateOf = (c: Channel) => channelState?.[c];
  const recordOptIn = (s: Skipped) =>
    run(async () => {
      await academyRequest("/contacts/opt-in", { playerId: s.playerId, ...(s.subject?.kind === "ACCOUNT" ? { userId: s.subject.id } : {}), source: optInSource });
      setNote(`WhatsApp opt-in recorded for ${s.recipient}.`);
      await doPreview();
    });
  const retry = (id: string) =>
    run(async () => {
      const out = await academyRequest<{ requeued: number; stillBlocked: number }>("/dispatch/retry", { batchId: id });
      setNote(`${out.requeued} message${out.requeued === 1 ? "" : "s"} put back in the queue${out.stillBlocked ? `; ${out.stillBlocked} not retried because sending to that address is stopped` : ""}.`);
      await loadBatches();
      await loadDetail(id);
    });
  const cancel = (id: string) =>
    run(async () => {
      const out = await academyRequest<{ stopped: number }>("/dispatch/cancel", { batchId: id });
      setNote(`${out.stopped} waiting message${out.stopped === 1 ? "" : "s"} stopped.`);
      await loadBatches();
      await loadDetail(id);
    });
  const processNow = () =>
    run(async () => {
      const out = await academyRequest<{ sent: number; failed: number; retrying: number }>("/dispatch/run-test", {});
      setNote(`Test worker pass: ${out.sent} sent, ${out.retrying} will retry, ${out.failed} failed.`);
      await loadBatches();
      if (detail) await loadDetail(detail.batch.id);
    });
  const testMode = channelState && (channelState.EMAIL.mode === "TEST" || channelState.WHATSAPP.mode === "TEST") && channelState.EMAIL.mode !== "LIVE" && channelState.WHATSAPP.mode !== "LIVE";

  return (
    <div className="dp" data-testid="dispatch-panel">
      <fieldset className="dp-choose" disabled={busy}>
        <legend>Who receives the reports</legend>
        <div className="dp-row" role="radiogroup" aria-label="Recipients">
          {(Object.keys(MODE_TEXT) as Mode[]).map((m) => (
            <label key={m} className="wb-check">
              <input type="radio" name="dp-mode" checked={mode === m} onChange={() => setMode(m)} /> {MODE_TEXT[m]}
            </label>
          ))}
        </div>
        <div className="dp-row">
          {(["EMAIL", "WHATSAPP"] as Channel[]).map((c) => (
            <label key={c} className="wb-check">
              <input type="checkbox" checked={channels.includes(c)} onChange={() => toggle(c)} /> {c === "EMAIL" ? "Email" : "WhatsApp (official)"}{" "}
              <small className="muted">— {channelState ? CHANNEL_NOTE[stateOf(c)!.mode] : "…"}</small>
            </label>
          ))}
        </div>
        <div className="dp-row" role="radiogroup" aria-label="Parent with several children">
          <label className="wb-check">
            <input type="radio" name="dp-cons" checked={consolidation === "PER_PARENT"} onChange={() => setConsolidation("PER_PARENT")} /> One message per parent, with a link for each child
          </label>
          <label className="wb-check">
            <input type="radio" name="dp-cons" checked={consolidation === "PER_CHILD"} onChange={() => setConsolidation("PER_CHILD")} /> One message per child
          </label>
        </div>
        {channelState && (["EMAIL", "WHATSAPP"] as Channel[]).some((c) => channels.includes(c) && stateOf(c)!.mode === "NONE") && (
          <p className="muted">
            A channel that is not set up can still be queued: its messages wait, unsent, until a delivery channel is configured for the background worker. The free manual links below work now.
          </p>
        )}
        <div className="button-row">
          <button type="button" className="secondary" onClick={() => void doPreview()} disabled={!p.publishedIds.length || !channels.length}>
            Preview who will receive this
          </button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {note && (
        <p role="status" className="notice">
          {note}
        </p>
      )}

      {preview && (
        <div className="dp-preview" data-testid="dispatch-preview">
          <h3>
            {preview.messages} message{preview.messages === 1 ? "" : "s"} for {preview.reports} published report{preview.reports === 1 ? "" : "s"}
          </h3>
          <p className="muted">
            {preview.byChannel.EMAIL} by e-mail · {preview.byChannel.WHATSAPP} by WhatsApp
            {preview.sharedAddress ? ` · ${preview.sharedAddress} shared address${preview.sharedAddress === 1 ? "" : "es"} reached once` : ""}
            {preview.notPublished ? ` · ${preview.notPublished} report${preview.notPublished === 1 ? "" : "s"} left out (not published)` : ""}
          </p>
          {preview.sample.map((m, i) => (
            <details key={i} className="dp-sample">
              <summary>
                {m.channel === "EMAIL" ? "Email" : "WhatsApp"} to {m.recipients.join(" and ")} ({m.to})
              </summary>
              {m.subject && <strong>{m.subject}</strong>}
              <pre>{m.text}</pre>
            </details>
          ))}
          {preview.skipped.length > 0 && (
            <>
              <h4>Left out ({preview.skipped.length})</h4>
              {canApprove && preview.skipped.some((s) => s.reason === "NOT_OPTED_IN") && (
                <label className="wb-check">
                  Opt-in source{" "}
                  <select aria-label="Opt-in source" value={optInSource} onChange={(e) => setOptInSource(e.target.value as typeof optInSource)}>
                    <option value="OWNER_WRITTEN">Agreed in writing</option>
                    <option value="OWNER_VERBAL">Agreed in person or by phone</option>
                    <option value="PARENT_FORM">Parent's own form</option>
                  </select>
                </label>
              )}
              <table className="grid-table dp-table">
                <thead>
                  <tr>
                    <th scope="col">Who</th>
                    <th scope="col">Channel</th>
                    <th scope="col">Why</th>
                    <th scope="col">
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.skipped.map((s, i) => (
                    <tr key={i}>
                      <td>
                        {s.recipient}
                        {s.children.length ? <small className="muted"> · {s.children.join(", ")}</small> : null}
                      </td>
                      <td>{s.channel === "EMAIL" ? "Email" : s.channel === "WHATSAPP" ? "WhatsApp" : "—"}</td>
                      <td title={s.detail}>{REASON_LABEL[s.reason] ?? s.reason}</td>
                      <td>
                        {canApprove && s.reason === "NOT_OPTED_IN" && s.playerId && (
                          <button type="button" className="text-button" onClick={() => void recordOptIn(s)}>
                            Record opt-in
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {canApprove ? (
            <div className="button-row">
              <button type="button" className="primary" disabled={busy || preview.messages === 0} onClick={confirm}>
                Approve and send {preview.messages}
              </button>
              {preview.messages === 0 && <small className="muted">Nothing to send for this choice.</small>}
            </div>
          ) : (
            <p className="muted">Approving and sending is for the academy owner, administrator or head coach.</p>
          )}
        </div>
      )}

      <h3>Sending history</h3>
      <div className="button-row">
        <button type="button" className="secondary" onClick={() => void loadBatches()}>
          Refresh
        </button>
        {testMode && canApprove && (
          <button type="button" className="secondary" disabled={busy} onClick={() => void processNow()}>
            Process the queue now (test mode)
          </button>
        )}
        {moving && <small className="muted">Updating every few seconds while messages are moving…</small>}
      </div>
      {!batches ? (
        <p role="status">Loading…</p>
      ) : !canApprove ? (
        <p className="muted">Sending history names every family a message reached, so it is shown to the owner, administrator and head coach only.</p>
      ) : batches.length === 0 ? (
        <p className="muted">Nothing has been sent from here yet.</p>
      ) : (
        <table className="grid-table dp-table">
          <thead>
            <tr>
              <th scope="col">Batch</th>
              <th scope="col">Queued</th>
              <th scope="col">Sent</th>
              <th scope="col">Delivered</th>
              <th scope="col">Failed</th>
              <th scope="col">Not sent</th>
              <th scope="col">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td>
                  <strong>{b.title}</strong>
                  <small className="muted">
                    {" "}
                    · {MODE_TEXT[b.mode as Mode] ?? b.mode} · {b.channels.join(" + ")} · {new Date(b.createdAt).toLocaleString()}
                    {b.status === "CANCELLED" ? " · cancelled" : ""}
                  </small>
                </td>
                <td>{b.counts.QUEUED + b.counts.SENDING + b.counts.FAILED_RETRYABLE}</td>
                <td>{b.counts.SENT}</td>
                <td>{b.counts.DELIVERED + b.counts.READ}</td>
                <td>{b.counts.FAILED}</td>
                <td>{b.counts.SKIPPED + b.counts.CANCELLED}</td>
                <td>
                  <button type="button" className="text-button" onClick={() => void loadDetail(b.id)}>
                    Details
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {detail && (
        <div className="dp-detail" data-testid="dispatch-detail">
          <h4>{detail.batch.title}</h4>
          <div className="button-row">
            {canApprove && detail.counts.FAILED > 0 && (
              <button type="button" className="primary" disabled={busy} onClick={() => void retry(detail.batch.id)}>
                Retry the {detail.counts.FAILED} failed
              </button>
            )}
            {canApprove && detail.batch.status === "APPROVED" && detail.counts.QUEUED + detail.counts.FAILED_RETRYABLE > 0 && (
              <button type="button" className="secondary" disabled={busy} onClick={() => void cancel(detail.batch.id)}>
                Stop what has not been sent
              </button>
            )}
          </div>
          <table className="grid-table dp-table">
            <thead>
              <tr>
                <th scope="col">Recipient</th>
                <th scope="col">Channel</th>
                <th scope="col">Status</th>
                <th scope="col">Tries</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {detail.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.recipients.join(" and ")} <small className="muted">{i.to}</small>
                  </td>
                  <td>{i.channel === "EMAIL" ? "Email" : "WhatsApp"}</td>
                  <td>
                    <span className={`dp-state dp-${i.status.toLowerCase()}`}>{LABEL[i.status] ?? i.status}</span>
                  </td>
                  <td>{i.attempts}</td>
                  <td className="muted">{i.error ?? i.skipReason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="ss-box dp-manual">
        <summary>Manual fallback: free links (not automatic)</summary>
        <p className="muted">
          These open your own WhatsApp or mail app with the message ready, one parent at a time. You press Send in that app. They are not bulk delivery and nothing here can tell whether a message was sent or read.
        </p>
        <BatchReportShare reportIds={p.publishedIds} />
      </details>
    </div>
  );
}
