/**
 * Password strength policy for every password a person or an owner sets through the application
 * (self-service change, administrative reset, member provisioning).
 *
 * It follows NIST SP 800-63B: length matters most, there are no character-class rules, and
 * known-bad choices are rejected. Messages describe the rule that failed and never echo the
 * password. The list is deliberately small and offline; it is a floor, not a breach corpus.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export type PasswordContext = { email?: string; name?: string };
const WORDS = [
  "password",
  "passw0rd",
  "sportozen",
  "badminton",
  "academy",
  "welcome",
  "letmein",
  "qwerty",
  "asdfgh",
  "zxcvbn",
  "admin",
  "changeme",
  "temporary",
  "iloveyou",
  "shuttle",
  "smash",
  "coach",
  "trustno1",
  "football",
  "monkey",
  "dragon",
  "abc",
  "login",
  "secret",
];
const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
};
const flatten = (value: string) =>
  [...value.toLowerCase()].map((c) => LEET[c] ?? c).join("");
function runLength(value: string) {
  // Longest run of identical or consecutively stepping (+1/-1) characters.
  let best = 1;
  let same = 1;
  let up = 1;
  let down = 1;
  for (let i = 1; i < value.length; i++) {
    const step = value.charCodeAt(i) - value.charCodeAt(i - 1);
    same = step === 0 ? same + 1 : 1;
    up = step === 1 ? up + 1 : 1;
    down = step === -1 ? down + 1 : 1;
    best = Math.max(best, same, up, down);
  }
  return best;
}
/** Returns the first rule the password breaks, or null when it is acceptable. */
export function passwordProblem(
  password: string,
  context: PasswordContext = {},
): string | null {
  if (password.length < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH)
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (!password.trim()) return "A password cannot be only spaces.";
  const plain = password.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (runLength(plain) >= 6)
    return "Avoid repeated or sequential characters such as aaaaaa or 123456.";
  // Remove well-known words and digits (after undoing common substitutions). If almost nothing
  // personal is left, the password is a known word plus decoration.
  let rest = flatten(password).replace(/[^a-z]/g, "");
  for (const word of WORDS) rest = rest.split(word).join("");
  if (rest.length < 6)
    return "This password is too easy to guess. Use a longer passphrase of unrelated words.";
  const local = context.email
    ?.split("@")[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (local && local.length >= 4 && plain.includes(local))
    return "The password must not contain your email address.";
  for (const part of (context.name ?? "").toLowerCase().split(/\s+/))
    if (part.length >= 4 && plain.includes(part.replace(/[^a-z0-9]/g, "")))
      return "The password must not contain your name.";
  return null;
}
