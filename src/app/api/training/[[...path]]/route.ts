import { resolveActor } from "@/modules/identity/access";
import { accessScope } from "@/modules/audit/application/record";
import {
  bootstrap,
  createSession,
  mutateSession,
  setFavourite,
  createDrill,
  saveGoal,
} from "@/modules/training/application/service";
import { DomainError } from "@/modules/training/domain/rules";
import { ZodError } from "zod";
import { config } from "@/shared/config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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
    const actor = await resolveActor(request.headers);
    const { path = [] } = await context.params;
    let result;
    if (request.method === "GET" && !path.length)
      result = await bootstrap(actor);
    else if (request.method === "POST") {
      if (Number(request.headers.get("content-length") || 0) > 256_000)
        throw new DomainError("Request is too large.", 413);
      const raw = await request.text();
      if (raw.length > 256_000)
        throw new DomainError("Request is too large.", 413);
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        throw new DomainError("Request must contain valid JSON.", 400);
      }
      if (path[0] === "sessions" && path.length === 1)
        result = await createSession(actor);
      else if (path[0] === "sessions" && path.length === 2)
        result = await mutateSession(actor, path[1], body);
      else if (path[0] === "favourites" && path.length === 1)
        result = await setFavourite(actor, body);
      else if (path[0] === "drills" && path.length === 1)
        result = await createDrill(actor, body);
      else if (path[0] === "goals" && path.length === 1)
        result = await saveGoal(actor, body);
      else throw new DomainError("Route not found.", 404);
    } else throw new DomainError("Route not found.", 404);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
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
    // ORM error messages can include parameters containing private observations.
    console.error(
      "Training request failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      {
        error:
          "Unable to save or load training data. Your entered values have been preserved. Please try again.",
      },
      { status: 500 },
    );
  }
}
// Phase 7: each request carries an id and an operation name for the sensitive-data access history.
function scoped(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  return accessScope.run(
    { requestId: crypto.randomUUID(), channel: `${request.method} training` },
    () => handle(request, context),
  );
}
export const GET = scoped;
export const POST = scoped;
