import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import * as z from "zod";
import { selectAcademy } from "./active-academy";
import { openReportLink } from "../dispatch/application/report-links";
import { DomainError } from "../training/domain/rules";

/**
 * The one endpoint behind a report link sent to a parent: /report-links/open. The caller is the signed-in person (from the
 * SESSION); the body carries only the token, which is read from the URL fragment by the page and never sent in a URL. Every
 * refusal is the same 404 with the same words (see dispatch/application/report-links.ts). On success the session is pointed at
 * the academy the report belongs to, so the report opens in the right place when the parent belongs to more than one.
 * Rate limited in auth.ts.
 */
export function reportLinks(): BetterAuthPlugin {
  return {
    id: "report-links",
    endpoints: {
      openReportLink: createAuthEndpoint(
        "/report-links/open",
        { method: "POST", body: z.object({ token: z.string().max(200) }), use: [sessionMiddleware] },
        async (ctx) => {
          ctx.setHeader?.("Cache-Control", "no-store");
          const { user, session } = ctx.context.session;
          try {
            const opened = await openReportLink({ id: user.id }, ctx.body.token);
            await selectAcademy(user.id, session.id, opened.academyId).catch(() => null);
            return ctx.json(opened);
          } catch (error) {
            if (error instanceof DomainError) throw new APIError("NOT_FOUND", { message: error.message, code: error.code ?? "REPORT_LINK_UNAVAILABLE" });
            throw error;
          }
        },
      ),
    },
  };
}
