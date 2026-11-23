import { and, eq, sql } from "drizzle-orm";
import { database } from "../../infrastructure/database/client";
import * as t from "../../infrastructure/database/schema";
import { defaultSettings } from "../academy/domain/types";
import { selectAcademy } from "./active-academy";

/**
 * Self-service academy creation: a signed-in person starts an academy of their own and becomes its owner. Until now the
 * only way to get an owner was for an operator to write one into the database, so a person who signed up landed on
 * "not part of an academy yet" with nothing they could do. Owners then add coaches, families and players the usual way
 * (an invitation link or by hand, see the invitations module).
 *
 * The academy, its settings, its feature set and its first OWNER membership are written in ONE transaction. The database
 * refuses an academy that is left without an owner (membership_owner_presence), so there is never an academy nobody can
 * manage. The new academy is then made the one this session works in.
 */
export const ACADEMY_NAME_MIN = 2;
export const ACADEMY_NAME_MAX = 80;
export const CITY_MAX = 80;
/** A person may own at most this many academies. Stops one account from filling the system with empty academies. */
export const MAX_OWNED_ACADEMIES = 5;

/** The countries this application is built for (fees, invoices and dates are typed to these two), with their defaults. */
export const COUNTRIES = {
  IN: { name: "India", currency: "INR", timezone: "Asia/Kolkata" },
  US: { name: "United States", currency: "USD", timezone: "America/New_York" },
} as const;
export type CountryCode = keyof typeof COUNTRIES;
export type CurrencyChoice = "INR" | "USD";

/**
 * What every new academy starts with. There is no billing in this pilot (see the Subscription tab), so a new academy gets the
 * same four capabilities the demonstration academies have. When billing exists this is the one place to change.
 */
export const NEW_ACADEMY_FEATURES = { reports: true, nutrition: true, communications: true, manualVideo: true } as const;

export class AcademyCreationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
    readonly code:
      | "ACADEMY_NAME_INVALID"
      | "CONTACT_EMAIL_INVALID"
      | "CITY_INVALID"
      | "TIMEZONE_INVALID"
      | "ACADEMY_LIMIT",
  ) {
    super(message);
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const squash = (raw: string) => raw.replace(/\s+/g, " ").trim();

/** Trim, collapse inner whitespace; refuse control characters and lengths outside the limits. */
export function cleanAcademyName(raw: string) {
  const name = squash(raw);
  if (CONTROL.test(name) || name.length < ACADEMY_NAME_MIN || name.length > ACADEMY_NAME_MAX)
    throw new AcademyCreationError(
      `The academy name must be ${ACADEMY_NAME_MIN} to ${ACADEMY_NAME_MAX} characters.`,
      400,
      "ACADEMY_NAME_INVALID",
    );
  return name;
}

export function cleanCity(raw: string) {
  const city = squash(raw);
  if (CONTROL.test(city) || city.length < 2 || city.length > CITY_MAX)
    throw new AcademyCreationError(`Enter the city (2 to ${CITY_MAX} characters).`, 400, "CITY_INVALID");
  return city;
}

/** A plain address: one @, a dot in the domain, no spaces. It is where the academy can be reached, not a login. */
export function cleanContactEmail(raw: string) {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new AcademyCreationError("Enter a valid contact email address for the academy.", 400, "CONTACT_EMAIL_INVALID");
  return email;
}

/** An IANA time zone the runtime knows (for example Asia/Kolkata). */
export function validTimezone(zone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone.length > 0 && zone.length <= 64;
  } catch {
    return false;
  }
}

export type NewAcademy = {
  name: string;
  contactEmail: string;
  country: CountryCode;
  city: string;
  currency: CurrencyChoice;
  /** Optional: the country's usual time zone is used when it is left out. */
  timezone?: string;
};

export async function createAcademyFor(userId: string, sessionId: string, input: NewAcademy) {
  const name = cleanAcademyName(input.name);
  const city = cleanCity(input.city);
  const contactEmail = cleanContactEmail(input.contactEmail);
  const timezone = input.timezone?.trim() || COUNTRIES[input.country].timezone;
  if (!validTimezone(timezone))
    throw new AcademyCreationError("Choose a valid time zone for the academy.", 400, "TIMEZONE_INVALID");
  const academyId = crypto.randomUUID();
  await database().transaction(async (tx) => {
    // One creation at a time per person, so the limit below cannot be beaten by two requests at once.
    await tx.execute(sql`select id from app_user where id = ${userId} for update`);
    const owned = await tx
      .select({ academyId: t.memberships.academyId })
      .from(t.memberships)
      .where(and(eq(t.memberships.userId, userId), eq(t.memberships.role, "OWNER"), eq(t.memberships.active, true)));
    if (owned.length >= MAX_OWNED_ACADEMIES)
      throw new AcademyCreationError(
        `You already own ${MAX_OWNED_ACADEMIES} academies, which is the most one account can start.`,
        409,
        "ACADEMY_LIMIT",
      );
    await tx.insert(t.academies).values({ id: academyId, name, timezone });
    await tx.insert(t.academySettings).values({
      academyId,
      version: 1,
      data: { ...defaultSettings, country: input.country, currency: input.currency, city, contactEmail },
    });
    await tx.insert(t.entitlements).values({ academyId, data: { ...NEW_ACADEMY_FEATURES } });
    await tx.insert(t.memberships).values({ academyId, userId, role: "OWNER", active: true });
  });
  const picked = await selectAcademy(userId, sessionId, academyId);
  return { academyId, name, timezone, role: "OWNER" as const, selected: !!picked };
}
