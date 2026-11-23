"use client";
import { useCallback, useEffect, useState } from "react";
import { academyRequest } from "../../academy/ui/shared";
/**
 * Settings -> Consent documents (owners and admins). Draft, publish and review the consent documents
 * families accept, and see who needs to renew. Published text is frozen on the server; this panel can
 * only create the next version.
 */
type Category = "PORTAL" | "EMAIL" | "WHATSAPP";
const CATEGORIES: Category[] = ["PORTAL", "EMAIL", "WHATSAPP"];
const LABEL: Record<Category, string> = { PORTAL: "Portal updates", EMAIL: "Email updates", WHATSAPP: "WhatsApp updates" };
type Published = { id: string; category: Category; version: number; title: string; body: string; publishedAt: string | null; requireRenewal: boolean };
type Draft = { id: string; category: Category; version: number; title: string; body: string };
type Policies = { current: Published[]; versions: Published[]; drafts: Draft[] };
type Report = {
  currentVersions: Record<Category, number | null>;
  counts: Record<Category, Record<string, number>>;
  renewals: { playerId: string; playerName: string; subjectName: string; category: Category; status: string }[];
  unrecorded: number;
};
export function ConsentPoliciesPanel() {
  const [policies, setPolicies] = useState<Policies | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setPolicies(await academyRequest<Policies>("/consent/policies"));
      setReport(await academyRequest<Report>("/consent/report"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function run(path: string, body: unknown, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await academyRequest(path, body);
      setNotice(done);
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (!policies || !report)
    return (
      <p role={error ? "alert" : "status"} className={error ? "error" : undefined}>
        {error || "Loading…"}
      </p>
    );
  return (
    <div className="ops-records">
      <p className="wb-context">
        Families accept these documents in their portal. Once published, a version can never be changed; publishing a new version does not mean
        anyone has accepted it — people are asked to review and accept it themselves.
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {CATEGORIES.map((category) => {
        const current = policies.current.find((p) => p.category === category);
        const draft = policies.drafts.find((d) => d.category === category);
        const counts = report.counts[category];
        return (
          <section key={category} className="panel">
            <h3>{LABEL[category]}</h3>
            <p>
              {current ? `In force: version ${current.version} — ${current.title}` : "No document published yet."}
              {" · "}
              given {counts.CURRENT}, review requested {counts.RENEWAL_REQUESTED}, ended {counts.LAPSED}, withdrawn {counts.WITHDRAWN}, not given {counts.NONE}
              {counts.UNRECORDED ? `, without records ${counts.UNRECORDED}` : ""}
            </p>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const v = new FormData(form);
                if (await run("/consent/version", { id: draft?.id, category, title: String(v.get("title")), body: String(v.get("body")) }, "Draft saved.")) form.reset();
              }}
              key={draft?.id ?? "new"}
              aria-label={`${LABEL[category]} draft`}
            >
              <label>
                Title
                <input name="title" required minLength={3} maxLength={120} defaultValue={draft?.title ?? ""} />
              </label>
              <label>
                Document text
                <textarea name="body" required minLength={20} maxLength={20000} rows={6} defaultValue={draft?.body ?? ""} />
              </label>
              <button className="secondary" disabled={busy}>
                {draft ? `Save draft (version ${draft.version})` : "Start a new version"}
              </button>
            </form>
            {draft && (
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  const v = new FormData(event.currentTarget);
                  await run("/consent/publish", { id: draft.id, requireRenewal: v.get("renewal") === "on" }, `Version ${draft.version} published.`);
                }}
                aria-label={`Publish ${LABEL[category]} version ${draft.version}`}
              >
                <p>
                  Publishing makes version {draft.version} the one families are shown. It cannot be edited afterwards.
                </p>
                <label className="check">
                  <input type="checkbox" name="renewal" />
                  Earlier consent ends until people accept this version (leave off to keep earlier consent in force while asking people to review).
                  Ask your legal adviser which applies.
                </label>
                <label className="check">
                  <input type="checkbox" required />I have saved the final text and want to publish it.
                </label>
                <button className="primary" disabled={busy}>
                  Publish version {draft.version}
                </button>
              </form>
            )}
            {policies.versions.filter((v) => v.category === category).length > 0 && (
              <details>
                <summary>Published versions</summary>
                <ul>
                  {policies.versions
                    .filter((v) => v.category === category)
                    .map((v) => (
                      <li key={v.id}>
                        Version {v.version} — {v.title}, published {v.publishedAt ? new Date(v.publishedAt).toLocaleDateString() : ""}
                        {v.requireRenewal ? " (earlier consent ended)" : ""}
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}
      <h4>People who need to review or renew</h4>
      {report.renewals.length === 0 ? (
        <p className="muted">Nobody at the moment.</p>
      ) : (
        <ul>
          {report.renewals.map((r, i) => (
            <li key={`${r.playerId}-${r.category}-${i}`}>
              {r.subjectName} for {r.playerName} — {LABEL[r.category].toLowerCase()} ({r.status === "LAPSED" ? "ended" : "review requested"})
            </li>
          ))}
        </ul>
      )}
      {report.unrecorded > 0 && (
        <p className="muted">
          {report.unrecorded} consent flag(s) have no record behind them (they predate record-keeping). They are honoured as before; ask those people to confirm.
        </p>
      )}
    </div>
  );
}
