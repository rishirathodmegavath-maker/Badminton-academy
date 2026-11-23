import Link from "next/link";
import { Lock } from "lucide-react";

/**
 * Shown when a person opens a module URL their role is not offered. It is a courtesy: the server already
 * returns no data and refuses every action for that role, so this screen never exposes anything.
 */
export function AccessDenied({ module, home }: { module: string; home: string }) {
  return (
    <section className="ax-state" aria-labelledby="denied-title">
      <Lock size={30} aria-hidden="true" />
      <h1 id="denied-title">You don’t have access to {module || "this page"}</h1>
      <p>
        Your role isn’t set up to use this part of the workspace. If you think that is a mistake, ask the academy
        owner to review your access.
      </p>
      <div className="button-row">
        <Link className="primary" href={home}>
          Go to my workspace
        </Link>
      </div>
    </section>
  );
}

export function ShellSkeleton({ label = "Opening your workspace" }: { label?: string }) {
  return (
    <div className="ax-skeleton" role="status" aria-label={label}>
      <span />
      <span />
      <span />
      <span className="sr-only">{label}…</span>
    </div>
  );
}
