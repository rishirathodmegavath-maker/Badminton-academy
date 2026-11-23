const KEY = "sportozen.pendingEmail";

/**
 * The address a person is verifying travels between screens in sessionStorage (this tab only, gone when it
 * closes), so it is not placed in the URL. Storage can be unavailable (private mode, blocked): every call is safe.
 */
export function rememberPendingEmail(email: string) {
  try {
    window.sessionStorage.setItem(KEY, email.trim().toLowerCase());
  } catch {
    // The verify screen asks for the address when it is not remembered.
  }
}
export function readPendingEmail(): string {
  try {
    return window.sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}
export function forgetPendingEmail() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // nothing to forget
  }
}
