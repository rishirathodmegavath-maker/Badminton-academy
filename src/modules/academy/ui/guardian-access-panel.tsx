"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { academyRequest } from "./shared";
import { ErrorContext, Modal } from "../../training/ui/common";
import {
  SCOPE_INFO,
  actorText,
  eventLabel,
  knownScopes,
  plan,
  scopeSummary,
  stateLabel,
  type GuardianAccessView,
  type GuardianRow,
  type PlayerAccess,
} from "./guardian-access-view";
import { GUARDIAN_ACCESS_SCOPES, type GuardianAccessScope } from "../domain/guardian-access";
/**
 * The adult player's guardian-access screen, inside the Family Portal "Access & preferences" tab.
 *
 * It displays what `GET /api/academy/guardian-access` returns and sends `POST /api/academy/guardian-access/save`
 * (RC-4 contract). It decides nothing about authority: the server accepts a grant only from the adult's own account,
 * only for a guardian linked to them, only with the current version, and refuses everything else. A refusal is shown
 * in the server's words. Consent is not a section here and is never offered.
 *
 * Behaviour for people: a loading state (never an empty state while loading), a retry when loading fails, a pending
 * state on the button that was pressed, one request at a time, a confirmation before access is revoked (native
 * dialog: focus is trapped, Escape cancels, focus returns), and success and errors announced to screen readers.
 */
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");
const keyOf = (playerId: string, userId: string) => `${playerId}:${userId}`;
type Pending = { key: string; action: "save" | "revoke" } | null;
type Confirming = { player: PlayerAccess; guardian: GuardianRow } | null;

/**
 * The safe default of the confirmation: keyboard focus starts on Cancel. The shared Modal opens its native dialog in
 * its own effect, which runs after this component's, so focus is set one frame later, when the dialog is open
 * (`autoFocus` would run too early and the browser would focus the close icon instead).
 */
function CancelButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <button ref={ref} className="secondary" type="button" disabled={disabled} onClick={onClick}>
      Cancel
    </button>
  );
}

