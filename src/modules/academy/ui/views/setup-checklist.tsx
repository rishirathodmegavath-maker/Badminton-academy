"use client";
import type { WorkspaceProps } from "../context";
import { setupSteps } from "../setup-steps";

/** First-run guidance for an academy that is not set up yet. Hidden once everything offered to this person is done. */
export function SetupChecklist(p: WorkspaceProps) {
  const steps = setupSteps(p.data);
  if (!steps.length) return null;
  const done = steps.filter((s) => s.done).length;
  return (
    <section className="panel setup-checklist" aria-labelledby="setup-title">
      <h2 id="setup-title">Finish setting up your academy</h2>
      <p className="muted">
        {done} of {steps.length} steps done.
      </p>
      <ol>
        {steps.map((step, i) => (
          <li key={step.key} className={step.done ? "done" : ""}>
            <span className="setup-mark" aria-hidden="true">
              {step.done ? "✓" : i + 1}
            </span>
            <div>
              <strong>{step.label}</strong>
              {step.done && <span className="sr-only"> (done)</span>}
              <small>{step.hint}</small>
            </div>
            {!step.done && (
              <button type="button" className="secondary" disabled={p.busy} onClick={() => p.nav(step.module, step.focus)}>
                {step.action}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
