import type { Drill } from "../types";
import { DRILL_CATEGORIES } from "./define";
import { feeding } from "./feeding";
import { fitness } from "./fitness";
import { footwork } from "./footwork";
import { rally, solo5 } from "./rally-solo";

export { DRILL_CATEGORIES } from "./define";
export type { DrillCategoryId } from "./define";

/**
 * The badminton drill library: the approved 50 drills in their original
 * numbering. It is code, changed only by a reviewed release, and read-only at
 * run time, like the football library. Academies add private drills beside it.
 */
export const BADMINTON_CATALOGUE: readonly Drill[] = Object.freeze(
  [...footwork, ...feeding, ...rally, ...solo5, ...fitness].sort(
    (a, b) => (a.number ?? 0) - (b.number ?? 0),
  ),
);

export function findCatalogueDrill(
  id: string,
  version?: number,
): Drill | undefined {
  return BADMINTON_CATALOGUE.find(
    (d) => d.id === id && (version === undefined || d.version === version),
  );
}

export const categorySummary = () =>
  DRILL_CATEGORIES.map((c) => ({
    id: c.id,
    name: c.name,
    detail: c.detail,
    initialCount: c.count,
    publishedCount: BADMINTON_CATALOGUE.filter((d) => d.category === c.id)
      .length,
  }));
