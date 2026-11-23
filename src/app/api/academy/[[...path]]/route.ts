import { privateMediaResponse } from "@/modules/media/application/http";
import { resolveActor, type Actor } from "@/modules/identity/access";
import { listSecurityEvents } from "@/modules/identity/security-event-log";
import { listAccessEvents } from "@/modules/audit/application/access-log";
import {
  cancelErasure,
  erasureDetail,
  placeLegalHold,
  privacyOverview,
  refreshErasurePreview,
  releaseLegalHold,
  requestErasure,
  reviewErasure,
  setRetentionPolicy,
} from "@/modules/privacy/application/service";
import { processDueErasures } from "@/modules/privacy/application/process";
import { requireCapability } from "@/modules/identity/authority";
import { accessScope } from "@/modules/audit/application/record";
import {
  consentForPlayer,
  consentPolicies,
  consentReport,
  decideConsent,
  publishConsentVersion,
  saveConsentVersion,
} from "@/modules/consent/application/service";
import {
  guardianAccessView,
  saveGuardianAccess,
} from "@/modules/academy/application/guardian-access";
import { myPhone, savePhone } from "@/modules/communications/application/phone";
import { reviewAge } from "@/modules/players/application/age-review";
import {
  createInvitation,
  createPlayerLink,
  listInvitations,
  revokeInvitation,
} from "@/modules/invitations/application/service";
import { DomainError } from "@/modules/training/domain/rules";
import { ZodError } from "zod";
import { config } from "@/shared/config";
import { bootstrapAcademy } from "@/modules/academy/application/bootstrap";
import {
  saveEnquiry,
  scheduleTrial,
  convertEnquiry,
} from "@/modules/admissions/application/service";
import {
  savePlayer,
  linkGuardian,
  saveConsent,
} from "@/modules/players/application/service";
import {
  saveCalendarEvent,
  previewCalendarCancellation,
  scheduleSession,
} from "@/modules/calendar/application/service";
import {
  academyLogo,
  identityView,
  saveSettings,
  saveBranch,
  saveBatch,
  saveMember,
} from "@/modules/settings/application/service";
import {
  saveFeePlan,
  issueInvoice,
  submitPayment,
  verifyPayment,
  recordRefund,
  adjustCredits,
  voidInvoice,
} from "@/modules/fees/application/service";
import {
  createReport,
  reviewObservation,
  updateReport,
  withdrawReport,
} from "@/modules/reports/application/service";
import { reportPdf, receiptPdf } from "@/modules/reports/application/pdf";
import {
  saveNutrition,
  saveRestrictions,
  nutritionQuestion,
  assignNutrition,
  withdrawNutritionPlan,
} from "@/modules/nutrition/application/service";
import {
  saveMessage,
  previewMessage,
  processOutbox,
  saveTemplate,
  saveConversation,
  shareList,
  markShared,
} from "@/modules/communications/application/service";
import { issueFeedToken } from "@/modules/calendar/application/feed";
import { sessionShare, reportShare, reportBatchShare } from "@/modules/communications/application/share-targets";
import { batchReportView, batchCreateDrafts, batchApprove } from "@/modules/reports/application/batch";
import { getReportPolicy, saveReportPolicy, reportsDue, createDueDrafts } from "@/modules/reports/application/policy";
import { resendInvitation, bulkInviteGuardians } from "@/modules/invitations/application/lifecycle";
import { ownPlayerDetails, selfRegisterPlayer } from "@/modules/players/application/self-register";
import {
  previewDispatch,
  queueDispatch,
  listDispatchBatches,
  dispatchBatchStatus,
  retryFailedItems,
  cancelDispatchBatch,
} from "@/modules/dispatch/application/service";
import { runQueueNowForTest } from "@/modules/dispatch/application/dev";
import {
  contactsOverview,
  saveContact,
  recordWhatsAppOptIn,
  revokeWhatsAppOptIn,
  saveMyWhatsAppOptIn,
  myWhatsAppOptIn,
  clearSuppression,
} from "@/modules/contacts/application/service";
import {
  uploadMedia,
  reviewMedia,
  mediaLink,
  readMedia,
  saveTimestampNote,
} from "@/modules/media/application/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const actions = {
  "admissions/save": saveEnquiry,
  "admissions/trial": scheduleTrial,
  "admissions/convert": convertEnquiry,
  "players/save": savePlayer,
  "players/guardian": linkGuardian,
  "players/consent": saveConsent,
  "consent/decide": decideConsent,
  "consent/version": saveConsentVersion,
  "consent/publish": publishConsentVersion,
  // RC-4: only the adult player's own account passes (decided inside, from the session).
  "guardian-access/save": saveGuardianAccess,
  "calendar/event": saveCalendarEvent,
  "calendar/preview": previewCalendarCancellation,
  "calendar/session": scheduleSession,
  "settings/save": saveSettings,
  "settings/branch": saveBranch,
  "settings/batch": saveBatch,
  "settings/member": saveMember,
  // Invitations (0018): an owner invites people into THIS academy; accepting is done by the invitee at /api/auth/invitations.
  "invitations/create": createInvitation,
  "invitations/player-link": createPlayerLink,
  "players/self-details": ownPlayerDetails,
  "players/self-register": selfRegisterPlayer,
  "invitations/revoke": revokeInvitation,
  "invitations/resend": resendInvitation,
  "invitations/bulk": bulkInviteGuardians,
  "contacts/overview": contactsOverview,
  "contacts/save": saveContact,
  "contacts/opt-in": recordWhatsAppOptIn,
  "contacts/opt-out": revokeWhatsAppOptIn,
  "contacts/clear-suppression": clearSuppression,
  "contacts/my-opt-in": saveMyWhatsAppOptIn,
  "contacts/my-opt-in-state": myWhatsAppOptIn,
  "fees/plan": saveFeePlan,
  "fees/invoice": issueInvoice,
  "fees/payment": submitPayment,
  "fees/verify": verifyPayment,
  "fees/refund": recordRefund,
  "fees/credit": adjustCredits,
  "fees/void": voidInvoice,
  "reports/create": createReport,
  "reports/batch-view": batchReportView,
  "reports/batch-drafts": batchCreateDrafts,
  "reports/batch-approve": batchApprove,
  "dispatch/preview": previewDispatch,
  "dispatch/queue": queueDispatch,
  "dispatch/batches": listDispatchBatches,
  "dispatch/status": dispatchBatchStatus,
  "dispatch/retry": retryFailedItems,
  "dispatch/cancel": cancelDispatchBatch,
  "dispatch/run-test": runQueueNowForTest,
  "reports/policy": getReportPolicy,
  "reports/policy-save": saveReportPolicy,
  "reports/due": reportsDue,
  "reports/due-create": createDueDrafts,
  "reports/review": reviewObservation,
  "reports/update": updateReport,
  "privacy/policy": setRetentionPolicy,
  "privacy/request": requestErasure,
  "privacy/preview": refreshErasurePreview,
  "privacy/review": reviewErasure,
  "privacy/cancel": cancelErasure,
  "privacy/hold": placeLegalHold,
  "privacy/release": releaseLegalHold,
  "privacy/process": async (actor: Actor) => {
    // Runs this academy's due erasures now. The scheduled `npm run privacy:process` is the all-academy form; an
    // owner's request is scoped to the academy resolved from their own session and reports nothing about any other.
    requireCapability(actor, "privacy.manage");
    return { processed: await processDueErasures({ academyId: actor.academyId }) };
  },
  "reports/withdraw": withdrawReport,
  "nutrition/plan": saveNutrition,
  "nutrition/withdraw": withdrawNutritionPlan,
  "nutrition/restrictions": saveRestrictions,
  "nutrition/question": nutritionQuestion,
  "nutrition/assign": assignNutrition,
  "communications/save": saveMessage,
  "communications/preview": previewMessage,
  // Players are under 18: the owner decides about a player who has turned 18 (archive, or keep for now with a reason).
  "players/age-review": reviewAge,
  "communications/process": processOutbox,
  "calendar/link": issueFeedToken,
  "communications/session-share": sessionShare,
  "communications/report-share": reportShare,
  "communications/report-batch-share": reportBatchShare,
  // Free manual sending: what is waiting to be sent from the sender's own WhatsApp / mail app, and "I opened it".
  "communications/share-list": shareList,
  "communications/mark-shared": markShared,
  "communications/template": saveTemplate,
  "communications/conversation": saveConversation,
  // The caller's own WhatsApp number; an owner may set another member's (decided inside, from the session).
  "communications/phone": savePhone,
  "communications/my-phone": myPhone,
  "media/review": reviewMedia,
  "media/note": saveTimestampNote,
};
async function bodyBytes(request: Request, limit: number) {
  const reader = request.body?.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  if (!reader) return new Uint8Array();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new DomainError("Request too large.", 413);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}
