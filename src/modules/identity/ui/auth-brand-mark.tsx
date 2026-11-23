import Link from "next/link";

export function AuthBrandMark({ href = "/" }: { href?: string }) {
  const inner = (
    <span className="auth-brand">
      <span className="auth-brand-emblem" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="20" height="20" fill="none">
          <rect
            x="3"
            y="4"
            width="26"
            height="24"
            rx="4"
            stroke="currentColor"
            strokeWidth="2"
          />
          <line
            x1="16"
            y1="4"
            x2="16"
            y2="28"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeDasharray="2.5 2.5"
          />
          <line
            x1="3"
            y1="16"
            x2="29"
            y2="16"
            stroke="currentColor"
            strokeWidth="1.75"
          />
          <circle cx="22.5" cy="10.5" r="2.5" fill="#cde1a9" />
        </svg>
      </span>
      <span className="auth-brand-text">
        <strong>Sportozen</strong>
        <span>BADMINTON ACADEMY</span>
      </span>
    </span>
  );

  return href ? (
    <Link href={href} className="auth-brand-link">
      {inner}
    </Link>
  ) : (
    inner
  );
}
