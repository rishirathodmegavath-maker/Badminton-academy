"use client";
import { useCallback, useEffect, useState } from "react";
import { academyRequest } from "../../academy/ui/shared";
/**
 * Settings -> Privacy and erasure (owners and admins). Retention rules, legal holds and erasure
 * requests. The server decides everything: who may act, which moves are allowed, what a preview
 * contains, whether a hold blocks, and when anything may run. Nothing here erases anything directly:
 * approving a request only starts a grace period. Text is rendered as text, never as markup.
 */
type Category = {
  key: string;
  label: string;
  purpose: string;
  owner: string;
  trigger: string;
  existing: string;
  actions: string[];
  fixedReason?: string;
  policy: { status: string; action: string; retentionDays: number | null } | null;
  policyStatus: string;
};
type PreviewCategory = { key: string; label: string; outcome: string; records: number; detail: Record<string, number>; note?: string };
type Request = {
  id: string;
  playerId: string;
  playerName?: string | null;
  status: string;
  version: number;
  requestedBy: string;
  requestedAt: string;
  reason: string;
  reviewedBy: string | null;
  reviewReason: string | null;
  executeAfter: string | null;
  blockedReason: string | null;
  failureCode: string | null;
  attempts: number;
  completedAt: string | null;
  steps: { category: string; action: string; status: string; records?: number; code?: string }[];
  preview?: { generatedAt: string; held: boolean; categories: PreviewCategory[] };
  events?: { id: string; at: string; event: string; actorRole: string | null; reason: string | null }[];
  files?: { pending: number; done: number; failed: number };
};
type Hold = { id: string; scope: string; playerName: string | null; reason: string; createdAt: string; releasedAt: string | null; releaseReason: string | null };
type Overview = {
  categories: Category[];
  graceDays: number;
  ledgerConfigured: boolean;
  requests: Request[];
  holds: Hold[];
  storage: { pending: number; failed: number };
  eligible: { playerId: string; name: string | null; categories: string[] }[];
};
const words = (s: string) => s.toLowerCase().replaceAll("_", " ");
const OUTCOME: Record<string, string> = {
  WILL_ERASE: "Will be erased",
  WILL_ANONYMIZE: "Will be anonymised",
  RETAINED_FIXED: "Kept (evidence)",
  REQUIRES_POLICY_APPROVAL: "Kept — requires policy approval",
  NOT_ELIGIBLE: "Kept — not yet eligible",
  HELD: "Kept — legal hold",
  NOTHING_TO_DO: "Nothing to do",
};
/**
 * `canSetRetention` / `canReleaseHold`: the OWNER-only capabilities `privacy.retention` and `privacy.releaseHold`,
 * decided by the caller with `can()` (RC-5). A convenience only; the server refuses both to anyone else.
 */
