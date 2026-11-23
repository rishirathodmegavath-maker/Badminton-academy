import { join } from "node:path";
import { MetaWhatsAppProvider, metaConfig } from "./meta-whatsapp";
import { TestEmailProvider, TestWhatsAppProvider } from "./test-adapter";
import type { Providers } from "./types";

/**
 * Which providers exist, decided ONLY by environment variables, in the process that needs them (the worker sends; the web
 * app only reports what is configured). Nothing is switched on by default.
 *
 *   DISPATCH_EMAIL_PROVIDER      none (default) | test
 *   DISPATCH_WHATSAPP_PROVIDER   none (default) | test | meta
 *   DISPATCH_TEST_OUTBOX_FILE    where the test adapters append what would have been sent (default .data/dispatch-test-outbox.jsonl)
 *
 * No real e-mail provider exists in this build: Amazon SES and Postmark are being evaluated (see EMAIL_PROVIDER_EVALUATION.md)
 * and a choice has not been made, so naming one is reported as unavailable rather than guessed at.
 */
export type ChannelMode = "NONE" | "TEST" | "LIVE";
export type ChannelState = { mode: ChannelMode; provider: string; problems: string[] };
export type Env = Readonly<Record<string, string | undefined>>;

export function channelStates(env: Env = process.env): { EMAIL: ChannelState; WHATSAPP: ChannelState } {
  const production = env.NODE_ENV === "production";
  const email = (env.DISPATCH_EMAIL_PROVIDER ?? "none").trim().toLowerCase();
  const wa = (env.DISPATCH_WHATSAPP_PROVIDER ?? "none").trim().toLowerCase();
  const EMAIL: ChannelState =
    email === "none" || !email
      ? { mode: "NONE", provider: "none", problems: [] }
      : email === "test"
        ? production
          ? { mode: "NONE", provider: "test", problems: ["The test adapter is not available in production."] }
          : { mode: "TEST", provider: "test", problems: [] }
        : { mode: "NONE", provider: email, problems: [`E-mail provider "${email}" is not available in this build. Use none or test until a provider is chosen.`] };
  let WHATSAPP: ChannelState;
  if (wa === "none" || !wa) WHATSAPP = { mode: "NONE", provider: "none", problems: [] };
  else if (wa === "test")
    WHATSAPP = production
      ? { mode: "NONE", provider: "test", problems: ["The test adapter is not available in production."] }
      : { mode: "TEST", provider: "test", problems: [] };
  else if (wa === "meta") {
    const cfg = metaConfig(env);
    WHATSAPP = cfg.ok ? { mode: "LIVE", provider: "meta", problems: [] } : { mode: "NONE", provider: "meta", problems: cfg.problems };
  } else WHATSAPP = { mode: "NONE", provider: wa, problems: [`WhatsApp provider "${wa}" is not available. Use none, test or meta.`] };
  return { EMAIL, WHATSAPP };
}

/** The providers a worker may send through. A channel that is not configured has no provider, so its items simply wait. */
export function providersFromEnv(env: Env = process.env): Providers {
  const states = channelStates(env);
  const file = env.DISPATCH_TEST_OUTBOX_FILE || join(process.cwd(), ".data", "dispatch-test-outbox.jsonl");
  const providers: Providers = {};
  if (states.EMAIL.mode === "TEST") providers.EMAIL = new TestEmailProvider(file);
  if (states.WHATSAPP.mode === "TEST") providers.WHATSAPP = new TestWhatsAppProvider(file);
  if (states.WHATSAPP.mode === "LIVE") {
    const cfg = metaConfig(env);
    if (cfg.ok) providers.WHATSAPP = new MetaWhatsAppProvider(cfg.config);
  }
  return providers;
}
