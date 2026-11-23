import {
  ACCOUNT_TYPE_LABELS,
  DESIGNATION_LABELS,
  authorityOf,
  can,
  rolesWith,
  type Capability,
  type RoleHolder,
} from "../../identity/authority";
/**
 * Workspace navigation: the module list, their URLs and which modules an account is offered.
 *
 * RC-5: every decision here is derived from the authority module (`can`), never from a role list of its own.
 * This is a presentation convenience only. Every request is authorised on the server (`requireCapability`,
 * `accessiblePlayers`, the role-shaped bootstrap payload), so hiding a module here is never what protects data,
 * and a person who types a URL they are not offered still receives the access-denied screen and empty server data.
 * Each module names the capabilities whose server endpoints it fronts, so a visible item never leads to a dead end.
 */
export const MODULES = [
  { slug: "overview", label: "Overview" },
  { slug: "admissions", label: "Admissions" },
  { slug: "players", label: "Players" },
  { slug: "calendar", label: "Calendar" },
  { slug: "training", label: "Training" },
  { slug: "reports", label: "Reports" },
  { slug: "nutrition", label: "Nutrition" },
  { slug: "video", label: "Video & AI Analysis" },
  { slug: "fees", label: "Fees" },
  { slug: "communications", label: "Communications" },
  { slug: "settings", label: "Settings" },
] as const;

export type ModuleSlug = (typeof MODULES)[number]["slug"];

/**
 * A staff module opens for an account that holds `portal.staff` AND at least one of the capabilities listed.
 * (Family accounts hold read capabilities such as `reports.read`; they never reach a staff module because they do
 * not hold `portal.staff`.)
 */
const MODULE_CAPABILITIES: Readonly<Record<ModuleSlug, readonly Capability[]>> = {
  overview: ["portal.staff"],
  admissions: ["admissions.manage"],
  // Managers edit every player; a coach works with the players of the batches they coach (scope COACHED_BATCHES).
  players: ["players.manage", "sessions.coach"],
  calendar: ["calendar.manage", "sessions.schedule"],
  training: ["training.studio"],
  reports: ["reports.author", "reports.approve"],
  nutrition: ["nutrition.author", "nutrition.approve"],
  video: ["media.manage"],
  fees: ["finance.manage"],
  communications: ["comms.author", "comms.approve"],
  settings: ["academy.settings", "academy.structure"],
};

/** Stored roles that use the staff workspace at `/`, and those that use `/family`. Derived, never listed here. */
export const STAFF_ROLES: readonly string[] = rolesWith("portal.staff");
export const FAMILY_ROLES: readonly string[] = rolesWith("family.portal");

/** Uses the staff workspace at `/` (capability `portal.staff`). Unknown or missing roles: no. */
export const isStaffAccount = (actor: RoleHolder) => can(actor, "portal.staff");
/** Uses the Family Portal at `/family` (capability `family.portal`). Unknown or missing roles: no. */
export const isFamilyAccount = (actor: RoleHolder) => can(actor, "family.portal");

export const canOpen = (role: string, slug: string): boolean => {
  const actor = { role };
  if (!isStaffAccount(actor)) return false;
  const needs = (MODULE_CAPABILITIES as Record<string, readonly Capability[] | undefined>)[slug];
  // `Object.hasOwn` keeps "constructor", "__proto__" and the like from resolving to anything.
  if (!needs || !Object.hasOwn(MODULE_CAPABILITIES, slug)) return false;
  return needs.some((c) => can(actor, c));
};

export const modulesForRole = (role: string): ModuleSlug[] =>
  MODULES.map((m) => m.slug).filter((slug) => canOpen(role, slug));

/**
 * Modules that exist as routes but are not offered in the menu (UX-D8: an unbuilt feature does not occupy a navigation
 * slot). Presentation only: the module, its URL, `canOpen` and every server check are unchanged, so a person who types
 * the address is handled exactly as before.
 */
export const HIDDEN_FROM_MENU: readonly ModuleSlug[] = ["video"];

/** The modules shown in the menu for a role: those it can open, less the ones hidden from the menu. */
export const menuModulesForRole = (role: string): ModuleSlug[] =>
  modulesForRole(role).filter((slug) => !HIDDEN_FROM_MENU.includes(slug));

/** One specific sentence per module for the page header (UX V4); never reused across pages. */
export const MODULE_SUBTITLES: Readonly<Record<ModuleSlug, string>> = {
  overview: "Today's sessions, fees and reports at a glance.",
  admissions: "Follow enquiries from first contact to enrolment.",
  players: "Player profiles, batches and guardian contacts.",
  calendar: "Plan sessions and see what is on each day.",
  training: "Thoughtful sessions. Meaningful progress. More time for your players.",
  reports: "Write, review and share monthly player reports.",
  nutrition: "Nutrition plans, prepared and reviewed for your players.",
  video: "Video review for coaching sessions.",
  fees: "Fee plans, invoices and payments.",
  communications: "Announcements and messages to parents.",
  settings: "Academy details, team, sessions and integrations.",
};

/**
 * Where an account lands: academy-wide staff (player scope ALL) on Overview, coaching staff on Training, the
 * specialised designations in their own module. Anything else gets Overview, which it cannot open (access denied).
 */
export function defaultModule(role: string): ModuleSlug {
  const actor = { role };
  if (!isStaffAccount(actor)) return "overview";
  if (authorityOf(role)?.scope === "ALL") return "overview";
  if (can(actor, "training.studio")) return "training";
  if (can(actor, "finance.manage")) return "fees";
  if (can(actor, "nutrition.approve")) return "nutrition";
  return "overview";
}

/** Whether the academy-wide Overview is shown (player scope ALL); other staff see their own role home there. */
export const seesAcademyOverview = (role: string) =>
  isStaffAccount({ role }) && authorityOf(role)?.scope === "ALL";

export const isFamilyRole = (role: string) => isFamilyAccount({ role });

/**
 * Presentation label of a stored role: "Owner", "Staff · Head Coach", "Guardian", "Player". Display only (D2: the
 * stored value is unchanged and is what every request sends); a value that is not a stored role is shown as such.
 */
export function accountLabel(role: string): string {
  const a = authorityOf(role);
  if (!a) return "Unsupported role";
  const type = ACCOUNT_TYPE_LABELS[a.accountType];
  return a.designation ? `${type} · ${DESIGNATION_LABELS[a.designation]}` : type;
}

export const slugOfLabel = (label: string): ModuleSlug | undefined =>
  MODULES.find((m) => m.label === label)?.slug;
export const labelOfSlug = (slug: string): string | undefined =>
  MODULES.find((m) => m.slug === slug)?.label;
export const hrefOf = (slug: ModuleSlug) => `/${slug}`;

/** `/players` → `players`; anything that is not a workspace module (including `/`) → undefined. */
export function slugOfPath(pathname: string): ModuleSlug | undefined {
  const first = pathname.split("/").filter(Boolean)[0];
  return MODULES.find((m) => m.slug === first)?.slug;
}

/** Family portal sections, in display order. */
export const FAMILY_TABS = [
  "Home",
  "Schedule",
  "Reports",
  "Nutrition",
  "Fees",
  "Video",
  "Messages",
  "Access & preferences",
] as const;
