"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, FileText, Loader2 } from "lucide-react";
import { AuthShell } from "@/modules/identity/ui/auth-shell";
import { forgetReportLink, looksLikeReportLink, pendingReportLink, rememberReportLink } from "@/modules/dispatch/ui/pending-report-link";

type Opened = { academyId: string; academyName: string; reportId: string; title: string; childFirstName: string };
type Session = { user: { email: string } } | null;

/**
 * Where a report link from the academy lands. The token is read from the URL fragment (never sent to a server in a URL), removed
 * from the address bar, and used only in a request body. Opening needs a signed-in parent of that child: the server checks the
 * relationship and answers every refusal with the same plain words. Nothing about the report is shown until it is opened.
 */
export default function ReportLinkPage() {
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState("");
  const read = useRef(false);

  useEffect(() => {
    // React runs effects twice in development: the fragment must be consumed only once.
    if (read.current) return;
    read.current = true;
    const fragment = window.location.hash.slice(1);
    if (fragment) window.history.replaceState(null, "", window.location.pathname);
    const token = looksLikeReportLink(fragment) ? fragment : pendingReportLink();
    if (!token) {
      setError("This page needs a report link. Open the link the academy sent you.");
      return;
    }
    rememberReportLink(token);
    void (async () => {
      try {
        const s = await fetch("/api/auth/get-session", { cache: "no-store" });
        const who = s.ok ? ((await s.json().catch(() => null)) as Session) : null;
        setSession(who);
        if (!who) return;
        const r = await fetch("/api/auth/report-links/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          cache: "no-store",
        });
        const body = await r.json().catch(() => null);
        if (r.ok) {
          forgetReportLink();
          setOpened(body as Opened);
        } else if (r.status === 429) setError("Too many attempts. Wait a minute and try again.");
        else {
          forgetReportLink();
          setError(String(body?.message ?? "This report is not available to this account."));
        }
      } catch {
        setError("The server is unavailable. Please try again.");
      }
    })();
  }, []);

  return (
    <AuthShell
      eyebrow="PRIVATE REPORT"
      storyTitle={
        <>
          A report is
          <br />
          <em>ready.</em>
        </>
      }
      storyBody="Reports are private. They open only for the child's parent or guardian, signed in to their own account."
    >
      <div className="auth-header">
        <span className="auth-eyebrow">Report</span>
        <h2>{opened ? `${opened.childFirstName}'s report` : "Your report"}</h2>
      </div>
      {session === undefined && !error && (
        <p role="status" className="auth-banner auth-banner-info">
          <Loader2 size={16} className="auth-spin" aria-hidden="true" />
          <span>Opening your report…</span>
        </p>
      )}
      {error && (
        <p role="alert" className="auth-banner auth-banner-error">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
      {session === null && !error && (
        <>
          <p className="auth-field-hint">Sign in with your parent account to open this report. You will come back here automatically.</p>
          <div className="auth-invite-actions">
            <Link href="/login" className="primary auth-primary-btn">
              <span>Sign in</span>
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </>
      )}
      {opened && (
        <>
          <p role="status" className="auth-banner auth-banner-success">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>
              <strong>{opened.title}</strong> from {opened.academyName}.
            </span>
          </p>
          <div className="auth-invite-actions">
            <a className="primary auth-primary-btn" href={`/api/academy/reports/${opened.reportId}/pdf`} target="_blank" rel="noopener noreferrer">
              <FileText size={16} aria-hidden="true" />
              <span>Open the report (PDF)</span>
            </a>
            <Link href="/" className="secondary auth-secondary-btn">
              <span>Open my family portal</span>
            </Link>
          </div>
        </>
      )}
    </AuthShell>
  );
}
