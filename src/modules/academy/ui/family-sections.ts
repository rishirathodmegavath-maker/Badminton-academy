/**
 * The family portal's sections and their addresses (UX Wave 2/4). Four primary items; the other sections belong to one
 * of them. Navigation only: every section loads the same authorised data and the server decides what each person may
 * read or change.
 */
export const PRIMARY_ITEMS = ["Home", "Schedule", "Messages", "More"] as const;
export type Section = "Home" | "Schedule" | "Reports" | "Messages" | "More" | "Fees" | "Nutrition" | "Access & preferences";
/** The address of each section: `/family?section=<slug>`. Home is the plain `/family`. */
export const SECTION_SLUGS: Record<Section, string> = {
  Home: "home",
  Schedule: "schedule",
  Reports: "reports",
  Messages: "messages",
  More: "more",
  Fees: "fees",
  Nutrition: "nutrition",
  "Access & preferences": "access",
};
/** Which primary item a section belongs to (the one shown as current). */
export const PRIMARY_OF: Record<Section, (typeof PRIMARY_ITEMS)[number]> = {
  Home: "Home",
  Schedule: "Schedule",
  Reports: "Schedule",
  Messages: "Messages",
  More: "More",
  Fees: "More",
  Nutrition: "More",
  "Access & preferences": "More",
};
export const isSection = (name: string): name is Section => Object.hasOwn(SECTION_SLUGS, name);
/** A known slug gives its section; anything else (missing, misspelt, hostile) gives Home. */
export const sectionOfSlug = (slug: string | null): Section =>
  (Object.keys(SECTION_SLUGS) as Section[]).find((name) => SECTION_SLUGS[name] === slug) ?? "Home";
export const urlOfSection = (section: Section) => (section === "Home" ? "/family" : `/family?section=${SECTION_SLUGS[section]}`);
