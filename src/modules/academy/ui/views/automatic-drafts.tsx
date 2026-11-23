"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceProps } from "../context";
import { academyRequest } from "../shared";
import { can } from "../../../identity/authority";

type Policy = { monthlyEnabled: boolean; sessionsEnabled: boolean; sessionsN: number; requiredCategories: string[] };
type Due = { playerId: string; playerName: string; kind: "MONTHLY" | "SESSIONS"; periodStart: string; periodEnd: string; title: string };
type Outcome = Due & { outcome: "CREATED" | "EXISTS" | "SKIPPED"; reason?: string };
const CATEGORIES: [string, string][] = [
  ["TECHNICAL", "Technical"],
  ["TACTICAL", "Tactical"],
  ["PHYSICAL", "Physical"],
  ["BEHAVIOUR", "Behaviour and discipline"],
];

/**
 * Reports that are due under the academy's rules (every month, and/or after a number of completed sessions), with one button to
 * prepare them and the rules themselves for the owner to set. Preparation only ever makes DRAFTS from recorded data: nothing is
 * approved, published or sent, and an existing report is never replaced. When the background worker is running it prepares the
 * same drafts by itself; without it, the button does the same thing.
 */
export function AutomaticDrafts(p: WorkspaceProps & { onChanged: () => Promise<void> }) {
  const canDraft = can(p.data.actor, "reports.author");
  const canEdit = can(p.data.actor, "reports.approve");
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [due, setDue] = useState<Due[] | null>(null);
  const [made, setMade] = useState<Outcome[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  // Once the person has changed a rule, a later load (a repeat of the first, or one after another action) must never overwrite it.
  const edited = useRef(false);
  const edit = (next: Policy) => {
    edited.current = true;
    setSaved("");
    setPolicy(next);
  };
  const load = useCallback(async () => {
    try {
      const [pol, list] = await Promise.all([
        academyRequest<{ policy: Policy }>("/reports/policy", {}),
        academyRequest<{ due: Due[] }>("/reports/due", {}),
      ]);
      if (!edited.current) setPolicy(pol.policy);
      setDue(list.due);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function create() {
    setBusy(true);
    setError("");
    try {
      const out = await academyRequest<{ results: Outcome[] }>("/reports/due-create", {});
      setMade(out.results);
      await load();
      await p.onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!policy) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      await academyRequest("/reports/policy-save", policy);
      edited.current = false;
      setSaved("Saved.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const monthly = due?.filter((d) => d.kind === "MONTHLY").length ?? 0;
  const after = due?.filter((d) => d.kind === "SESSIONS").length ?? 0;
  return (
    <section className="ad" aria-label="Automatic drafts" data-testid="automatic-drafts">
      {due && due.length > 0 ? (
        <div className="notice" role="status">
          <strong>
            {due.length} report{due.length === 1 ? " is" : "s are"} due
          </strong>
          {" — "}
          {monthly ? `${monthly} monthly` : ""}
          {monthly && after ? ", " : ""}
          {after ? `${after} after ${policy?.sessionsN} sessions` : ""}. Drafts only: you review and approve them.
          {canDraft && (
            <>
              {" "}
              <button type="button" className="secondary" disabled={busy} onClick={() => void create()}>
                {busy ? "Preparing…" : "Prepare the due drafts"}
              </button>
            </>
          )}
        </div>
      ) : (
        due && policy && (policy.monthlyEnabled || policy.sessionsEnabled) && <p className="muted">No reports are due right now.</p>
      )}
      {made && (
        <p role="status" className="notice">
          {made.filter((m) => m.outcome === "CREATED").length} draft{made.filter((m) => m.outcome === "CREATED").length === 1 ? "" : "s"} prepared
          {made.some((m) => m.outcome === "SKIPPED") ? `; ${made.filter((m) => m.outcome === "SKIPPED").length} skipped (${made.find((m) => m.outcome === "SKIPPED")?.reason})` : ""}.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <details className="ss-box">
        <summary>Automatic drafts: when should reports be prepared?</summary>
        {!policy ? (
          <p role="status">Loading…</p>
        ) : (
          <>
            <p className="muted">
              Drafts are prepared from recorded sessions and attendance only. Nothing is ever approved, published or sent automatically, and a report that already exists for the same days is never replaced.
            </p>
            <fieldset disabled={!canEdit || busy}>
              <label className="wb-check">
                <input type="checkbox" checked={policy.monthlyEnabled} onChange={(e) => edit({ ...policy, monthlyEnabled: e.target.checked })} /> Prepare a draft each month for the month before
              </label>
              <label className="wb-check">
                <input type="checkbox" checked={policy.sessionsEnabled} onChange={(e) => edit({ ...policy, sessionsEnabled: e.target.checked })} /> Prepare a draft after{" "}
                <input
                  type="number"
                  aria-label="Number of completed sessions"
                  min={2}
                  max={60}
                  value={policy.sessionsN}
                  onChange={(e) => edit({ ...policy, sessionsN: Math.min(60, Math.max(2, Number(e.target.value) || 8)) })}
                  style={{ width: 72 }}
                />{" "}
                completed sessions the player attended
              </label>
              <p className="muted">Reports must contain at least one reviewed observation about:</p>
              <div className="button-row">
                {CATEGORIES.map(([key, label]) => (
                  <label key={key} className="wb-check">
                    <input
                      type="checkbox"
                      checked={policy.requiredCategories.includes(key)}
                      onChange={(e) =>
                        edit({ ...policy, requiredCategories: e.target.checked ? [...policy.requiredCategories, key] : policy.requiredCategories.filter((c) => c !== key) })
                      }
                    />{" "}
                    {label}
                  </label>
                ))}
              </div>
              <small className="muted">A report missing a required area is flagged and left out of batch approval. Areas not required only show a warning.</small>
            </fieldset>
            {canEdit ? (
              <div className="button-row">
                <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
                  Save these rules
                </button>
                {saved && <small role="status">{saved}</small>}
              </div>
            ) : (
              <p className="muted">Only the academy owner, administrator or head coach can change these rules.</p>
            )}
            <small className="muted">
              Scheduled preparation happens when the background worker is running. Without it, press “Prepare the due drafts” yourself.
            </small>
          </>
        )}
      </details>
    </section>
  );
}
