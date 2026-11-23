"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, Check, Info, Loader2, LogOut, Plus } from "lucide-react";
import { AcceptInvitationForm, CreateAcademyForm } from "@/modules/identity/ui/create-academy-form";
import { MEMBERSHIP_MESSAGES } from "@/modules/identity/membership-messages";
import { redirectIfGated } from "@/modules/identity/ui/gate";
import { AuthShell } from "@/modules/identity/ui/auth-shell";
import { useHydrated } from "@/modules/identity/ui/use-hydrated";
import { pendingInvite } from "@/modules/invitations/ui/pending-invite";

type Academy = { academyId: string; name: string; role: string; current: boolean };
type Listing = {
  academies: Academy[];
  selectionRequired: boolean;
  noAccess: "NO_MEMBERSHIP" | "MEMBERSHIP_INACTIVE" | null;
};
const words = (value: string) => value.replaceAll("_", " ").toLowerCase();

/**
 * Where a signed-in person chooses (or switches) the academy they work in. The list is the person's OWN active memberships,
 * read from the server; choosing one asks the server to switch this session, and the server checks the membership again.
 * Zero academies is the "not part of an academy yet" screen. One academy is chosen automatically (unless the person came
 * here on purpose to switch). Nothing here grants access: it only picks among access the person already holds.
 */
export default function AcademiesPage() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [startingAnother, setStartingAnother] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const hydrated = useHydrated();

  async function choose(academyId: string) {
    setError("");
    setBusyId(academyId);
    try {
      const response = await fetch("/api/auth/account/select-academy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ academyId }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok) {
        // A full navigation, so nothing from the previous academy stays in memory.
        window.location.assign("/");
        return;
      }
      if (redirectIfGated(response.status, body)) return;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      setError(body?.message ?? "That academy is not available to your account.");
      setBusyId(null);
    } catch {
      setError("The server is unavailable. Please try again.");
      setBusyId(null);
    }
  }

  useEffect(() => {
    const switching = new URLSearchParams(window.location.search).has("switch");
    fetch("/api/auth/account/academies", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (redirectIfGated(response.status, body)) return;
        if (!response.ok || !body) throw new Error("unavailable");
        const next = body as Listing;
        // An invitation link was opened in this tab before signing in (for example with Google): go back and accept it.
        if (pendingInvite() && !switching) {
          window.location.assign("/invite");
          return;
        }
        if (next.academies.length === 1 && !switching) {
          void choose(next.academies[0].academyId);
          return;
        }
        setListing(next);
      })
      .catch(() => setError("Your academies could not be loaded. Please try again."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (listing) headingRef.current?.focus();
  }, [listing]);

  async function signOut() {
    setLeaving(true);
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } finally {
      window.location.assign("/login");
    }
  }

  const none = listing && listing.academies.length === 0;
  return (
    <AuthShell
      eyebrow="YOUR ACADEMIES"
      storyTitle={
        <>
          One account,
          <br />
          every <em>academy.</em>
        </>
      }
      storyBody="Each academy keeps its own people, records and settings. You see only the one you choose."
    >
      <div className="auth-header">
        <span className="auth-eyebrow">{none ? "Set up your academy" : "Choose an academy"}</span>
        <h2 ref={headingRef} tabIndex={-1}>
          {none ? "Create your academy" : "Which academy are you working in?"}
        </h2>
        <p className="auth-subtitle">
          {none
            ? listing.noAccess === "MEMBERSHIP_INACTIVE"
              ? `${MEMBERSHIP_MESSAGES.MEMBERSHIP_INACTIVE} You can also start an academy of your own below.`
              : "Give your academy a name. It opens right away with you as the owner, and you can add coaches, families and players from there. If someone invited you to theirs, open the invitation link they sent you instead."
            : "You belong to more than one academy. You can switch at any time from the account menu."}
        </p>
      </div>

      {error && (
        <p role="alert" className="auth-banner auth-banner-error">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      {!listing && !error && (
        <p role="status" className="auth-banner auth-banner-info">
          <Loader2 size={16} className="auth-spin" aria-hidden="true" />
          <span>Loading your academies…</span>
        </p>
      )}

      {listing && listing.academies.length > 0 && (
        <ul className="auth-academy-list" aria-label="Your academies">
          {listing.academies.map((academy) => (
            <li key={academy.academyId}>
              <button
                type="button"
                className="secondary auth-academy-option"
                onClick={() => void choose(academy.academyId)}
                disabled={!hydrated || busyId !== null}
                aria-current={academy.current ? "true" : undefined}
                aria-busy={busyId === academy.academyId ? "true" : undefined}
              >
                <span className="auth-academy-text">
                  <strong>{academy.name}</strong>
                  <small>{words(academy.role)}</small>
                </span>
                {busyId === academy.academyId ? (
                  <Loader2 size={16} className="auth-spin" aria-hidden="true" />
                ) : academy.current ? (
                  <span className="auth-academy-current">
                    <Check size={15} aria-hidden="true" />
                    Current
                  </span>
                ) : (
                  <ArrowRight size={16} aria-hidden="true" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {none && <CreateAcademyForm hydrated={hydrated} />}

      {none && <AcceptInvitationForm hydrated={hydrated} />}

      {listing && listing.academies.length > 0 && (
        <>
          {!startingAnother ? (
            <button
              type="button"
              className="secondary auth-secondary-btn"
              onClick={() => setStartingAnother(true)}
              disabled={!hydrated}
            >
              <Plus size={16} aria-hidden="true" />
              <span>Start another academy</span>
            </button>
          ) : (
            <CreateAcademyForm hydrated={hydrated} />
          )}
        </>
      )}

      <button
        type="button"
        className="secondary auth-secondary-btn auth-academy-signout"
        onClick={() => void signOut()}
        disabled={leaving || !hydrated}
      >
        <LogOut size={16} aria-hidden="true" />
        <span>Sign out</span>
      </button>
    </AuthShell>
  );
}
