import type { Drill } from "../types";

/** The five groups of the badminton drill library, in display order. */
export const DRILL_CATEGORIES = [
  {
    id: "footwork",
    name: "Footwork & agility",
    detail: "On court, with or without a shuttle",
    count: 10,
  },
  {
    id: "feeding",
    name: "Multi-shuttle feeding",
    detail: "A feeder sends many shuttles in a row",
    count: 10,
  },
  {
    id: "rally",
    name: "Shot consistency & rallies",
    detail: "Pairs rallying with one clear purpose",
    count: 10,
  },
  {
    id: "solo",
    name: "Solo & wall practice",
    detail: "Practice alone, no partner needed",
    count: 5,
  },
  {
    id: "fitness",
    name: "Off-court strength & conditioning",
    detail: "Strength, power and stamina away from the court",
    count: 15,
  },
] as const;

export type DrillCategoryId = (typeof DRILL_CATEGORIES)[number]["id"];

/** Safety lines used by many drills. Statements only: no distances, counts or
 * medical claims. The coach adapts them to the group in front of them. */
export const SAFE = {
  floor:
    "Check that the floor is dry, clean and free of loose shuttles, and that footwear grips well.",
  shuttles:
    "Keep spare shuttles in a basket or against the wall, never on the playing area.",
  space:
    "Give each pair clear space with a gap to the next court; stop and reset if paths cross.",
  water:
    "Allow water breaks, and slow down or stop any player who looks tired or unwell.",
  stop: "Any player may stop at once without giving a reason; the coach stops the drill if control or spacing is lost.",
  eyes: "Feeders and partners stay out of the line of a full smash; protective eyewear is a good habit for fast drills.",
  landing:
    "Land softly on the whole foot with knees bent, and stop the drill when landings turn heavy or noisy.",
  warm: "Warm up properly first; start light and add effort only when movement is smooth.",
  load: "Start with no weight or a very light one; the coach, not the player, decides when to add load.",
  band: "Check the band for nicks or tears before use, and keep it anchored where it cannot snap back at anyone.",
} as const;

export const SOURCE =
  "General badminton coaching practice. Wording is original to Sportozen; no drill-specific publisher page was opened or verified.";
export const REVIEW =
  "Original Sportozen wording · qualified badminton coach review required";

export const s = (text: string): string[] => text.split("|");

type Authored = {
  title: string;
  skill: Drill["skill"];
  level: "Beginner" | "Intermediate" | "Advanced";
  format: "Singles" | "Doubles" | "Both";
  minutes: number;
  players: number;
  equipment: string[];
  objective: string;
  setup: string;
  steps: string;
  cues: string;
  mistakes: string;
  easier: string;
  harder: string;
  safety: string[];
  minimumAge?: number;
};

/** Builds one catalogue entry. The id, version and origin are fixed here so an
 * author cannot get them wrong. */
export function drill(
  number: number,
  category: DrillCategoryId,
  a: Authored,
): Drill {
  return {
    id: `bd-${String(number).padStart(2, "0")}`,
    version: 1,
    academyId: null,
    number,
    category,
    title: a.title,
    skill: a.skill,
    level: a.level,
    format: a.format,
    minutes: a.minutes,
    players: a.players,
    equipment: a.equipment,
    objective: a.objective,
    setup: a.setup,
    steps: s(a.steps),
    cues: s(a.cues),
    mistakes: s(a.mistakes),
    easier: a.easier,
    harder: a.harder,
    safety: a.safety,
    ...(a.minimumAge ? { minimumAge: a.minimumAge } : {}),
    source: SOURCE,
    review: REVIEW,
  };
}
