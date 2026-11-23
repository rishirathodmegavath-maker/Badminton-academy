/**
 * A report link carries its token in the URL FRAGMENT (it reaches no server log or Referer). A parent who is not signed in has to
 * sign in first, which navigates away, so the page keeps the token for THIS TAB ONLY in sessionStorage and the sign-in screen sends
 * the person back to /report-link afterwards. It is removed as soon as the report is opened or refused. Storage may be unavailable
 * (a private window), so every call fails soft: the parent then simply opens the link again.
 */
const KEY = "sportozen.report-link";
const SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i;
export const looksLikeReportLink = (value: string) => SHAPE.test(value);
export function rememberReportLink(token: string) {
  try {
    window.sessionStorage.setItem(KEY, token);
  } catch {
    /* the link can be opened again */
  }
}
export function pendingReportLink(): string | null {
  try {
    const value = window.sessionStorage.getItem(KEY);
    return value && SHAPE.test(value) ? value : null;
  } catch {
    return null;
  }
}
export function forgetReportLink() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}
