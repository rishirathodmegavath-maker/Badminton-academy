import { randomInt } from "node:crypto";
/** A temporary password is valid for 72 hours from issue, then it is refused. */
export const TEMPORARY_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;
// 31 symbols: no 0/O, 1/I/L, so the value can be read aloud or copied by hand without ambiguity.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const GROUPS = 4;
const GROUP_LENGTH = 4;
/**
 * 16 symbols from node:crypto's CSPRNG (rejection-sampled by randomInt, so unbiased), about 79 bits
 * of entropy, shown as XXXX-XXXX-XXXX-XXXX. It is never derived from the user, the clock or a
 * counter, and only its hash is stored.
 */
export function generateTemporaryPassword() {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = "";
    for (let i = 0; i < GROUP_LENGTH; i++)
      group += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(group);
  }
  return groups.join("-");
}
export const temporaryPasswordExpiry = (from = new Date()) =>
  new Date(from.getTime() + TEMPORARY_PASSWORD_TTL_MS);
