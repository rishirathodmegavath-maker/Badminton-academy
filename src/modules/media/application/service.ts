import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import { denialAudited, recordAccess } from "../../audit/application/record";
import {
  unit,
  requirePlayer,
  requireFeature,
  history,
  expectVersion,
  family,
  type Tx,
} from "../../academy/application/access";
import { privateFiles } from "../../../infrastructure/storage/private-files";
import { config } from "../../../shared/config";
import { defaultSettings } from "../../academy/domain/types";
export function validMedia(bytes: Uint8Array, mime: string) {
  const b = Buffer.from(bytes);
  return mime === "image/png"
    ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === "image/jpeg"
      ? b[0] === 255 && b[1] === 216 && b[2] === 255
      : mime === "video/mp4"
        ? b.subarray(4, 8).toString() === "ftyp"
        : mime === "video/webm"
          ? b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
          : false;
}
export async function uploadMedia(
  a: Actor,
  playerId: string,
  file: File,
  sessionId: string | null = null,
) {
  requireCapability(a, "media.manage");
  if (!file.size || file.size > 25 * 1024 * 1024)
    throw new DomainError("Choose an image or video no larger than 25 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!validMedia(bytes, file.type))
    throw new DomainError(
      "The file type or signature is unsupported. Use PNG, JPEG, MP4 or WebM.",
    );
  return unit(a, async (tx) => {
    await requireFeature(a, "manualVideo", tx);
    const player = await requirePlayer(a, playerId, tx);
    if (sessionId) {
      const [session] = await tx
        .select()
        .from(t.trainingSessions)
        .where(
          and(
            eq(t.trainingSessions.academyId, a.academyId),
            eq(t.trainingSessions.id, sessionId),
          ),
        );
      if (
        !session ||
        (a.role === "COACH" && session.coachId !== a.id) ||
        (!session.data.roster.some((p) => p.id === playerId) &&
          session.batchId !== player.batchId)
      )
        throw new DomainError(
          "Session is outside this player’s authorised training context.",
          404,
        );
    }
    const id = crypto.randomUUID();
    const key = `${createHash("sha256").update(a.academyId).digest("hex").slice(0, 16)}/${id}`;
    const [settings] = await tx
      .select()
      .from(t.academySettings)
      .where(eq(t.academySettings.academyId, a.academyId));
    const expiresAt = new Date(
      Date.now() +
        (settings?.data ?? defaultSettings).retentionDays * 86400_000,
    );
    await privateFiles.put(key, bytes);
    try {
      const [saved] = await tx
        .insert(t.mediaAssets)
        .values({
          id,
          academyId: a.academyId,
          playerId,
          ownerId: a.id,
          name:
            file.name.replace(/[^a-zA-Z0-9._ -]/g, "").slice(0, 120) ||
            "Training media",
          mime: file.type,
          size: file.size,
          storageKey: key,
          expiresAt,
          sessionId,
        })
        .returning();
      await history(tx, a, "media", id, 1, {
        playerId,
        name: saved.name,
        mime: file.type,
        status: "PRIVATE",
      });
      return { id };
    } catch (error) {
      await privateFiles.remove(key).catch(() => {});
      throw error;
    }
  });
}
export async function mediaAccess(a: Actor, id: string, tx: Tx) {
  await requireFeature(a, "manualVideo", tx);
  const [m] = await tx
    .select()
    .from(t.mediaAssets)
    .where(
      and(eq(t.mediaAssets.academyId, a.academyId), eq(t.mediaAssets.id, id)),
    );
  if (!m || m.expiresAt.getTime() <= Date.now())
    throw new DomainError("Media not found or retention period expired.", 404);
  // RC-4: a guardian of an adult player needs the MEDIA section (link and file download call this).
  await requirePlayer(a, m.playerId, tx, "MEDIA");
  if (family(a) && m.status !== "SHARED")
    throw new DomainError("Media not found.", 404);
  if (!family(a)) requireCapability(a, "media.view");
  return m;
}
export async function reviewMedia(a: Actor, input: unknown) {
  requireCapability(a, "media.manage");
  const v = z
    .object({
      id: z.string(),
      version: z.number().int(),
      feedback: z.string().trim().min(3).max(3000),
      share: z.boolean(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    const m = await mediaAccess(a, v.id, tx);
    expectVersion(m.version, v.version);
    const status = v.share ? "SHARED" : "REVIEWED";
    await tx
      .update(t.mediaAssets)
      .set({
        feedback: v.feedback,
        status,
        version: m.version + 1,
        reviewerId: a.id,
      })
      .where(
        and(
          eq(t.mediaAssets.academyId, a.academyId),
          eq(t.mediaAssets.id, m.id),
        ),
      );
    await history(tx, a, "media", m.id, m.version + 1, {
      playerId: m.playerId,
      feedback: v.feedback,
      status,
    });
    return { ok: true };
  });
}
export async function saveTimestampNote(a: Actor, input: unknown) {
  requireCapability(a, "media.manage");
  const v = z
    .object({
      id: z.string(),
      version: z.number().int(),
      noteId: z.uuid(),
      seconds: z.number().min(0).max(86400),
      text: z.string().trim().min(1).max(1000),
    })
    .parse(input);
  return unit(a, async (tx) => {
    const media = await mediaAccess(a, v.id, tx);
    if (!media.mime.startsWith("video/"))
      throw new DomainError("Timestamp notes require a video.");
    const existing = media.timestampNotes.find((n) => n.id === v.noteId);
    if (existing) {
      if (
        existing.seconds !== v.seconds ||
        existing.text !== v.text ||
        existing.authorId !== a.id
      )
        throw new DomainError("Timestamp submission ID already used.", 409);
      return { ok: true };
    }
    expectVersion(media.version, v.version);
    const notes = [
      ...media.timestampNotes,
      {
        id: v.noteId,
        seconds: v.seconds,
        text: v.text,
        authorId: a.id,
        authorName: a.name,
        at: new Date().toISOString(),
      },
    ].sort((a, b) => a.seconds - b.seconds);
    await tx
      .update(t.mediaAssets)
      .set({
        timestampNotes: notes,
        status: "PRIVATE",
        version: media.version + 1,
      })
      .where(
        and(
          eq(t.mediaAssets.academyId, a.academyId),
          eq(t.mediaAssets.id, media.id),
        ),
      );
    await history(tx, a, "media", media.id, media.version + 1, {
      playerId: media.playerId,
      status: "PRIVATE",
      timestampNotes: notes,
    });
    return { ok: true };
  });
}
const signature = (a: Actor, id: string, expires: string) =>
  createHmac("sha256", config().BETTER_AUTH_SECRET)
    .update(`${a.academyId}:${a.id}:${id}:${expires}`)
    .digest("hex");
/**
 * Issuing a link is not itself an access to the bytes (that is recorded when they are read), so only a
 * refusal is recorded here. Phase 7.
 */
export async function mediaLink(a: Actor, id: string) {
  return denialAudited(
    a,
    { category: "MEDIA", operation: "DOWNLOAD", resourceId: id },
    () =>
      unit(a, async (tx) => {
        await mediaAccess(a, id, tx);
        const expires = String(Date.now() + 5 * 60_000);
        return {
          url: `/api/academy/media/${id}/file?expires=${expires}&signature=${signature(a, id, expires)}`,
        };
      }),
  );
}
export async function readMedia(a: Actor, id: string, url: URL) {
  return denialAudited(
    a,
    { category: "MEDIA", operation: "DOWNLOAD", resourceId: id },
    () => readMediaChecked(a, id, url),
  );
}
async function readMediaChecked(a: Actor, id: string, url: URL) {
  const expires = url.searchParams.get("expires") ?? "";
  const supplied = url.searchParams.get("signature") ?? "";
  const expected = signature(a, id, expires);
  if (
    !/^\d+$/.test(expires) ||
    Number(expires) < Date.now() ||
    Number(expires) > Date.now() + 5 * 60_000 ||
    !/^[a-f0-9]{64}$/.test(supplied) ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
  )
    throw new DomainError("Media link expired or invalid.", 403);
  return unit(a, async (tx) => {
    const m = await mediaAccess(a, id, tx);
    // Fail-closed, in the same transaction as the read: no event, no bytes.
    await recordAccess(tx, a, {
      category: "MEDIA",
      operation: "DOWNLOAD",
      resourceId: id,
      playerId: m.playerId,
    });
    return { metadata: m, bytes: await privateFiles.get(m.storageKey) };
  });
}
