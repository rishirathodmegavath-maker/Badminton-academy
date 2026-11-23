/**
 * Display labels (Wave 1, V2/V3/V5/V7). Presentation only: stored values, API payloads and the values a form submits
 * are unchanged. Every raw value that reaches the screen goes through here so that the words, the case and the date
 * style are the same on every screen.
 *
 * Rules (UX decision register UX-D5, UX-D10, UX-D17): sentence case, "Email" (not "E-mail"), dates as "21 Nov 2026".
 */

/** "PART_PAID" → "Part paid"; "Active" → "Active"; "" → "". Sentence case, underscores become spaces. */
export function sentence(value: string): string {
  const text = value.replaceAll("_", " ").trim().toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

/** Names that are not plain sentence case of the stored value. */
const SPECIAL: Readonly<Record<string, string>> = {
  PORTAL: "Portal",
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
  PRIVATE_PORTAL: "Private portal",
  READY_TO_SHARE: "Ready to share",
  PART_PAID: "Part paid",
  // Admissions stages that are not a plain word.
  FOLLOW_UP: "Follow-up due",
};

/** The label for a stored status, stage, role or channel value. Unknown values fall back to sentence case. */
export function label(value: string): string {
  return SPECIAL[value] ?? sentence(value);
}

/** Communication channels in the order they are offered. */
export const CHANNELS = ["PORTAL", "EMAIL", "WHATSAPP"] as const;
export const channelLabel = (c: string) => label(c);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * "2026-11-21" (or an ISO timestamp, whose first ten characters are used) → "21 Nov 2026".
 * Anything that is not a calendar date is returned unchanged, so a free-text value is never lost or mangled.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return value;
  return `${Number(m[3])} ${MONTHS[month - 1]} ${m[1]}`;
}

/** "2026-11-21", "17:00" → "21 Nov 2026 · 17:00". Times are shown as stored (24-hour). */
export function formatDateTime(date: string, time?: string | null): string {
  return time ? `${formatDate(date)} · ${time}` : formatDate(date);
}

/** One wording for the environment notice, shown only when the application is not running as production. */
export const ENVIRONMENT_NOTICE = "Local pilot · fictional data";
