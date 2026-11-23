import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuthShell } from "@/modules/identity/ui/auth-shell";

export default function TermsPage() {
  return (
    <AuthShell
      eyebrow="LEGAL"
      storyTitle={
        <>
          Clear terms for{" "}
          <br />
          every <em>academy.</em>
        </>
      }
      storyBody="Transparent expectations for academy owners, staff, guardians and players."
    >
      <Link href="/login" className="auth-back-link">
        <ArrowLeft size={15} aria-hidden="true" />
        <span>Back to sign in</span>
      </Link>
      <div className="auth-header">
        <span className="auth-eyebrow">Legal overview</span>
        <h2>Terms of Service</h2>
        <p className="auth-subtitle">
          Summary placeholder for academy workspace terms during UI review.
        </p>
      </div>
      <div className="auth-prose">
        <div>
          <h3>1. Private academy workspaces</h3>
          <p>
            Access to training schedules, reports, fees and messaging is scoped
            to your assigned academy membership and role.
          </p>
        </div>
        <div>
          <h3>2. Account stewardship</h3>
          <p>
            Account holders are responsible for keeping credentials private and
            using approved authentication controls.
          </p>
        </div>
      </div>
      <p className="auth-footer-switch">
        Need to register?{" "}
        <Link href="/signup" className="auth-link">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
