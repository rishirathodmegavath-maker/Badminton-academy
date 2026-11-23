"use client";
import { useCallback, useEffect, useState } from "react";
import { academyRequest, text, type DialogSpec } from "./shared";
import { formatDate } from "./labels";

type Own =
  | { registered: false }
  | { registered: true; version: number; name: string; birthDate: string; email: string; phone: string; preferences: string };

/**
 * A player who joined by invitation link fills in their own details here (instead of staff typing them), and can update their
 * contact details later. Everything is asked of the server for THIS signed-in account only; the screen never names a player id.
 */
export function OwnDetails({
  mutate,
  open,
  busy,
}: {
  mutate: (path: string, body: unknown) => Promise<boolean>;
  open: (spec: DialogSpec) => void;
  busy: boolean;
}) {
  const [own, setOwn] = useState<Own | null>(null);
  const [failed, setFailed] = useState("");
  const load = useCallback(async () => {
    try {
      setOwn(await academyRequest<Own>("/players/self-details", {}));
      setFailed("");
    } catch (e) {
      setFailed((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (failed)
    return (
      <section className="panel" aria-labelledby="own-title">
        <h3 id="own-title">Your details</h3>
        <p role="alert">{failed}</p>
        <button type="button" className="secondary" onClick={() => void load()}>
          Try again
        </button>
      </section>
    );
  if (!own) return null;

  function fill() {
    open({
      title: "Your details",
      initial: { name: "", birthDate: "", phone: "", email: "", preferences: "" },
      fields: [
        { name: "name", label: "Your full name", required: true },
        { name: "birthDate", label: "Date of birth", kind: "date", required: true },
        { name: "phone", label: "Mobile number" },
        { name: "email", label: "Email", kind: "email" },
        { name: "preferences", label: "Anything your coach should know", kind: "textarea", max: 2000 },
      ],
      notice: "Your academy sees these details. Your name and date of birth cannot be changed here once saved; ask the academy if one is wrong.",
      button: "Save my details",
      submit: async (v) => {
        const ok = await mutate("/players/self-register", {
          name: text(v, "name"),
          birthDate: text(v, "birthDate"),
          phone: text(v, "phone"),
          email: text(v, "email"),
          preferences: text(v, "preferences"),
        });
        if (ok) await load();
        return ok;
      },
    });
  }
  function update(current: Extract<Own, { registered: true }>) {
    open({
      title: "Update your contact details",
      initial: { phone: current.phone, email: current.email, preferences: current.preferences },
      fields: [
        { name: "phone", label: "Mobile number" },
        { name: "email", label: "Email", kind: "email" },
        { name: "preferences", label: "Anything your coach should know", kind: "textarea", max: 2000 },
      ],
      button: "Save",
      submit: async (v) => {
        const ok = await mutate("/players/self-register", {
          version: current.version,
          phone: text(v, "phone"),
          email: text(v, "email"),
          preferences: text(v, "preferences"),
        });
        if (ok) await load();
        return ok;
      },
    });
  }

  if (!own.registered)
    return (
      <section className="panel own-details" aria-labelledby="own-title">
        <h2 id="own-title">Welcome. Tell your academy about yourself.</h2>
        <p>Fill in your details once, and your coaches will have everything they need. It takes about a minute.</p>
        <button type="button" className="primary" disabled={busy} onClick={fill}>
          Fill in my details
        </button>
      </section>
    );
  return (
    <section className="panel own-details" aria-labelledby="own-title">
      <h3 id="own-title">Your details</h3>
      <dl className="own-details-list">
        <div>
          <dt>Name</dt>
          <dd>{own.name}</dd>
        </div>
        <div>
          <dt>Date of birth</dt>
          <dd>{formatDate(own.birthDate)}</dd>
        </div>
        <div>
          <dt>Mobile number</dt>
          <dd>{own.phone || "Not given"}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{own.email || "Not given"}</dd>
        </div>
      </dl>
      <button type="button" className="secondary" disabled={busy} onClick={() => update(own)}>
        Update contact details
      </button>
    </section>
  );
}