export function GuardianAccessPanel() {
  const [view, setView] = useState<GuardianAccessView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  /** The card to hand keyboard focus back to once a save or revoke has finished (its button may have gone). */
  const [focusKey, setFocusKey] = useState("");
  /** The sections the adult has ticked and not yet saved, per guardian. Cleared on every reload. */
  const [drafts, setDrafts] = useState<Record<string, GuardianAccessScope[]>>({});

  /**
   * Reads the guardian-access view. `current` says whether this read is still the one that matters: the first load of a
   * mounting screen can be superseded (React mounts effects twice in development, and a slow network can deliver an
   * old answer late), and a late answer must never replace the screen or wipe sections the adult has already ticked.
   */
  const load = useCallback(async (current: () => boolean = () => true) => {
    try {
      const next = await academyRequest<GuardianAccessView>("/guardian-access");
      if (!current()) return false;
      setView(next);
      setDrafts({});
      setLoadError("");
      return true;
    } catch (e) {
      if (current()) setLoadError((e as Error).message);
      return false;
    }
  }, []);
  useEffect(() => {
    let live = true;
    void load(() => live);
    return () => {
      live = false;
    };
  }, [load]);
  useEffect(() => {
    if (!focusKey) return;
    document.querySelector<HTMLElement>(`[data-card="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    setFocusKey("");
  }, [focusKey, view]);

  /** Sends one save. Returns true when the server accepted it. Only one request runs at a time. */
  async function save(player: PlayerAccess, g: GuardianRow, scopes: GuardianAccessScope[], action: "save" | "revoke", done: string) {
    if (pending) return false;
    const key = keyOf(player.playerId, g.userId);
    setPending({ key, action });
    setError("");
    setNotice("");
    try {
      await academyRequest("/guardian-access/save", {
        playerId: player.playerId,
        guardianUserId: g.userId,
        scopes,
        version: g.version,
      });
      const ok = await load();
      if (ok) setNotice(done);
      setFocusKey(key);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "GUARDIAN_ACCESS_CONFLICT") {
        await load();
        setError("This changed since you opened it. The latest access is shown; review it and decide again.");
      } else setError((e as Error).message);
      return false;
    } finally {
      setPending(null);
    }
  }

  if (!view)
    return loadError ? (
      <section className="guardian-access" aria-labelledby="ga-title">
        <h3 id="ga-title">Who can see your record</h3>
        <div className="error" role="alert">
          {loadError}
        </div>
        <div className="button-row">
          <button className="secondary" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </section>
    ) : (
      <section className="guardian-access" aria-busy="true" aria-labelledby="ga-title">
        <h3 id="ga-title">Who can see your record</h3>
        <div className="notice" role="status">
          Loading your guardian access…
        </div>
      </section>
    );
  // The server says whether this account may manage; without it nothing is offered.
  if (!view.manage) return null;
  // Show only the seven sections this screen knows, in the server's order (consent can never appear).
  const offered = knownScopes(view.scopes).length ? knownScopes(view.scopes) : [...GUARDIAN_ACCESS_SCOPES];
  const anyBusy = !!pending;

  return (
    <section className="guardian-access" aria-labelledby="ga-title">
      <h3 id="ga-title">Who can see your record</h3>
      <p>
        You are an adult player, so you decide which guardians see which parts of your record. Choose the sections for each
        guardian and save. You can change or withdraw access at any time and it applies from their next page load. Consent
        is separate: a guardian can never give or withdraw consent for you.
      </p>
      {notice && <div className="notice" role="status">{notice}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      {loadError && (
        <div className="error" role="alert">
          {loadError}{" "}
          <button className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {view.players.map((player) => (
        <div key={player.playerId}>
          {view.players.length > 1 && <h4>{player.name}</h4>}
          {player.guardians.length === 0 && (
            <div className="notice">No guardian is linked to your record. Contact the academy to link one.</div>
          )}
          <div className="ops-card-grid">
            {player.guardians.map((g) => {
              const key = keyOf(player.playerId, g.userId);
              const draft = drafts[key] ?? knownScopes(g.scopes);
              const p = plan(g, draft);
              const sharing = scopeSummary(g.scopes);
              const mine = pending?.key === key ? pending.action : null;
              return (
                <article
                  className="panel"
                  key={key}
                  data-guardian={g.userId}
                  data-card={key}
                  tabIndex={-1}
                  aria-busy={mine ? "true" : undefined}
                  aria-label={`Access for ${g.name}`}
                >
                  <h3>{g.name}</h3>
                  <p>
                    {g.relationship} · <span className="ops-status">{stateLabel(g.state)}</span>
                  </p>
                  <p>{sharing ? `Currently sharing: ${sharing}` : "Not sharing anything."}</p>
                  {g.lastEvent && (
                    <p className="muted">
                      Last change: {eventLabel(g.lastEvent.event)} · {fmt(g.lastEvent.at)} · {actorText(g.lastEvent)}
                    </p>
                  )}
                  {p.note && <div className="notice">{p.note}</div>}
                  {g.eligible && (
                    <fieldset disabled={anyBusy}>
                      <legend>Sections {g.name} can see</legend>
                      {offered.map((scope) => (
                        <label className="checkbox" key={scope}>
                          <input
                            type="checkbox"
                            checked={draft.includes(scope)}
                            onChange={(e) =>
                              setDrafts({
                                ...drafts,
                                [key]: knownScopes(e.target.checked ? [...draft, scope] : draft.filter((s) => s !== scope)),
                              })
                            }
                          />
                          <span>
                            <strong>{SCOPE_INFO[scope].label}</strong>
                            <small> {SCOPE_INFO[scope].detail}</small>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <div className="button-row">
                    {p.save && (
                      <button
                        className="primary"
                        disabled={anyBusy}
                        aria-label={`${p.save.label} for ${g.name}`}
                        onClick={() =>
                          p.save &&
                          void save(player, g, p.save.scopes, "save", p.save.label === "Grant access" ? "Access granted." : "Access updated.")
                        }
                      >
                        {mine === "save" ? "Saving…" : p.save.label}
                      </button>
                    )}
                    {p.revoke && (
                      <button
                        className="secondary"
                        disabled={anyBusy}
                        aria-label={`Revoke all access for ${g.name}`}
                        onClick={() => setConfirming({ player, guardian: g })}
                      >
                        {mine === "revoke" ? "Revoking…" : "Revoke all access"}
                      </button>
                    )}
                  </div>
                  <p className="sr-only" role="status">
                    {mine === "save" ? "Saving your changes…" : mine === "revoke" ? "Revoking access…" : ""}
                  </p>
                </article>
              );
            })}
          </div>
          {player.history.length > 0 && (
            <details className="panel">
              <summary>Access history ({player.history.length})</summary>
              <ol>
                {player.history.map((h) => {
                  const who = player.guardians.find((g) => g.userId === h.guardianUserId)?.name ?? "A guardian";
                  const what = scopeSummary(h.scopes);
                  return (
                    <li key={h.id}>
                      {fmt(h.at)} · {who} · {eventLabel(h.event)}
                      {what ? ` (${what})` : ""} · {actorText(h)}
                    </li>
                  );
                })}
              </ol>
            </details>
          )}
        </div>
      ))}
      {confirming && (
        <ErrorContext.Provider value="">
          <Modal title={`Revoke access for ${confirming.guardian.name}?`} onClose={() => !pending && setConfirming(null)}>
            <div className="notice" role="status">
              {confirming.guardian.name} will stop seeing{" "}
              {scopeSummary(confirming.guardian.scopes) ? scopeSummary(confirming.guardian.scopes) : "your record"} straight away.
              You can give access again at any time, and the history keeps a record of this change.
            </div>
            <div className="modal-actions">
              <CancelButton disabled={!!pending} onClick={() => setConfirming(null)} />
              <button
                className="primary"
                type="button"
                disabled={!!pending}
                onClick={async () => {
                  const c = confirming;
                  // The dialog stays open while the request runs, so a second press cannot send a second request.
                  await save(c.player, c.guardian, [], "revoke", "Access revoked.");
                  setConfirming(null);
                }}
              >
                {pending?.action === "revoke" ? "Revoking…" : "Revoke access"}
              </button>
            </div>
          </Modal>
        </ErrorContext.Provider>
      )}
    </section>
  );
}
