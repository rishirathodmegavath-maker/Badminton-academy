/**
 * Client-safe vocabulary for "Continue with Google" (no server imports, so the login and account pages can use it).
 */
/** Stable, value-free words for the security log and the login screen. */
export type GoogleRefusal =
  | "account_not_linked"
  | "mfa_enrolled"
  | "not_provisioned"
  | "email_mismatch"
  | "email_not_verified"
  | "temporary_password_expired"
  | "terms_required"
  | "no_account"
  | "cancelled"
  | "wrong_address"
  | "other";

/** Map the error code Better Auth puts on the redirect to one of ours. */
export function refusalFrom(code: string | null | undefined): GoogleRefusal {
  const c = (code ?? "").toLowerCase();
  if (c.includes("account_not_linked") || c.includes("account not linked")) return "account_not_linked";
  if (c.includes("google_sign_in_not_available_with_mfa")) return "mfa_enrolled";
  if (c.includes("google_account_not_provisioned")) return "not_provisioned";
  if (c.includes("different_email") || c.includes("email_doesn")) return "email_mismatch";
  if (c.includes("unverified") || c.includes("not_verified")) return "email_not_verified";
  if (c.includes("temporary_password_expired")) return "temporary_password_expired";
  if (c.includes("terms_required")) return "terms_required";
  if (c.includes("signup_disabled") || c.includes("sign_up_disabled") || c.includes("sign up disabled")) return "no_account";
  // The browser began on one address and Google sent it back to another (127.0.0.1 and localhost are different
  // origins, so the state cookie set by the first is not sent to the second).
  if (c.includes("state_mismatch") || c.includes("please_restart_the_process")) return "wrong_address";
  if (c.includes("access_denied") || c.includes("cancel")) return "cancelled";
  return "other";
}

/** What the login and account screens say for each refusal. No detail that would help someone probe accounts. */
export const GOOGLE_REFUSAL_MESSAGES: Record<GoogleRefusal, string> = {
  account_not_linked:
    "That Google account isn’t linked to an academy account. Sign in with your email and password, then link Google in Account security.",
  mfa_enrolled:
    "This account uses an authenticator app, so Google sign-in isn’t available for it. Sign in with your password and code.",
  not_provisioned: "That Google account can’t be used here. Ask your academy owner to set up your access.",
  email_mismatch: "The Google account must use the same email address as your academy account.",
  email_not_verified: "Google hasn’t verified that email address, so it can’t be linked.",
  temporary_password_expired:
    "This temporary password has expired. Ask your academy owner to issue a new one.",
  terms_required:
    "Accept the Terms of Service and Privacy Policy on the sign-up page, then continue with Google.",
  no_account:
    "There is no Sportozen account for that Google address yet. Create an account first, or sign in with your email and password.",
  cancelled: "Google sign-in was cancelled. You can try again or use your password.",
  wrong_address:
    "Google sign-in has to start and finish on the same web address (127.0.0.1 and localhost are different addresses). Open Sportozen at the address your administrator gave you, then try again.",
  other: "Google sign-in didn’t complete. Try again, or sign in with your email and password.",
};
