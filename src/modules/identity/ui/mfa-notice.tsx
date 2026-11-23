"use client";
import { useEffect, useState } from "react";
/**
 * Encouragement during the warning stage: a person whose role will soon need two-factor
 * authentication is told once per visit, with a link to set it up. It only displays what the
 * server reports (security-state); it never decides access, and it is absent when nothing is asked
 * (optional roles) or when the person is already enrolled.
 */
export function MfaNotice() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/auth/account/security-state", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          s: { twoFactorEnabled?: boolean; mfa?: { level?: string } } | null,
        ) => {
          if (!live || !s) return;
          let dismissed = false;
          try {
            dismissed = sessionStorage.getItem("mfa-notice") === "1";
          } catch {
            /* storage unavailable: show it */
          }
          setShow(
            s.mfa?.level === "warn" && !s.twoFactorEnabled && !dismissed,
          );
        },
      )
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!show) return null;
  return (
    <div className="notice" role="status">
      Your role will soon be required to use two-factor authentication. Set it
      up now in <a href="/account">Account security</a> — it takes a couple of
      minutes.{" "}
      <button
        className="text-button"
        onClick={() => {
          try {
            sessionStorage.setItem("mfa-notice", "1");
          } catch {
            /* ignore */
          }
          setShow(false);
        }}
      >
        Remind me later
      </button>
    </div>
  );
}
