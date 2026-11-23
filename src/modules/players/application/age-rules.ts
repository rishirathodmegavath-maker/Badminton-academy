import { eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import { DomainError } from "../../training/domain/rules";
import type { Tx } from "../../academy/application/access";
import { isCalendarDay, isUnder18, ageState, type AgeDecision } from "../domain/age";

/** Today's date in the academy's own calendar (its time zone), as YYYY-MM-DD. */
export async function academyToday(tx: Tx, academyId: string, now = new Date()): Promise<string> {
  const [row] = await tx.select({ timezone: t.academies.timezone }).from(t.academies).where(eq(t.academies.id, academyId));
  const zone = row?.timezone || "UTC";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Every way a player record comes into being or changes goes through this: the player form, the conversion of an
 * enquiry, and anything added later. Players are under 18 and always have a date of birth.
 *   - Adult players do not exist here: the adult flag and self-access are refused.
 *   - A date of birth is required and must be a real day that is not in the future.
 *   - A player who is 18 or older is refused, except to archive them, or while the owner's "keep for now" decision about
 *     that very player has not run out (it is only ever recorded by the age review, never by editing the profile).
 */
export function requireUnder18(
  profile: { birthDate?: string | null; adult?: boolean; selfUserId?: string | null; status?: string | null },
  today: string,
  decision: AgeDecision | null | undefined,
): void {
  if (profile.adult || profile.selfUserId)
    throw new DomainError("Adult players are not supported: every player must be under 18.", 422, "ADULT_PLAYERS_NOT_SUPPORTED");
  const birth = (profile.birthDate ?? "").trim();
  if (!birth) throw new DomainError("Enter the player's date of birth.", 422, "BIRTH_DATE_REQUIRED");
  if (!isCalendarDay(birth) || birth > today) throw new DomainError("Choose a valid birth date.", 422, "BIRTH_DATE_INVALID");
  if (profile.status === "ARCHIVED" || isUnder18(birth, today)) return;
  if (ageState({ birthDate: birth, status: profile.status, ageDecision: decision ?? null }, today).kind === "KEPT") return;
  throw new DomainError(
    "Players must be under 18. This date of birth makes the player 18 or older, so the owner has to decide in the age review.",
    422,
    "PLAYER_NOT_UNDER_18",
  );
}
