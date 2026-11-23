"use client";
import { useState } from "react";
/**
 * Shows a server-generated temporary password exactly once, after a reset or after creating a
 * login. It lives only in this component's state: nothing is written to storage or the URL.
 */
export function TemporaryPasswordCard({
  password,
  expiresAt,
  person,
  authenticatorRemoved,
}: {
  password: string;
  expiresAt: string;
  person?: string;
  authenticatorRemoved?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="temporary-password">
      <p>
        {person ? `Temporary password for ${person}` : "Temporary password"}.
        This is the only time it is shown. Give it to the person privately; no
        email is sent.
      </p>
      <p>
        <code
          aria-label="Temporary password"
          style={{
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: "1.25rem",
            letterSpacing: "0.05em",
            userSelect: "all",
          }}
        >
          {password}
        </code>
      </p>
      <p>
        <button
          className="secondary"
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(password);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </p>
      <p>
        Valid until {new Date(expiresAt).toLocaleString()} (72 hours). They must
        replace it the first time they sign in.
        {authenticatorRemoved
          ? " Their authenticator was removed; they will set up a new one."
          : ""}
      </p>
    </div>
  );
}
