import { betterAuth } from "better-auth/minimal";
import { APIError, getOAuthState } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
import { eq } from "drizzle-orm";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { database } from "../../infrastructure/database/client";
import * as schema from "../../infrastructure/database/schema";
import { config } from "../../shared/config";
import { clientIpConfig, clientIpTrusted } from "./client-ip";
import { accountSecurity } from "./account-security";
import { GATE_MESSAGES } from "./account-gate";
import {
  GOOGLE_REFUSAL_MESSAGES,
  googleConfig,
  hasAuthenticator,
  isSocialSessionPath,
  mayHoldGoogle,
} from "./google";
import { onboarding } from "./onboarding";
import { invitations } from "./invitation-endpoints";
import { reportLinks } from "./report-link-endpoints";
import { ONBOARDING_MESSAGES, TERMS_VERSION } from "./onboarding-policy";
import { recordSecurityEvent } from "./security-events";

/** Optional per-server cookie name (see the note at `advanced` below). Fails loudly on a bad value. */
function cookiePrefix(): string | undefined {
  const value = process.env.SPORTOZEN_COOKIE_PREFIX?.trim() || undefined;
  if (value && !/^[A-Za-z0-9-]{1,32}$/.test(value))
    throw new Error("SPORTOZEN_COOKIE_PREFIX must be 1 to 32 letters, digits or hyphens.");
  return value;
}
let instance: ReturnType<typeof createAuth> | undefined;
export function auth() {
  if (instance) return instance;
  instance = createAuth();
  return instance;
}
function createAuth() {
  const env = config();
  if (process.env.NODE_ENV === "production" && !clientIpTrusted(process.env))
    console.warn(
      "[security] TRUSTED_PROXIES is not set: client addresses cannot be verified, so all clients share one sign-in rate-limit bucket per endpoint. Set TRUSTED_PROXIES to the proxy addresses in front of this app.",
    );
  const google = googleConfig(process.env);
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(database(), { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
    },
    // "Continue with Google" exists only when both credentials are configured. It creates an UNASSIGNED account
    // (no academy membership) only when the sign-up screen asks for it (requestSignUp) with the terms accepted,
    // and is never linked from an email address; see GOOGLE_SIGN_IN.md for the full policy.
    ...(google.enabled
      ? {
          socialProviders: {
            google: {
              clientId: google.clientId,
              clientSecret: google.clientSecret,
              disableImplicitSignUp: true,
              prompt: "select_account" as const,
            },
          },
        }
      : {}),
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
      },
      encryptOAuthTokens: true,
    },
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 30 },
    plugins: [
      // Better Auth's own two-factor plugin: TOTP only (no SMS, no email OTP, so no provider is
      // needed). Secrets and recovery codes are stored encrypted by the plugin, a challenge allows
      // five guesses, and ten consecutive failures lock the factor for 15 minutes.
      twoFactor({
        issuer: "Sportozen",
        twoFactorCookieMaxAge: 300,
        totpOptions: { digits: 6, period: 30 },
        backupCodeOptions: {
          amount: 10,
          length: 10,
          storeBackupCodes: "encrypted",
        },
        accountLockout: {
          enabled: true,
          maxFailedAttempts: 10,
          durationSeconds: 900,
        },
      }),
      accountSecurity(),
      onboarding(),
      invitations(),
      reportLinks(),
    ],
    databaseHooks: {
      user: {
        create: {
          // The only way a user row is created through Better Auth is "Continue with Google" from the sign-up
          // screen (password signup and owner provisioning write the row themselves). The new account is
          // unassigned: it has no academy membership and gains none here.
          before: async (created, context) => {
            if (!isSocialSessionPath(context?.path)) return;
            if (!created.emailVerified)
              throw new APIError("FORBIDDEN", {
                message: GOOGLE_REFUSAL_MESSAGES.email_not_verified,
                code: "GOOGLE_EMAIL_NOT_VERIFIED",
              });
            const state = await getOAuthState();
            if (
              state?.termsAccepted !== true ||
              state?.termsVersion !== TERMS_VERSION
            )
              throw new APIError("FORBIDDEN", {
                message: ONBOARDING_MESSAGES.TERMS_REQUIRED,
                code: "TERMS_REQUIRED",
              });
          },
          after: async (created, context) => {
            if (!isSocialSessionPath(context?.path)) return;
            const now = new Date();
            await database()
              .update(schema.user)
              .set({
                termsAcceptedAt: now,
                termsVersion: TERMS_VERSION,
                updatedAt: now,
              })
              .where(eq(schema.user.id, created.id));
            await recordSecurityEvent(database(), {
              event: "ACCOUNT_SIGNED_UP",
              actorId: created.id,
              targetUserId: created.id,
              detail: { method: "google", termsVersion: TERMS_VERSION },
            });
          },
        },
      },
      // Provider tokens are never needed (no Google API is called after sign-in), so none are kept.
      account: {
        create: {
          before: async (created) => {
            if (created.providerId === "credential") return;
            if (!(await mayHoldGoogle(created.userId)))
              throw new APIError("FORBIDDEN", {
                message: GOOGLE_REFUSAL_MESSAGES.not_provisioned,
                code: "GOOGLE_ACCOUNT_NOT_PROVISIONED",
              });
            return {
              data: {
                ...created,
                accessToken: null,
                refreshToken: null,
                idToken: null,
                accessTokenExpiresAt: null,
                refreshTokenExpiresAt: null,
              },
            };
          },
          after: async (created) => {
            if (created.providerId === "google")
              await recordSecurityEvent(database(), {
                event: "GOOGLE_LINKED",
                actorId: created.userId,
                targetUserId: created.userId,
              });
          },
        },
        update: {
          before: async (updated) => {
            // Only writes that carry provider tokens are touched (a password-only update is left alone).
            const carriesTokens = [
              "accessToken",
              "refreshToken",
              "idToken",
              "accessTokenExpiresAt",
              "refreshTokenExpiresAt",
            ].some((key) => key in updated);
            if (!carriesTokens) return;
            return {
              data: {
                ...updated,
                accessToken: null,
                refreshToken: null,
                idToken: null,
                accessTokenExpiresAt: null,
                refreshTokenExpiresAt: null,
              },
            };
          },
        },
      },
      session: {
        create: {
          // Every way of obtaining a session (password, second factor, password change) passes
          // here, so an expired temporary password can never become a session.
          before: async (created, context) => {
            // A self-registered address must be verified before it can hold a session (password or Google).
            const [holder] = await database()
              .select({
                required: schema.user.emailVerificationRequired,
                verified: schema.user.emailVerified,
              })
              .from(schema.user)
              .where(eq(schema.user.id, created.userId));
            if (holder?.required && !holder.verified)
              throw new APIError("FORBIDDEN", {
                message: ONBOARDING_MESSAGES.EMAIL_NOT_VERIFIED,
                code: "EMAIL_NOT_VERIFIED",
              });
            // Better Auth's two-factor step runs for password sign-in only. A session started from
            // Google would skip it, so an account with an authenticator cannot start one that way.
            if (
              isSocialSessionPath(context?.path) &&
              (await hasAuthenticator(created.userId))
            ) {
              await recordSecurityEvent(database(), {
                event: "GOOGLE_SIGN_IN_REFUSED",
                targetUserId: created.userId,
                detail: { reason: "mfa_enrolled" },
              });
              throw new APIError("FORBIDDEN", {
                message: GOOGLE_REFUSAL_MESSAGES.mfa_enrolled,
                code: "GOOGLE_SIGN_IN_NOT_AVAILABLE_WITH_MFA",
              });
            }
            const [temporary] = await database()
              .select()
              .from(schema.temporaryCredential)
              .where(eq(schema.temporaryCredential.userId, created.userId));
            if (temporary && temporary.expiresAt.getTime() <= Date.now()) {
              // The password path records this after the attempt; a Google session is refused here.
              if (isSocialSessionPath(context?.path))
                await recordSecurityEvent(database(), {
                  event: "TEMPORARY_PASSWORD_EXPIRED_SIGNIN",
                  targetUserId: created.userId,
                  detail: { reason: "google" },
                });
              throw new APIError("FORBIDDEN", {
                message: GATE_MESSAGES.TEMPORARY_PASSWORD_EXPIRED,
                code: "TEMPORARY_PASSWORD_EXPIRED",
              });
            }
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      // Per client address (see client-ip.ts). Per-account protection is layered on top by
      // account-security.ts (sign-in throttle) and the two-factor plugin (challenge and account lockout).
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/account/change-password": { window: 60, max: 5 },
        "/account/admin/reset-password": { window: 60, max: 10 },
        "/account/mfa-policy": { window: 60, max: 10 },
        "/two-factor/verify-totp": { window: 60, max: 10 },
        "/two-factor/verify-backup-code": { window: 60, max: 10 },
        "/two-factor/enable": { window: 60, max: 5 },
        "/two-factor/disable": { window: 60, max: 5 },
        "/two-factor/generate-backup-codes": { window: 60, max: 5 },
        "/sign-in/social": { window: 60, max: 10 },
        "/callback/*": { window: 60, max: 10 },
        "/link-social": { window: 60, max: 5 },
        "/account/unlink-google": { window: 60, max: 5 },
        "/account/select-academy": { window: 60, max: 30 },
        "/account/create-academy": { window: 60, max: 5 },
        // Invitations (0018): tokens are 256-bit secrets, so guessing is hopeless; these keep probing and abuse cheap to refuse.
        "/invitations/preview": { window: 60, max: 20 },
        "/invitations/accept": { window: 60, max: 10 },
        "/report-links/open": { window: 60, max: 20 },
        // Public onboarding (per client address; per-email limits live in onboarding.ts).
        "/onboarding/signup": { window: 60, max: 5 },
        "/onboarding/verify-email": { window: 60, max: 10 },
        "/onboarding/resend-verification": { window: 60, max: 5 },
        "/onboarding/forgot-password": { window: 60, max: 5 },
        "/onboarding/reset-password": { window: 60, max: 10 },
      },
    },
    advanced: {
      useSecureCookies: process.env.NODE_ENV === "production",
      // Browsers share cookies between ports of one host: two servers on 127.0.0.1 read and overwrite the same
      // "better-auth.session_token", each rejects the other's session, and the person is signed out whenever they switch.
      // SPORTOZEN_COOKIE_PREFIX gives a server its own cookie name. Unset keeps the default name (nothing changes).
      ...(cookiePrefix() ? { cookiePrefix: cookiePrefix() } : {}),
      // Never trust a client-supplied forwarding header unless TRUSTED_PROXIES declares the
      // proxy chain in front of this app (see client-ip.ts). Misconfiguration fails loudly.
      ipAddress: clientIpConfig(process.env),
    },
  });
}
