/**
 * Result of one provider call, in the only terms the outbox needs:
 *   sent   the provider ACCEPTED the message (this is not proof of delivery or reading; no receipts are processed)
 *   retry  a temporary failure (network, timeout, rate limit, provider 5xx): trying again later may work
 *   failed a permanent failure (bad credentials, bad address, rejected content): trying again will not help
 * `detail` is short, safe to store and show: it never contains a credential, a request body or an address.
 */
export type SendResult =
  | { kind: "sent"; providerId: string }
  | { kind: "retry"; detail: string }
  | { kind: "failed"; detail: string };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

let override: FetchLike | null = null;
/** Tests install a fake provider here. Production never calls it. */
export function setProviderFetchForTests(fn: FetchLike | null) {
  override = fn;
}
export const providerFetch: FetchLike = (url, init) => (override ?? fetch)(url, init);

export const TIMEOUT_MS = 10_000;

/** A request that cannot hang the outbox: it is aborted after TIMEOUT_MS. Network errors become a `retry` result. */
export async function call(
  url: string,
  init: RequestInit,
  fetchFn: FetchLike = providerFetch,
): Promise<{ status: number; body: unknown } | { network: string }> {
  try {
    const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    return { network: name === "TimeoutError" || name === "AbortError" ? "timed out" : "network error" };
  }
}

/** Keeps a provider's own words short and single-line; nothing else is stored. */
export const clip = (value: unknown, max = 160) =>
  String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);

/** Defence in depth: if a provider ever echoes the credential in an error message, it is not stored. */
export const redact = (text: string, secret: string) => (secret ? text.split(secret).join("[redacted]") : text);
