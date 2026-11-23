import Link from "next/link";
import type { ReactNode } from "react";
import { CheckCircle2, Lock, Users } from "lucide-react";
import { AuthBrandMark } from "./auth-brand-mark";

const HIGHLIGHTS = [
  {
    icon: CheckCircle2,
    text: "Structured training plans, attendance & court progression",
  },
  {
    icon: Users,
    text: "Role-scoped workspaces for coaches, finance & families",
  },
  {
    icon: Lock,
    text: "Private academy records with verified session security",
  },
];

export function AuthShell({
  eyebrow = "ACADEMY PLATFORM",
  storyTitle = (
    <>
      Built for every{" "}
      <br />
      session on <em>court.</em>
    </>
  ),
  storyBody = "One calm workspace connecting coaches, academy leadership, players and families.",
  showcaseImage,
  children,
}: {
  eyebrow?: string;
  storyTitle?: ReactNode;
  storyBody?: string;
  showcaseImage?: string;
  children: ReactNode;
}) {
  return (
    <div className="auth-shell">
      <aside
        className={`auth-showcase${showcaseImage ? " auth-showcase-has-photo" : ""}`}
        aria-label="Sportozen Academy"
      >
        {showcaseImage ? (
          <div className="auth-showcase-media" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={showcaseImage}
              alt=""
              className="auth-showcase-photo"
            />
            <div className="auth-showcase-scrim" />
          </div>
        ) : (
          <div className="auth-showcase-court" aria-hidden="true">
            <svg viewBox="0 0 420 520" fill="none">
              <rect
                x="20"
                y="20"
                width="380"
                height="480"
                rx="6"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <line
                x1="48"
                y1="20"
                x2="48"
                y2="500"
                stroke="currentColor"
                strokeWidth="1"
              />
              <line
                x1="372"
                y1="20"
                x2="372"
                y2="500"
                stroke="currentColor"
                strokeWidth="1"
              />
              <line
                x1="20"
                y1="260"
                x2="400"
                y2="260"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <line
                x1="20"
                y1="190"
                x2="400"
                y2="190"
                stroke="currentColor"
                strokeWidth="1"
              />
              <line
                x1="20"
                y1="330"
                x2="400"
                y2="330"
                stroke="currentColor"
                strokeWidth="1"
              />
              <line
                x1="210"
                y1="20"
                x2="210"
                y2="190"
                stroke="currentColor"
                strokeWidth="1"
              />
              <line
                x1="210"
                y1="330"
                x2="210"
                y2="500"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          </div>
        )}

        <div className="auth-showcase-top">
          <AuthBrandMark />
        </div>

        <div className="auth-showcase-body">
          <span className="auth-showcase-eyebrow">{eyebrow}</span>
          <h1>{storyTitle}</h1>
          <p className="auth-showcase-lead">{storyBody}</p>
          <ul className="auth-highlights">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text}>
                <Icon size={16} aria-hidden="true" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="auth-showcase-footer">
          <small>Private academy workspaces · Role-scoped access</small>
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-container">
          <div className="auth-card">{children}</div>
          <footer className="auth-legal" aria-label="Legal">
            <Link href="/terms">Terms of Service</Link>
            <span aria-hidden="true">·</span>
            <Link href="/privacy">Privacy Policy</Link>
          </footer>
        </div>
      </main>
    </div>
  );
}
