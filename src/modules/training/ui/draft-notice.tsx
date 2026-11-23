"use client";
import type { DraftRecord, DraftVerdict } from "../domain/draft-recovery";

export type Recovery = {
  record: DraftRecord;
  verdict: Exclude<DraftVerdict, "identical">;
  title: string;
  /** Version the server holds now. */
  serverVersion: number;
};
export type OtherDraft = { sessionId: string; title: string; savedAt: string };

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Offered when unsaved edits for the open session were kept on this device. Plain notice, existing classes only.
 * Restoring puts the edits back in the editor; nothing is saved to the academy until the person saves.
 */
export function RecoveryNotice({
  recovery,
  onRestore,
  onDiscard,
}: {
  recovery: Recovery;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  const { record, verdict, title, serverVersion } = recovery;
  return (
    <div className="notice" role="alert" data-testid="draft-recovery">
      <p>
        <strong>Unsaved edits found.</strong> Your edits to “
        {title || "Untitled draft"}” from {when(record.savedAt)} were kept on
        this device.
      </p>
      {verdict === "current" && (
        <p>
          They are based on the latest saved version. Restore them to continue,
          or discard them.
        </p>
      )}
      {verdict === "stale" && (
        <p>
          This session was saved again after you made them (your edits started
          from saved version {record.baseVersion}; the latest is {serverVersion}
          ). Restoring puts your edits on top of the latest version, and saving
          would replace the newer saved changes.
        </p>
      )}
      {verdict === "obsolete" && (
        <p>
          This session can no longer be edited (it has been published or changed
          since), so these edits cannot be restored. Discard them when you are
          ready.
        </p>
      )}
      <div className="button-row">
        {verdict !== "obsolete" && (
          <button type="button" className="primary" onClick={onRestore}>
            {verdict === "stale"
              ? "Restore my edits anyway"
              : "Restore my edits"}
          </button>
        )}
        <button type="button" className="secondary" onClick={onDiscard}>
          {verdict === "stale"
            ? "Keep the saved version"
            : "Discard local copy"}
        </button>
      </div>
    </div>
  );
}

/** Other sessions of the same person with kept edits (found after navigating away or refreshing). */
export function OtherDrafts({
  items,
  onOpen,
}: {
  items: OtherDraft[];
  onOpen: (sessionId: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="notice" role="status" data-testid="other-drafts">
      <p>
        <strong>Edits kept on this device.</strong> Open a session to restore
        its unsaved edits.
      </p>
      <div className="button-row">
        {items.slice(0, 3).map((d) => (
          <button
            type="button"
            key={d.sessionId}
            className="secondary"
            onClick={() => onOpen(d.sessionId)}
          >
            {d.title || "Untitled draft"} · {when(d.savedAt)}
          </button>
        ))}
      </div>
    </div>
  );
}
