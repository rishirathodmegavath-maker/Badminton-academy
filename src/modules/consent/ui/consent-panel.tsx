"use client";
import { useCallback, useEffect, useState } from "react";
import { academyRequest } from "../../academy/ui/shared";
/**
 * One player's consent: what is in force, the document it rests on, and the full history. Used by
 * families (their own consent only) and by owners/admins (every linked person, plus recording a
 * decision on someone's behalf). It displays what the server returns and shows the server's refusals;
 * who may see or change what is decided on the server, not here.
 */
type Category = "PORTAL" | "EMAIL" | "WHATSAPP";
type Policy = { id: string; category: Category; version: number; title: string; body: string };
type CategoryState = {
  category: Category;
  label: string;
  granted: boolean;
  status: string;
  sequence: number;
  version: number | null;
  since: string | null;
  recordedBy: string | null;
};
type Subject = { userId: string; name: string; relationship: string; active: boolean; categories: CategoryState[] };
type EventRow = {
  id: string;
  subjectUserId: string;
  category: Category;
  decision: string;
  version: number | null;
  method: string;
  actorRole: string | null;
  actorName: string | null;
  authority: string | null;
  evidenceRef: string | null;
  reason: string | null;
  recordedAt: string;
  legacy: boolean;
};
type View = {
  player: { id: string; name: string };
  adultManagesOwnConsent: boolean;
  canRecordOnBehalf: boolean;
  policies: Policy[];
  subjects: Subject[];
  events: EventRow[];
  nextCursor: string | null;
};
const STATUS: Record<string, string> = {
  NONE: "Not given",
  CURRENT: "Given",
  RENEWAL_REQUESTED: "Given — please review the updated document",
  WITHDRAWN: "Withdrawn",
  LAPSED: "Ended — the document changed; please accept it again",
  UNRECORDED: "Given before records were kept",
};
const DECISION: Record<string, string> = {
  GRANTED: "Given",
  RENEWED: "Renewed",
  WITHDRAWN: "Withdrawn",
  LAPSED: "Ended (document changed)",
};
const METHOD: Record<string, string> = {
  PORTAL_SELF: "by the person in the portal",
  STAFF_WRITTEN: "recorded by the academy from a written form",
  STAFF_VERBAL: "recorded by the academy from a verbal statement",
  IMPORT_LEGACY: "existing before records were kept (who and when were not recorded)",
  SYSTEM_POLICY: "by the academy publishing a new document",
};
type Pending = { subject: Subject; category: Category; action: "GRANT" | "WITHDRAW" };
export function ConsentPanel({ playerId }: { playerId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const load = useCallback(async () => {
    try {
      setView(await academyRequest<View>(`/consent/${playerId}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [playerId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function more() {
    if (!view?.nextCursor) return;
    try {
      const next = await academyRequest<View>(`/consent/${playerId}?cursor=${encodeURIComponent(view.nextCursor)}`);
      setView({ ...view, events: [...view.events, ...next.events], nextCursor: next.nextCursor });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending || !view) return;
    const v = new FormData(event.currentTarget);
    const state = pending.subject.categories.find((c) => c.category === pending.category)!;
    const policy = view.policies.find((p) => p.category === pending.category);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await academyRequest("/consent/decide", {
        playerId,
        ...(view.canRecordOnBehalf
          ? {
              subjectUserId: pending.subject.userId,
              method: String(v.get("method") ?? ""),
              evidenceRef: String(v.get("evidence") ?? ""),
            }
          : {}),
        decisions: [
          {
            category: pending.category,
            action: pending.action,
            ...(pending.action === "GRANT" ? { versionId: policy?.id ?? null } : { reason: String(v.get("reason") ?? "") || null }),
          },
        ],
        basedOn: { [pending.category]: state.sequence },
      });
      setPending(null);
      setNotice(pending.action === "GRANT" ? "Consent recorded." : "Consent withdrawn.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!view)
    return (
      <p role={error ? "alert" : "status"} className={error ? "error" : undefined}>
        {error || "Loading consent…"}
      </p>
    );
  const policyOf = (c: Category) => view.policies.find((p) => p.category === c);
  const nameOf = (id: string) => view.subjects.find((s) => s.userId === id)?.name ?? "Linked person";
  return (
    <section className="panel consent-panel" aria-label={`Consent for ${view.player.name}`}>
      <h3>Consent · {view.player.name}</h3>
      {view.adultManagesOwnConsent && (
        <p className="muted">This player manages their own consent.</p>
      )}
      {!view.policies.length && (
        <p className="muted">
          The academy has not published a consent document yet; decisions are recorded without a document version.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {view.subjects.map((s) => (
        <div key={s.userId} className="wb-inset">
          <h4>
            {s.name} <small>({s.relationship}{s.active ? "" : ", access revoked"})</small>
          </h4>
          <ul className="consent-list">
            {s.categories.map((c) => {
              const policy = policyOf(c.category);
              const canAccept = s.active && c.status !== "CURRENT";
              return (
                <li key={c.category}>
                  <strong>{c.label}</strong>: {STATUS[c.status] ?? c.status}
                  {c.version ? ` (version ${c.version})` : ""}
                  {c.recordedBy && c.recordedBy !== "PORTAL_SELF" && (
                    <small>
                      {" "}
                      — {c.recordedBy === "IMPORT_LEGACY" ? "from before records were kept" : "recorded for this person by the academy"}; confirm it yourself to
                      keep it.
                    </small>
                  )}
                  {s.active && (
                    <span className="consent-actions">
                      {canAccept && (
                        <button className="secondary" disabled={busy} onClick={() => setPending({ subject: s, category: c.category, action: "GRANT" })}>
                          {c.granted ? "Review and accept the new version" : "Give consent"}
                        </button>
                      )}
                      {c.recordedBy && c.recordedBy !== "PORTAL_SELF" && c.granted && c.status === "CURRENT" && !view.canRecordOnBehalf && (
                        <button className="secondary" disabled={busy} onClick={() => setPending({ subject: s, category: c.category, action: "GRANT" })}>
                          Confirm
                        </button>
                      )}
                      {c.granted && (
                        <button className="secondary" disabled={busy} onClick={() => setPending({ subject: s, category: c.category, action: "WITHDRAW" })}>
                          Withdraw
                        </button>
                      )}
                    </span>
                  )}
                  {policy && <small> Current document: version {policy.version}.</small>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {pending && (
        <form onSubmit={submit} className="wb-inset" aria-label="Confirm consent decision">
          <h4>
            {pending.action === "GRANT" ? "Give consent" : "Withdraw consent"} · {pending.subject.categories.find((c) => c.category === pending.category)!.label}
          </h4>
          {pending.action === "GRANT" ? (
            <>
              {policyOf(pending.category) ? (
                <>
                  <p>
                    <strong>{policyOf(pending.category)!.title}</strong> (version {policyOf(pending.category)!.version})
                  </p>
                  <pre className="consent-document">{policyOf(pending.category)!.body}</pre>
                </>
              ) : (
                <p className="muted">No document has been published for this category.</p>
              )}
              <label className="check">
                <input type="checkbox" required />
                {view.canRecordOnBehalf ? `${pending.subject.name} has read this and agrees.` : "I have read this and I agree."}
              </label>
            </>
          ) : (
            <>
              <p>
                {view.canRecordOnBehalf ? `${pending.subject.name} withdraws` : "You withdraw"} this consent. Updates through this channel stop straight away. Earlier records are kept.
              </p>
              <label>
                Reason (optional)
                <textarea name="reason" maxLength={500} rows={2} />
              </label>
            </>
          )}
          {view.canRecordOnBehalf && (
            <>
              <label>
                How was this received?
                <select name="method" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="STAFF_WRITTEN">Written form</option>
                  <option value="STAFF_VERBAL">Verbal statement</option>
                </select>
              </label>
              <label>
                Reference to the evidence {pending.action === "GRANT" ? "" : "(optional)"}
                <input name="evidence" maxLength={500} required={pending.action === "GRANT"} placeholder="Form number, call note…" />
              </label>
            </>
          )}
          <button className="primary" disabled={busy}>
            {pending.action === "GRANT" ? "Record consent" : "Withdraw consent"}
          </button>{" "}
          <button type="button" className="secondary" onClick={() => setPending(null)}>
            Cancel
          </button>
        </form>
      )}
      <h4>History</h4>
      {!view.events.length ? (
        <p className="muted">No decisions have been recorded.</p>
      ) : (
        <ol className="consent-history">
          {view.events.map((e) => (
            <li key={e.id}>
              <strong>{DECISION[e.decision] ?? e.decision}</strong> · {e.category.toLowerCase()}
              {e.version ? ` · version ${e.version}` : " · no document version"} · {nameOf(e.subjectUserId)}
              <br />
              <small>
                {new Date(e.recordedAt).toLocaleString()} — {METHOD[e.method] ?? e.method}
                {e.actorName ? ` (${e.actorName})` : e.actorRole && e.method !== "PORTAL_SELF" ? ` (${e.actorRole.toLowerCase().replace("_", " ")})` : ""}
                {e.evidenceRef ? ` · evidence: ${e.evidenceRef}` : ""}
                {e.reason ? ` · ${e.reason}` : ""}
              </small>
            </li>
          ))}
        </ol>
      )}
      {view.nextCursor && (
        <button className="secondary" onClick={() => void more()}>
          Show older decisions
        </button>
      )}
    </section>
  );
}
