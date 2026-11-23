import { ageState, type AgeState } from "./age";

export { ageState };

const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** One short line saying where a player stands. */
export function ageStateLabel(state: AgeState): string {
  switch (state.kind) {
    case "OK":
      return "";
    case "BIRTH_DATE_MISSING":
      return "No date of birth yet: players must be under 18, so it is required";
    case "TURNING_18":
      return state.inDays <= 0 ? `Turns 18 today (${day(state.on)})` : `Turns 18 in ${state.inDays} day${state.inDays === 1 ? "" : "s"} (${day(state.on)})`;
    case "DECIDE":
      return `Turned 18 on ${day(state.turnedOn)}: archive, or keep for now`;
    case "KEPT":
      return `Over 18, kept for now until ${day(state.until)}`;
  }
}
