import { z } from "zod";
import { emailProviderConfig } from "../infrastructure/email/provider";

export function config() {
  const env = z
    .object({
      BETTER_AUTH_SECRET: z.string().min(32),
      BETTER_AUTH_URL: z.url(),
      DATABASE_URL: z.string().optional(),
      LOCAL_DATABASE_PATH: z.string().optional(),
      EMAIL_PROVIDER: z.string().optional(),
      RESEND_API_KEY: z.string().optional(),
      ZEPTOMAIL_TOKEN: z.string().optional(),
      ZEPTOMAIL_API_URL: z.string().optional(),
      EMAIL_FROM: z.string().optional(),
    })
    .parse(process.env);
  if (
    !env.DATABASE_URL &&
    (!env.LOCAL_DATABASE_PATH || process.env.NODE_ENV === "production")
  ) {
    throw new Error(
      "Configure DATABASE_URL. Embedded PostgreSQL requires an explicit LOCAL_DATABASE_PATH and development mode.",
    );
  }
  const email = emailProviderConfig(process.env);
  if (email.provider === "invalid") {
    throw new Error(`${email.variable}: ${email.problem}`);
  }
  return env;
}
