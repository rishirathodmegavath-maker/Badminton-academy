/**
 * Why a signed-in account may not use an academy workspace, in words for the person.
 * Client-safe (no server imports), like google-messages.ts: the server picks the code and sentence in
 * resolveActor (access.ts); the workspace uses the code to avoid adding a misleading hint to it.
 *
 * Signing in proves who someone is; belonging to an academy is a separate, owner-managed fact. None of
 * these sentences names an academy, a membership or an identifier.
 */
export const MEMBERSHIP_MESSAGES = {
  NO_MEMBERSHIP:
    "You are signed in, but your account is not assigned to an academy yet. Ask your academy owner to give you access.",
  MEMBERSHIP_INACTIVE:
    "You are signed in, but your access to the academy has been switched off. Ask your academy owner to restore it.",
  // The person belongs to several academies and has not chosen one for this session yet (0017). Nothing about any
  // academy is in the answer; the academy chooser lists only the person's own memberships.
  ACADEMY_SELECTION_REQUIRED:
    "Your account belongs to more than one academy. Choose which academy you want to work in.",
} as const;
export type MembershipCode = keyof typeof MEMBERSHIP_MESSAGES;
export const MEMBERSHIP_CODES = Object.keys(
  MEMBERSHIP_MESSAGES,
) as MembershipCode[];
export const isMembershipCode = (code: unknown): code is MembershipCode =>
  typeof code === "string" && (MEMBERSHIP_CODES as string[]).includes(code);
