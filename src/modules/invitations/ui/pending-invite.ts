/**
 * An invitation link carries its token in the URL FRAGMENT (it reaches no server log or Referer). The person may have to sign
 * in or create an account before accepting, which navigates away, so the page keeps the token for THIS TAB ONLY in
 * sessionStorage, and the sign-in screens send the person back to /invite afterwards. It is removed as soon as the invitation
 * is accepted, refused or abandoned. Storage may be unavailable (private windows), so every call fails soft: the person then
 * simply opens the link again.
 */
const KEY = "sportozen.invite";
export function rememberInvite(token: string) {
  try {
    window.sessionStorage.setItem(KEY, token);
  } catch {
    /* the link can be opened again */
  }
}
export function pendingInvite(): string | null {
  try {
    const value = window.sessionStorage.getItem(KEY);
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}
export function forgetInvite() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}
