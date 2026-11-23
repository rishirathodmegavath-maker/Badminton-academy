import { isIP } from "node:net";
/**
 * Which client address the sign-in rate limiter may believe.
 *
 * A browser can send any `X-Forwarded-For` it likes, and the Next.js server only fills that header
 * in when the client did NOT send one (next/dist/server/base-server.js: `x-forwarded-for ??=
 * socket.remoteAddress`). A route handler also cannot see the socket. So a forwarded-for header is
 * trustworthy only when infrastructure we control sits in front of the app, overwrites/appends it,
 * and is the only way to reach the app. That cannot be detected from inside the process, so it is
 * an explicit deployment setting:
 *
 *   TRUSTED_PROXIES        comma-separated IPs/CIDRs of the proxy hops in front of the app.
 *                          Setting it declares: "all traffic arrives through these proxies and
 *                          they append the connecting client's address to the header".
 *   TRUSTED_CLIENT_IP_HEADER  header to read (default x-forwarded-for).
 *
 * Unset (the default) the header is ignored completely. Every client then shares one bucket per
 * endpoint: brute forcing stays limited no matter what headers an attacker sends, at the cost that
 * one attacker can also throttle everyone else. That is the safe failure; configure the proxy
 * list to get per-client limits.
 */
export type Env = Readonly<Record<string, string | undefined>>;
export class ClientIpConfigError extends Error {}
export type ClientIpConfig = {
  ipAddressHeaders: string[];
  trustedProxies?: string[];
};
const HEADER = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
function validEntry(entry: string) {
  const [address, prefix, ...rest] = entry.split("/");
  const family = isIP(address);
  if (!family || rest.length) return false;
  if (prefix === undefined) return true;
  return (
    /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)
  );
}
export function parseTrustedProxies(value: string | undefined) {
  const entries = (value ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  // A zero-length prefix ("0.0.0.0/0", "::/0") would believe every connecting address, which
  // lets any client forge the header: it is the opposite of declaring a proxy.
  const everyone = entries.filter(
    (e) => validEntry(e) && /\/0+$/.test(e),
  );
  if (everyone.length)
    throw new ClientIpConfigError(
      `TRUSTED_PROXIES must list your proxies, not every address (${everyone.join(", ")} matches all clients).`,
    );
  const invalid = entries.filter((e) => !validEntry(e));
  if (invalid.length)
    throw new ClientIpConfigError(
      `TRUSTED_PROXIES contains entries that are not an IP address or CIDR range: ${invalid.join(", ")}`,
    );
  return entries;
}
export function clientIpConfig(env: Env): ClientIpConfig {
  const trustedProxies = parseTrustedProxies(env.TRUSTED_PROXIES);
  if (!trustedProxies.length) return { ipAddressHeaders: [] };
  const header = (env.TRUSTED_CLIENT_IP_HEADER ?? "x-forwarded-for")
    .trim()
    .toLowerCase();
  if (!HEADER.test(header))
    throw new ClientIpConfigError(
      "TRUSTED_CLIENT_IP_HEADER is not a valid header name.",
    );
  return { ipAddressHeaders: [header], trustedProxies };
}
export const clientIpTrusted = (env: Env) =>
  parseTrustedProxies(env.TRUSTED_PROXIES).length > 0;