async function handle(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  try {
    if (
      request.method !== "GET" &&
      request.headers.get("origin") !== new URL(config().BETTER_AUTH_URL).origin
    )
      throw new DomainError("Request origin is not allowed.", 403);
    const actor = await resolveActor(request.headers, "academy");
    const { path = [] } = await context.params;
    const route = path.join("/");
    let result: unknown;
    if (request.method === "GET") {
      if (!route) result = await bootstrapAcademy(actor);
      else if (route === "identity") result = await identityView(actor);
      else if (route === "logo") {
        // The academy's own logo for the signed-in member's academy. Revalidated every time (ETag per academy and version).
        const logo = await academyLogo(actor);
        if (!logo) throw new DomainError("This academy has no logo.", 404);
        const headers = {
          ETag: logo.etag,
          "Cache-Control": "private, no-cache",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
        };
        if (request.headers.get("if-none-match") === logo.etag) return new Response(null, { status: 304, headers });
        return new Response(Buffer.from(logo.bytes), { headers: { ...headers, "Content-Type": "image/png" } });
      }
      else if (route === "guardian-access") result = await guardianAccessView(actor);
      else if (route === "invitations") result = await listInvitations(actor);
      else if (route === "consent/policies") result = await consentPolicies(actor);
      else if (route === "consent/report") result = await consentReport(actor);
      else if (path[0] === "consent" && path.length === 2)
        // A player's consent state and history (role and player access are decided inside).
        result = await consentForPlayer(
          actor,
          path[1],
          Object.fromEntries(new URL(request.url).searchParams),
        );
      else if (route === "privacy/overview") result = await privacyOverview(actor);
      else if (path[0] === "privacy" && path[1] === "requests" && path.length === 3)
        result = await erasureDetail(actor, path[2]);
      else if (route === "access-events")
        // Sensitive-data access history for OWNER/ADMIN (role checked inside; academy taken from the actor).
        result = await listAccessEvents(
          actor,
          Object.fromEntries(new URL(request.url).searchParams),
        );
      else if (route === "security-events")
        // Account-security log for OWNER/ADMIN (role checked inside; academy taken from the actor).
        result = await listSecurityEvents(
          actor,
          Object.fromEntries(new URL(request.url).searchParams),
        );
      else if (
        (path[0] === "reports" && path[2] === "pdf" && path.length === 3) ||
        (path[0] === "fees" && path[2] === "receipt" && path.length === 3)
      ) {
        const file =
          path[0] === "reports"
            ? await reportPdf(actor, path[1])
            : await receiptPdf(actor, path[1]);
        return new Response(Buffer.from(file.bytes), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${file.name}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } else if (path[0] === "media" && path[2] === "link" && path.length === 3)
        result = await mediaLink(actor, path[1]);
      else if (path[0] === "media" && path[2] === "file" && path.length === 3) {
        const file = await readMedia(actor, path[1], new URL(request.url));
        return privateMediaResponse(file, request.headers.get("range"));
      } else throw new DomainError("Route not found.", 404);
    } else if (route === "media/upload") {
      const bytes = await bodyBytes(request, 26 * 1024 * 1024);
      const form = await new Response(bytes, {
        headers: { "Content-Type": request.headers.get("content-type") ?? "" },
      }).formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new DomainError("Choose a file.");
      result = await uploadMedia(
        actor,
        String(form.get("playerId") ?? ""),
        file,
        String(form.get("sessionId") ?? "") || null,
      );
    } else {
      const action = actions[route as keyof typeof actions];
      if (!action) throw new DomainError("Route not found.", 404);
      let body;
      try {
        body = JSON.parse(
          Buffer.from(await bodyBytes(request, 512_000)).toString(),
        );
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError("Request must contain valid JSON.", 400);
      }
      result =
        route === "communications/process"
          ? await processOutbox(actor)
          : await (
              action as (a: typeof actor, body: unknown) => Promise<unknown>
            )(actor, body);
    }
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof DomainError)
      return Response.json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status },
      );
    if (error instanceof ZodError)
      return Response.json(
        {
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        { status: 422 },
      );
    console.error(
      "Academy request failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      {
        error:
          "Unable to save or load this record. Your entered values are preserved. Please try again.",
      },
      { status: 500 },
    );
  }
}
/**
 * The operation name recorded with every sensitive-data access (Phase 7): the route with record ids
 * replaced, so the access history says "GET reports/:id/pdf" and never carries an id in the channel.
 */
function channelOf(method: string, path: string[]) {
  const [head, second, third] = path;
  const idFirst =
    (head === "consent" && path.length === 2 && !["policies", "report", "decide", "version", "publish"].includes(second ?? "")) ||
    (["reports", "fees", "media"].includes(head ?? "") && path.length === 3 && ["pdf", "receipt", "link", "file"].includes(third ?? ""));
  return `${method} ${path.map((s, i) => (idFirst && i === 1 ? ":id" : s)).join("/") || "/"}`.slice(0, 100);
}
async function scoped(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await context.params;
  return accessScope.run(
    { requestId: crypto.randomUUID(), channel: channelOf(request.method, path) },
    () => handle(request, context),
  );
}
export const GET = scoped;
export const POST = scoped;
