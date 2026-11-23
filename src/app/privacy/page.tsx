import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuthShell } from "@/modules/identity/ui/auth-shell";

export default function PrivacyPage() {
  return (
    <AuthShell
      eyebrow="DATA PROTECTION"
      storyTitle={
        <>
          Privacy built into{" "}
          <br />
          every <em>record.</em>
        </>
      }
      storyBody="Role-scoped visibility, explicit guardian permissions and auditable access logs."
    >
      <Link href="/login" className="auth-back-link">
        <ArrowLeft size={15} aria-hidden="true" />
        <span>Back to sign in</span>
      </Link>
      <div className="auth-header">
        <span className="auth-eyebrow">Legal overview</span>
        <h2>Privacy Policy</h2>
        <p className="auth-subtitle">
          Summary placeholder for Sportozen Academy privacy notices during UI review.
        </p>
      </div>
      <div className="auth-prose">
        <div>
          <h3>1. Role-restricted records</h3>
          <p>
            Student, nutrition, financial and communication records are disclosed
            only to authorised academy staff, adult players or permitted guardians.
          </p>
        </div>
        <div>
          <h3>2. Consent & adult control</h3>
          <p>
            Channel preferences and adult player access permissions are managed
            explicitly by the authorised account holder.
          </p>
        </div>
      </div>
      <p className="auth-footer-switch">
        Need a new profile?{" "}
        <Link href="/signup" className="auth-link">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
