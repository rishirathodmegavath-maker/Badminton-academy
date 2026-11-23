"use client";
import { useEffect, useState } from "react";
import type { AcademyPayload } from "../application/bootstrap";
import { Editor, Details, academyRequest, type DialogSpec } from "./shared";
import { ErrorContext } from "../../training/ui/common";
import { Overview, Admissions, Players, Calendar } from "./operations";
import { Fees, Reports, Nutrition, Media } from "./reviews-finance";
import { Communications, Settings } from "./settings-communications";
import { TemporaryPasswordCard } from "../../identity/ui/temporary-password";
import { ShellSkeleton } from "../../../shell/states";
import { Toast } from "../../../shell/toast";
export default function AcademyWorkspace({
  module,
  nav,
  onSession,
  onChange,
  focusId,
}: {
  module: string;
  nav: (name: string, id?: string) => void;
  onSession: (id: string) => void;
  onChange: () => void;
  focusId?: string;
}) {
  const [data, setData] = useState<AcademyPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<DialogSpec | null>(null);
  const [detail, setDetail] = useState<{
    title: string;
    content: React.ReactNode;
  } | null>(null);
  async function load() {
    try {
      setData(await academyRequest<AcademyPayload>());
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function mutate(path: string, body: unknown) {
    if (busy) return false;
    setError("");
    setBusy(true);
    try {
      const saved = await academyRequest<{
        id?: string;
        temporaryPassword?: string;
        temporaryPasswordExpiresAt?: string;
      }>(path, body);
      await load();
      if (saved?.temporaryPassword && saved.temporaryPasswordExpiresAt)
        setDetail({
          title: "Temporary password",
          content: (
            <TemporaryPasswordCard
              password={saved.temporaryPassword}
              expiresAt={saved.temporaryPasswordExpiresAt}
            />
          ),
        });
      onChange();
      setNotice("Changes saved.");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (!data && !error) return <ShellSkeleton label="Loading academy records" />;
  if (!data)
    return (
      <section className="panel">
        <p role="alert">{error}</p>
        <button className="secondary" onClick={load}>
          Try again
        </button>
      </section>
    );
  const props = {
    data,
    mutate,
    open: (s: DialogSpec) => {
      setError("");
      setEditor(s);
    },
    detail: (title: string, content: React.ReactNode) =>
      setDetail({ title, content }),
    nav,
    onSession,
    focusId,
    busy,
    error: setError,
    reload: load,
  };
  return (
    <ErrorContext.Provider value={error}>
      <section className="academy-module">
        {error && (
          <div className="error" role="alert">
            {error}
            <button className="text-button" onClick={load}>
              Reload saved records
            </button>
          </div>
        )}
        <Toast message={notice} dismissLabel="Dismiss saved message" onDismiss={() => setNotice("")} />
        {module === "Overview" ? (
          <Overview {...props} />
        ) : module === "Admissions" ? (
          <Admissions {...props} />
        ) : module === "Players" ? (
          <Players {...props} />
        ) : module === "Calendar" ? (
          <Calendar {...props} />
        ) : module === "Fees" ? (
          <Fees {...props} />
        ) : module === "Reports" ? (
          <Reports {...props} />
        ) : module === "Nutrition" ? (
          <Nutrition {...props} />
        ) : module === "Video & AI Analysis" ? (
          <Media {...props} />
        ) : module === "Communications" ? (
          <Communications {...props} />
        ) : module === "Settings" ? (
          <Settings {...props} />
        ) : null}
        {editor && (
          <Editor
            key={editor.title}
            spec={editor}
            close={() => setEditor(null)}
            busy={busy}
          />
        )}
        {detail && (
          <Details title={detail.title} close={() => setDetail(null)}>
            {detail.content}
          </Details>
        )}
      </section>
    </ErrorContext.Provider>
  );
}
