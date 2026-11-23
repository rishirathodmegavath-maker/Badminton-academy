import { timingSafeEqual } from "node:crypto";
import { applyProviderEvent } from "@/modules/dispatch/application/events";
import { metaConfig, parseMetaWebhook, verifyMetaSignature } from "@/modules/dispatch/providers/meta-whatsapp";
import { channelStates } from "@/modules/dispatch/providers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The webhook the official WhatsApp Business Platform calls with delivery statuses and replies. It is INERT unless the
 * deployment configured the "meta" WhatsApp provider (otherwise it answers 404 and touches nothing).
 *
 *   GET   Meta's one-time verification handshake: answers the challenge only when the verify token matches.
 *   POST  A status or reply. The raw body's HMAC signature (X-Hub-Signature-256) is verified with the app secret BEFORE the
 *         body is parsed; anything unsigned or wrongly signed is refused 401 and changes nothing. Events are idempotent.
 *
 * It answers only with fixed words. It never echoes the request.
 */
const MAX_BODY = 1_000_000;
const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const config = () => (channelStates().WHATSAPP.provider === "meta" ? metaConfig() : null);

export async function GET(request: Request) {
  const cfg = config();
  if (!cfg?.ok) return new Response("Not found", { status: 404 });
  const q = new URL(request.url).searchParams;
  if (q.get("hub.mode") === "subscribe" && equal(q.get("hub.verify_token") ?? "", cfg.config.verifyToken))
    return new Response(q.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  return new Response("Forbidden", { status: 403 });
}

export async function POST(request: Request) {
  const cfg = config();
  if (!cfg?.ok) return new Response("Not found", { status: 404 });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) return new Response("Too large", { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return new Response("Too large", { status: 413 });
  if (!verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"), cfg.config.appSecret)) return new Response("Unauthorized", { status: 401 });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  for (const event of parseMetaWebhook(payload)) await applyProviderEvent(event);
  return new Response("ok", { status: 200, headers: { "Cache-Control": "no-store" } });
}
