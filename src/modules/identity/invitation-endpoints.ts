import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import * as z from "zod";
import { selectAcademy } from "./active-academy";
import { acceptInvitation, previewInvitation } from "../invitations/application/service";
import { DomainError } from "../training/domain/rules";

/**
 * The two invitation endpoints a person who is NOT yet a member of the academy can use (migration 0018):
 *
 *  - /invitations/preview  what the holder of a token is being offered (academy, role, masked address). No account
 *                          needed, because the person may not have one yet. An unknown token answers 404 and nothing else.
 *  - /invitations/accept   the signed-in person explicitly accepts. The person comes from the SESSION; the body carries
 *                          only the token. On success the session is pointed at the academy just joined, so the person
 *                          lands in it (no second sign-in), exactly as if they had chosen it in the academy chooser.
 *
 * POST with the token in the body, never in a URL: it reaches no access log and no Referer. Both are rate limited
 * (auth.ts). The rules of acceptance live in invitations/application/service.ts.
 */
const STATUS = { 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 410: "GONE", 422: "UNPROCESSABLE_ENTITY" } as const;
const asApiError = (error: unknown) => {
  if (error instanceof DomainError) {
    const status = STATUS[error.status as keyof typeof STATUS] ?? "BAD_REQUEST";
    return new APIError(status, { message: error.message, code: error.code ?? "INVITATION_ERROR" });
  }
  return error;
};
const noStore = (ctx: { setHeader?: (k: string, v: string) => void }) => ctx.setHeader?.("Cache-Control", "no-store");
const body = z.object({ token: z.string().max(200) });
const acceptBody = z.object({ token: z.string().max(200), phone: z.string().max(40).optional(), whatsappOptIn: z.boolean().optional() });

export function invitations(): BetterAuthPlugin {
  return {
    id: "invitations",
    endpoints: {
      previewInvitation: createAuthEndpoint("/invitations/preview", { method: "POST", body }, async (ctx) => {
        noStore(ctx);
        try {
          return ctx.json(await previewInvitation(ctx.body.token));
        } catch (error) {
          throw asApiError(error);
        }
      }),
      acceptInvitation: createAuthEndpoint(
        "/invitations/accept",
        { method: "POST", body: acceptBody, use: [sessionMiddleware] },
        async (ctx) => {
          noStore(ctx);
          const { user, session } = ctx.context.session;
          try {
            const accepted = await acceptInvitation({ id: user.id, email: user.email }, ctx.body.token, ctx.body.phone, ctx.body.whatsappOptIn);
            // Land in the academy just joined. A failure here changes nothing about the membership already created.
            await selectAcademy(user.id, session.id, accepted.academyId).catch(() => null);
            return ctx.json(accepted);
          } catch (error) {
            throw asApiError(error);
          }
        },
      ),
    },
  };
}
