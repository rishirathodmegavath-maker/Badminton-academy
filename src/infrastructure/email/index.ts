export * from "./provider";
export * from "./resend";
export * from "./zeptomail";
export * from "./seal";
export * from "./test-provider";
export * from "./outbox";

import { emailProviderConfig, type EmailProviderEnv, type TransactionalEmailProvider } from "./provider";
import { ResendEmailProvider } from "./resend";
import { ZeptoMailEmailProvider } from "./zeptomail";
import { TestAuthEmailProvider } from "./test-provider";

export function createConfiguredEmailProvider(
  env: EmailProviderEnv = process.env,
  fetchImpl?: typeof fetch,
): TransactionalEmailProvider | null {
  const cfg = emailProviderConfig(env);
  if (cfg.provider === "disabled") return null;
  if (cfg.provider === "invalid") {
    throw new Error(`${cfg.variable}: ${cfg.problem}`);
  }
  if (cfg.provider === "test") return new TestAuthEmailProvider({ captureFile: cfg.captureFile, env });
  if (cfg.provider === "zeptomail")
    return new ZeptoMailEmailProvider({
      token: cfg.token,
      from: cfg.from,
      apiUrl: cfg.apiUrl,
      fetchImpl,
    });
  return new ResendEmailProvider({
    apiKey: cfg.apiKey,
    from: cfg.from,
    fetchImpl,
  });
}
