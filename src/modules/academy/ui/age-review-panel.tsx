"use client";
import type { WorkspaceProps } from "./context";
import { text } from "./shared";
import { can } from "../../identity/authority";
import { ageState, ageStateLabel } from "../../players/domain/age-labels";

/**
 * Players are under 18. This shows the owner who needs a decision: players who have turned 18 (accept = archive, reject =
 * keep for now with a reason and a day to look again), who turn 18 within a month, and who has no date of birth yet. Only
 * an owner can decide; everyone else with access to Players sees the same list without the buttons.
 */
export function AgeReviewPanel(p: WorkspaceProps & { edit: (id?: string) => void }) {
  const d = p.data;
  const today = d.currentDate;
  const mayDecide = can(d.actor, "members.manage");
  const items = d.players
    .map((pl) => ({ pl, state: ageState(pl.profile, today) }))
    .filter((i) => i.state.kind !== "OK");
  if (!items.length) return null;
  const order = { DECIDE: 0, BIRTH_DATE_MISSING: 1, TURNING_18: 2, KEPT: 3, OK: 4 } as const;
  items.sort((x, y) => order[x.state.kind] - order[y.state.kind] || x.pl.name.localeCompare(y.pl.name));
  const needs = items.filter((i) => i.state.kind === "DECIDE").length;

  function archive(id: string, name: string, version: number) {
    p.open({
      title: `Archive ${name}`,
      initial: {},
      fields: [],
      notice:
        "The player turned 18, so they leave the active list. Their record, history and reports are kept, and an owner can restore the profile later.",
      button: "Archive player",
      submit: () => p.mutate("/players/age-review", { playerId: id, version, decision: "ARCHIVE" }),
    });
  }
  function keep(id: string, name: string, version: number) {
    p.open({
      title: `Keep ${name} for now`,
      initial: { reason: "", recheckOn: "" },
      fields: [
        { name: "reason", label: "Why does this player stay?", kind: "textarea", required: true, max: 500 },
        { name: "recheckOn", label: "Look at this again on", kind: "date", required: true },
      ],
      notice:
        "Players are meant to be under 18. This keeps the player until the day you choose (at most a year away); you will be asked again then.",
      button: "Keep for now",
      submit: (v) =>
        p.mutate("/players/age-review", { playerId: id, version, decision: "KEEP", reason: text(v, "reason"), recheckOn: text(v, "recheckOn") }),
    });
  }

  return (
    <section className={`age-review ${needs ? "needs" : ""}`} aria-label="Age review">
      <h3>
        Age review{needs ? <span className="age-count"> · {needs} need{needs === 1 ? "s" : ""} your decision</span> : null}
      </h3>
      <p className="muted">Players must be under 18.</p>
      <ul>
        {items.map(({ pl, state }) => (
          <li key={pl.id} className={`age-${state.kind.toLowerCase()}`}>
            <span>
              <strong>{pl.name}</strong> <small>{ageStateLabel(state)}</small>
            </span>
            <span className="button-row">
              {state.kind === "BIRTH_DATE_MISSING" && (
                <button type="button" className="secondary" onClick={() => p.edit(pl.id)}>
                  Add date of birth
                </button>
              )}
              {(state.kind === "DECIDE" || state.kind === "KEPT") && mayDecide && (
                <>
                  <button type="button" className="primary" onClick={() => archive(pl.id, pl.name, pl.version)}>
                    Accept · archive
                  </button>
                  <button type="button" className="secondary" onClick={() => keep(pl.id, pl.name, pl.version)}>
                    Reject · keep for now
                  </button>
                </>
              )}
              {state.kind === "DECIDE" && !mayDecide && <small>Waiting for the owner</small>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
