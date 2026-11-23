/** Responses that mean "finish your account setup first": send the person to the account page. */
export const GATE_CODES = [
  "PASSWORD_CHANGE_REQUIRED",
  "TEMPORARY_PASSWORD_EXPIRED",
  "MFA_ENROLLMENT_REQUIRED",
];
export function redirectIfGated(
  status: number,
  body: { code?: string } | null,
) {
  if (status === 403 && body?.code && GATE_CODES.includes(body.code)) {
    window.location.assign("/account");
    return true;
  }
  return false;
}
