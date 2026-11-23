/**
 * Where two-factor authentication is required. Introduced in stages so that turning it on can
 * never lock the whole academy out. Two layers, and the STRICTER one wins for every role:
 *
 *   1. System policy, set by whoever runs the deployment (this file, from the environment):
 *        MFA_ENFORCEMENT=off      (default) nothing is required by the deployment.
 *        MFA_ENFORCEMENT=warn     affected roles are told to enrol but keep full access.
 *        MFA_ENFORCEMENT=enforce  affected roles without an authenticator can sign in but reach only
 *                                 the enrolment endpoints until they enrol. Never a lock-out: the way
 *                                 in is always "sign in, enrol, continue".
 *        MFA_REQUIRED_ROLES       roles the mode applies to; defaults to DEFAULT_REQUIRED_ROLES.
 *   2. Academy policy, chosen by that academy's owner in Settings (mfa-policy-store.ts), same
 *      shape (mode + roles). It can only raise a role's level, never lower what the system sets.
 *
 * Per role the outcome is a level: "optional" (MFA is available, nothing is asked), "warn" (told to
 * enrol, access unchanged) or "required" (must be enrolled to use the application). Nothing is
 * required anywhere until a mode is raised: both layers default to "off".
 *
 * A misspelt value makes authentication fail (closed, with a clear error) instead of silently
 * disabling the policy.
 */
export const ROLE_NAMES = [
  "OWNER",
  "ADMIN",
  "HEAD_COACH",
  "COACH",
  "FINANCE",
  "NUTRITION_PRO",
  "GUARDIAN",
  "ADULT_PLAYER",
] as const;
/**
 * Approved default for the roles a raised mode applies to: every staff role. GUARDIAN and
 * ADULT_PLAYER stay optional (they may enrol; nothing is asked of them unless an owner or the
 * deployment adds them). The default only matters once a mode above "off" is chosen.
 */
export const DEFAULT_REQUIRED_ROLES: readonly string[] = [
  "OWNER",
  "ADMIN",
  "HEAD_COACH",
  "COACH",
  "FINANCE",
  "NUTRITION_PRO",
];
export type MfaMode = "off" | "warn" | "enforce";
export const MFA_MODES: readonly MfaMode[] = ["off", "warn", "enforce"];
export type MfaPolicy = { mode: MfaMode; roles: readonly string[] };
export type MfaLevel = "optional" | "warn" | "required";
const LEVEL_RANK: Record<MfaLevel, number> = { optional: 0, warn: 1, required: 2 };
const MODE_RANK: Record<MfaMode, number> = { off: 0, warn: 1, enforce: 2 };
export class MfaPolicyError extends Error {}
export type Env = Readonly<Record<string, string | undefined>>;
export function mfaPolicy(env: Env = process.env): MfaPolicy {
  // An empty value (as in a copied .env.example) means "not set".
  const mode = (env.MFA_ENFORCEMENT?.trim() || "off").toLowerCase();
  if (mode !== "off" && mode !== "warn" && mode !== "enforce")
    throw new MfaPolicyError(
      `MFA_ENFORCEMENT must be off, warn or enforce (got "${mode}").`,
    );
  const listed = (env.MFA_REQUIRED_ROLES ?? "")
    .split(",")
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean);
  const unknown = listed.filter((r) => !ROLE_NAMES.includes(r as never));
  if (unknown.length)
    throw new MfaPolicyError(
      `MFA_REQUIRED_ROLES contains unknown roles: ${unknown.join(", ")}.`,
    );
  if (mode === "off") return { mode, roles: [] };
  return {
    mode,
    roles: listed.length ? listed : [...DEFAULT_REQUIRED_ROLES],
  };
}
/** Validates and orders a role list (unknown or repeated roles are errors, never ignored). */
export function normaliseRoles(input: readonly string[]) {
  const wanted = input.map((r) => r.trim().toUpperCase());
  const unknown = wanted.filter((r) => !ROLE_NAMES.includes(r as never));
  if (unknown.length)
    throw new MfaPolicyError(`Unknown roles: ${unknown.join(", ")}.`);
  if (new Set(wanted).size !== wanted.length)
    throw new MfaPolicyError("A role is listed more than once.");
  return ROLE_NAMES.filter((r) => wanted.includes(r));
}
/** What one policy layer asks of one role. */
export function levelFor(
  policy: { mode: MfaMode; roles: readonly string[] } | null,
  role: string | null,
): MfaLevel {
  if (!policy || !role || policy.mode === "off") return "optional";
  if (!policy.roles.includes(role)) return "optional";
  return policy.mode === "warn" ? "warn" : "required";
}
export const stricterLevel = (a: MfaLevel, b: MfaLevel): MfaLevel =>
  LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
export const stricterMode = (a: MfaMode, b: MfaMode): MfaMode =>
  MODE_RANK[a] >= MODE_RANK[b] ? a : b;
/** System layer and academy layer combined: the stricter one wins, per role. */
export const effectiveLevel = (
  system: MfaPolicy,
  academy: { mode: MfaMode; roles: readonly string[] } | null,
  role: string | null,
) => stricterLevel(levelFor(system, role), levelFor(academy, role));
export const mfaRequiredFor = (policy: MfaPolicy, role: string | null) =>
  policy.mode !== "off" && !!role && policy.roles.includes(role);