export function PrivacyPanel({
  players,
  me,
  canSetRetention,
  canReleaseHold,
}: {
  players: { id: string; name: string }[];
  me: string;
  canSetRetention: boolean;
  canReleaseHold: boolean;
}) {
  const [data, setData] = useState<Overview | null>(null);
  const [open, setOpen] = useState<Request | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await academyRequest<Overview>("/privacy/overview"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function run(path: string, body: unknown, done: string, then?: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await academyRequest(path, body);
      setNotice(done);
      await load();
      if (then) await then();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function show(id: string) {
    try {
      setOpen(await academyRequest<Request>(`/privacy/requests/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!data)
    return (
      <p role={error ? "alert" : "status"} className={error ? "error" : undefined}>
        {error || "Loading…"}
      </p>
    );
  const field = (v: FormData, k: string) => String(v.get(k) ?? "");
  return (
    <div className="ops-records">
      <p className="wb-context">
        Nothing is erased automatically. A category can only be erased after the academy&apos;s owner has approved a rule for it (until then it
        says <strong>requires policy approval</strong>), a request has been reviewed by a different person, and a {data.graceDays}-day grace
        period has passed. Legal holds stop everything for the data they cover. Finance, consent and audit records are always kept.
        {!data.ledgerConfigured && " The erasure ledger location is not configured, so no erasure can complete."}
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <section className="panel">
        <h3>Retention rules</h3>
        <div className="table-wrap">
          <table className="ops-table">
            <caption>What may be erased, and under which approved rule</caption>
            <thead>
              <tr>
                <th>Category</th>
                <th>Rule</th>
                <th>Responsible</th>
                <th>Existing behaviour</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={c.key}>
                  <td data-label="Category">{c.label}</td>
                  <td data-label="Rule">
                    {c.actions.length === 0
                      ? `Fixed: ${c.fixedReason}`
                      : c.policy && c.policy.status === "APPROVED"
                        ? `Approved: ${words(c.policy.action)} ${c.policy.retentionDays === null ? "on request" : `${c.policy.retentionDays} day(s) after the player leaves`}`
                        : c.policy
                          ? "Suspended"
                          : "Requires policy approval"}
                  </td>
                  <td data-label="Responsible">{c.owner}</td>
                  <td data-label="Existing behaviour">{c.existing}</td>
                  <td>
                    {canSetRetention && c.actions.length > 0 && (
                      <details>
                        <summary>{c.policy ? "Change rule" : "Approve a rule"}</summary>
                        <form
                          aria-label={`Rule for ${c.label}`}
                          onSubmit={async (event) => {
                            event.preventDefault();
                            const form = event.currentTarget;
                            const v = new FormData(form);
                            const days = field(v, "days").trim();
                            if (await run("/privacy/policy", { category: c.key, decision: "APPROVE", action: field(v, "action"), retentionDays: days === "" ? null : Number(days), basis: field(v, "basis"), ownerPassword: field(v, "password") }, "Rule saved and recorded.")) form.reset();
                          }}
                        >
                          <label>
                            Action
                            <select name="action" defaultValue={c.actions[0]}>
                              {c.actions.map((a) => (
                                <option key={a} value={a}>
                                  {words(a)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Days after the player leaves (empty = on request only)
                            <input name="days" type="number" min={0} max={36500} />
                          </label>
                          <label>
                            Who approved this and on what basis
                            <textarea name="basis" required minLength={10} maxLength={500} rows={2} />
                          </label>
                          <label>
                            Your password
                            <input name="password" type="password" required autoComplete="current-password" />
                          </label>
                          <button className="primary" disabled={busy}>
                            Approve rule
                          </button>
                        </form>
                        {c.policy && c.policy.status === "APPROVED" && (
                          <form
                            aria-label={`Suspend rule for ${c.label}`}
                            onSubmit={async (event) => {
                              event.preventDefault();
                              const v = new FormData(event.currentTarget);
                              await run("/privacy/policy", { category: c.key, decision: "SUSPEND", basis: field(v, "basis"), ownerPassword: field(v, "password") }, "Rule suspended.");
                            }}
                          >
                            <label>
                              Why it is being suspended
                              <input name="basis" required minLength={10} maxLength={500} />
                            </label>
                            <label>
                              Your password
                              <input name="password" type="password" required autoComplete="current-password" />
                            </label>
                            <button className="secondary" disabled={busy}>
                              Suspend rule
                            </button>
                          </form>
                        )}
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h3>Legal holds</h3>
        {data.holds.length === 0 ? (
          <p className="muted">No legal holds.</p>
        ) : (
          <ul>
            {data.holds.map((h) => (
              <li key={h.id}>
                {h.scope === "ACADEMY" ? "Whole academy" : (h.playerName ?? "Player")} — {h.reason} (placed {new Date(h.createdAt).toLocaleDateString()}
                {h.releasedAt ? `; released ${new Date(h.releasedAt).toLocaleDateString()}: ${h.releaseReason}` : ""})
                {canReleaseHold && !h.releasedAt && (
                  <form
                    aria-label="Release hold"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const v = new FormData(event.currentTarget);
                      await run("/privacy/release", { id: h.id, reason: field(v, "reason"), ownerPassword: field(v, "password") }, "Hold released; blocked requests go back to review.");
                    }}
                  >
                    <input name="reason" aria-label="Why it is released" placeholder="Why it is released" required minLength={10} maxLength={500} />
                    <input name="password" aria-label="Your password" type="password" required autoComplete="current-password" />
                    <button className="secondary" disabled={busy}>
                      Release
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        <form
          aria-label="Place a legal hold"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const v = new FormData(form);
            const p = field(v, "player");
            if (await run("/privacy/hold", { playerId: p || null, reason: field(v, "reason"), ownerPassword: field(v, "password") }, "Legal hold placed.")) form.reset();
          }}
        >
          <label>
            Covers
            <select name="player" defaultValue="">
              <option value="">The whole academy</option>
              {players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Why
            <input name="reason" required minLength={10} maxLength={500} />
          </label>
          <label>
            Your password
            <input name="password" type="password" required autoComplete="current-password" />
          </label>
          <button className="secondary" disabled={busy}>
            Place hold
          </button>
        </form>
      </section>
      <section className="panel">
        <h3>Erasure requests</h3>
        <form
          aria-label="New erasure request"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const v = new FormData(form);
            if (await run("/privacy/request", { playerId: field(v, "player"), reason: field(v, "reason") }, "Request created with a preview. Another owner or administrator must review it.")) form.reset();
          }}
        >
          <label>
            Player
            <select name="player" required defaultValue="">
              <option value="" disabled>
                Choose a player
              </option>
              {players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Why (who asked, and how)
            <input name="reason" required minLength={10} maxLength={500} />
          </label>
          <button className="primary" disabled={busy}>
            Create request and preview
          </button>
        </form>
        {data.eligible.length > 0 && (
          <p className="muted">
            Past their approved retention period: {data.eligible.map((e) => `${e.name ?? "a player"} (${e.categories.map(words).join(", ")})`).join("; ")}.
          </p>
        )}
        {data.requests.length === 0 ? (
          <p className="muted">No erasure requests.</p>
        ) : (
          <div className="table-wrap">
            <table className="ops-table">
              <caption>Erasure requests, newest first</caption>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Status</th>
                  <th>Requested</th>
                  <th>Runs not before</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.requests.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Player">{r.playerName ?? "Player"}</td>
                    <td data-label="Status">
                      {words(r.status)}
                      {r.blockedReason ? ` (${words(r.blockedReason)})` : ""}
                      {r.failureCode ? ` — ${r.failureCode}` : ""}
                    </td>
                    <td data-label="Requested">{new Date(r.requestedAt).toLocaleDateString()}</td>
                    <td data-label="Runs not before">{r.executeAfter ? new Date(r.executeAfter).toLocaleString() : "—"}</td>
                    <td>
                      <button className="secondary" onClick={() => void show(r.id)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {open && (
          <article className="panel" aria-label="Erasure request">
            <h4>
              {words(open.status)} — requested {new Date(open.requestedAt).toLocaleDateString()}
            </h4>
            <p>Reason: {open.reason}</p>
            {open.executeAfter && open.status === "GRACE_PERIOD" && <p>Grace period: nothing runs before {new Date(open.executeAfter).toLocaleString()}. It can be cancelled until then.</p>}
            {open.preview && (
              <div className="table-wrap">
                <table className="ops-table">
                  <caption>Impact preview (counts only; nothing has been changed){open.preview.held ? " — a legal hold applies" : ""}</caption>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>What would happen</th>
                      <th>Records</th>
                    </tr>
                  </thead>
                  <tbody>
                    {open.preview.categories.map((c) => (
                      <tr key={c.key}>
                        <td data-label="Category">{c.label}</td>
                        <td data-label="What would happen">{OUTCOME[c.outcome] ?? c.outcome}</td>
                        <td data-label="Records">{c.records}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {open.steps.length > 0 && (
              <p>
                Progress: {open.steps.map((s) => `${words(s.category)} ${words(s.status)}${s.code ? ` (${s.code})` : ""}`).join("; ")}
                {open.files ? `. Files: ${open.files.done} removed, ${open.files.pending} waiting, ${open.files.failed} failed.` : ""}
              </p>
            )}
            {open.status === "PREVIEW_READY" && (
              <>
                {open.requestedBy === me ? (
                  <p className="muted">You raised this request, so someone else must review it.</p>
                ) : (
                  <form
                    aria-label="Review request"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const v = new FormData(event.currentTarget);
                      const decision = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ?? "APPROVE";
                      await run("/privacy/review", { id: open.id, version: open.version, decision, reason: field(v, "reason"), ownerPassword: field(v, "password") }, decision === "APPROVE" ? `Approved. Nothing is erased before the ${data.graceDays}-day grace period ends.` : "Request rejected.", async () => setOpen(null));
                    }}
                  >
                    <label>
                      Your decision and why
                      <input name="reason" required minLength={10} maxLength={500} />
                    </label>
                    <label>
                      Your password
                      <input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    <button className="primary" name="d" value="APPROVE" disabled={busy}>
                      Approve (starts the {data.graceDays}-day grace period)
                    </button>
                    <button className="secondary" name="d" value="REJECT" disabled={busy}>
                      Reject
                    </button>
                  </form>
                )}
              </>
            )}
            {["PREVIEW_READY", "GRACE_PERIOD", "BLOCKED"].includes(open.status) && (
              <form
                aria-label="Cancel request"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const v = new FormData(event.currentTarget);
                  await run("/privacy/cancel", { id: open.id, reason: field(v, "reason") }, "Request cancelled.", async () => setOpen(null));
                }}
              >
                <input name="reason" aria-label="Why it is cancelled" placeholder="Why it is cancelled" required minLength={10} maxLength={500} />
                <button className="secondary" disabled={busy}>
                  Cancel request
                </button>
              </form>
            )}
            {open.events && (
              <details>
                <summary>History</summary>
                <ul>
                  {open.events.map((e) => (
                    <li key={e.id}>
                      {new Date(e.at).toLocaleString()} — {words(e.event)} ({e.actorRole ? words(e.actorRole) : "system"}){e.reason ? `: ${e.reason}` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </article>
        )}
      </section>
      <section className="panel">
        <h3>Operations</h3>
        <p>
          Private files waiting for removal: {data.storage.pending}; failed: {data.storage.failed}. Approved erasures run when their grace period ends (scheduled with{" "}
          <code>npm run privacy:process</code>) or when you press the button.
        </p>
        <button className="secondary" disabled={busy} onClick={() => void run("/privacy/process", {}, "Due erasures were processed.")}>
          Process due erasures now
        </button>
      </section>
    </div>
  );
}
