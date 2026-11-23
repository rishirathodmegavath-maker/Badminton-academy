"use client";
import { useState } from "react";
import { academyRequest } from "./shared";
import { COUNTRY_CALLING_CODE, gmailLink, mailtoLink, normalizePhone, outlookLink, whatsappLink } from "../../communications/share-links";
import { sessionMessage, type MessageSession } from "../../calendar/session-message";

type Person = {
  userId: string;
  staff: boolean;
  name: string;
  email: string | null;
  phone: string | null;
  children: string[];
};

/**
 * One row per person with a WhatsApp and a mail button. The buttons open the sender's own app with the message ready;
 * nothing is sent from here and "Opened" only means a button was pressed. Every linked parent is listed; a missing WhatsApp
 * number can be added in the row.
 */
export function ShareList({
  people: initial,
  country,
  messageFor,
}: {
  people: Person[];
  country: string;
  messageFor: (p: Person) => { subject: string; text: string };
}) {
  const [people, setPeople] = useState(initial),
    [numbers, setNumbers] = useState<Record<string, string>>({}),
    [opened, setOpened] = useState<Set<string>>(new Set()),
    [error, setError] = useState(""),
    code = COUNTRY_CALLING_CODE[country] ?? null;
  async function save(userId: string) {
    setError("");
    try {
      await academyRequest("/communications/phone", { userId, phone: numbers[userId] ?? "" });
      const digits = normalizePhone(numbers[userId] ?? "", code);
      setPeople(people.map((p) => (p.userId === userId ? { ...p, phone: digits ? `+${digits}` : null } : p)));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const mark = (key: string) => setOpened(new Set(opened).add(key));
  return (
    <>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <ul className="ss-people">
        {people.map((p) => {
          const m = messageFor(p),
            typed = (numbers[p.userId] ?? "").trim(),
            bad = !!typed && !normalizePhone(typed, code);
          return (
            <li key={p.userId}>
              <div>
                <strong>{p.name}</strong>{" "}
                <small>{p.staff ? "Coach" : `Parent of ${p.children.join(", ")}`}</small>
              </div>
              {(
                <div className="button-row">
                  {p.phone ? (
                    <a
                      className="primary button-link"
                      target="_blank"
                      rel="noopener noreferrer"
                      href={whatsappLink(p.phone, m.text, code)}
                      onClick={() => mark(`w${p.userId}`)}
                    >
                      {opened.has(`w${p.userId}`) ? "Opened WhatsApp" : "WhatsApp"}
                    </a>
                  ) : (
                    <span className="button-row">
                      <input
                        type="tel"
                        aria-label={`WhatsApp number for ${p.name}`}
                        placeholder="+91 98765 43210"
                        value={numbers[p.userId] ?? ""}
                        onChange={(e) => setNumbers({ ...numbers, [p.userId]: e.target.value })}
                      />
                      <button type="button" className="secondary" disabled={bad || !typed} onClick={() => void save(p.userId)}>
                        Save number
                      </button>
                    </span>
                  )}
                  {p.email && (
                    <a
                      className="secondary button-link"
                      href={mailtoLink(p.email, m.subject, m.text)}
                      onClick={() => mark(`m${p.userId}`)}
                    >
                      {opened.has(`m${p.userId}`) ? "Opened mail app" : "Mail app"}
                    </a>
                  )}
                  {p.email && (
                    <>
                      <a
                        className="secondary button-link"
                        target="_blank"
                        rel="noopener noreferrer"
                        href={gmailLink(p.email, m.subject, m.text)}
                        onClick={() => mark(`m${p.userId}`)}
                      >
                        Gmail
                      </a>
                      <a
                        className="secondary button-link"
                        target="_blank"
                        rel="noopener noreferrer"
                        href={outlookLink(p.email, m.subject, m.text)}
                        onClick={() => mark(`m${p.userId}`)}
                      >
                        Outlook
                      </a>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <small>“Opened” means a button was pressed. The app cannot know whether the message was sent or read.</small>
    </>
  );
}

type SessionShareData = {
  academyName: string;
  country: string;
  session: MessageSession;
  people: Person[];
};

/** Tell the coach and the families about one session or event, free. */
export function SessionShare({ kind, id }: { kind: "SESSION" | "EVENT"; id: string }) {
  const [share, setShare] = useState<SessionShareData | null>(null),
    [note, setNote] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      setShare(await academyRequest<SessionShareData>("/communications/session-share", { kind, id }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ss-box">
      <strong>Tell the coach and families (free)</strong>
      {!share ? (
        <>
          <p>
            Lists the coach and the parents on this {kind === "SESSION" ? "session" : "event"}. Press WhatsApp or Mail for each person: your
            own app opens with the time, place and drills ready.
          </p>
          <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>
            Show who to tell
          </button>
          {error && <p role="alert">{error}</p>}
        </>
      ) : (
        <>
          <label>
            Add a note (optional)
            <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {share.people.length === 0 && <p className="muted">Nobody is linked to this yet.</p>}
          {share.people.length > 0 && (
            <ShareList
              people={share.people}
              country={share.country}
              messageFor={(p) => sessionMessage({ academyName: share.academyName, session: share.session, person: p, note })}
            />
          )}
        </>
      )}
    </div>
  );
}

type ReportShareData = {
  academyName: string;
  country: string;
  report: { id: string; title: string; childFirstName: string };
  people: Person[];
};

/**
 * Send a published report to a child's parents, free. "Share the PDF" hands the real file to WhatsApp or Mail through the
 * phone's share sheet; a computer cannot attach a file through a link, so the PDF is downloaded and attached by hand. The
 * message for each parent carries only a link to the private sign-in page, never the report's content.
 */
export function ReportShare({ id }: { id: string }) {
  const [share, setShare] = useState<ReportShareData | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      setShare(await academyRequest<ReportShareData>("/communications/report-share", { id }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sharePdf() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/academy/reports/${id}/pdf`, { cache: "no-store" });
      if (!response.ok) throw new Error("The PDF could not be prepared.");
      const blob = await response.blob(),
        file = new File([blob], "development-report.pdf", { type: "application/pdf" });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: "Development report" });
          setNotice("Share sheet opened.");
          return;
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          throw e;
        }
      }
      const url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = "development-report.pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setNotice(
        "This device cannot send a file straight to WhatsApp. The PDF was downloaded: press WhatsApp or Mail for a parent below and attach it there.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ss-box">
      <strong>Send to parents (free)</strong>
      {!share ? (
        <>
          <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>
            Send this report to parents
          </button>
          {error && <p role="alert">{error}</p>}
        </>
      ) : (
        <>
          <div className="button-row">
            <button type="button" className="secondary" disabled={busy} onClick={() => void sharePdf()}>
              {busy ? "Preparing PDF…" : "Share the PDF"}
            </button>
          </div>
          {notice && <p role="status">{notice}</p>}
          {error && <p role="alert">{error}</p>}
          {share.people.length === 0 && <p className="muted">No parent account is linked to this child yet.</p>}
          {share.people.length > 0 && (
            <ShareList
              people={share.people}
              country={share.country}
              messageFor={(p) => ({
                subject: `${share.report.childFirstName}'s development report`,
                text: [
                  `Hello ${p.name.trim().split(/\s+/)[0] || "there"},`,
                  "",
                  `${share.report.childFirstName}'s report "${share.report.title}" is ready.`,
                  `You can read it privately here after signing in: ${window.location.origin}`,
                  "",
                  `— ${share.academyName}`,
                ].join("\n"),
              })}
            />
          )}
        </>
      )}
    </div>
  );
}

/** A private calendar link for the signed-in person: add it once and every session follows by itself. */
export function CalendarLinkCard() {
  const [link, setLink] = useState<{ https: string; webcal: string } | null>(null),
    [copied, setCopied] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function make() {
    setBusy(true);
    setError("");
    try {
      const { token } = await academyRequest<{ token: string }>("/calendar/link", {});
      const { host, protocol } = window.location,
        path = `//${host}/api/calendar/${token}.ics`;
      setLink({ https: `${protocol}${path}`, webcal: `webcal:${path}` });
      setCopied(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="ss-box ss-calendar">
      <summary>My calendar link (free)</summary>
      <p>
        Add this link once to Google, Apple or Outlook calendar. New, changed and cancelled sessions then appear there by
        themselves, with the drills. Keep it private: anyone who has it can read your sessions. Making a new link stops the old
        one.
      </p>
      {!link ? (
        <button type="button" className="secondary" disabled={busy} onClick={() => void make()}>
          Make my calendar link
        </button>
      ) : (
        <>
          <input readOnly aria-label="Calendar link" value={link.https} />
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link.https);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <a className="secondary button-link" href={link.webcal}>
              Open in my calendar app
            </a>
            <a
              className="secondary button-link"
              target="_blank"
              rel="noopener noreferrer"
              href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(link.webcal)}`}
            >
              Add to Google Calendar
            </a>
          </div>
          <small>Google can only read the link once the app is on its public web address.</small>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}

type BatchShareData = {
  academyName: string;
  country: string;
  titles: string[];
  reportCount: number;
  notPublished: string[];
  people: Person[];
};

/**
 * Parent by parent: one row per parent covering every child of theirs in the chosen reports, each with WhatsApp and mail
 * buttons that open the sender's own app with the message ready. Nothing is sent from here and "Opened" is only a button
 * press. The message carries a link to the private sign-in page, never the report's content.
 */
export function BatchReportShare({ reportIds }: { reportIds: string[] }) {
  const [share, setShare] = useState<BatchShareData | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      setShare(await academyRequest<BatchShareData>("/communications/report-batch-share", { reportIds }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ss-box" data-testid="batch-report-share">
      <strong>Send to parents (free)</strong>
      {!share ? (
        <>
          <p>
            One row per parent. Press WhatsApp or Mail on a row and your own app opens with the message ready; you press Send
            there.
          </p>
          <button type="button" className="primary" disabled={busy || reportIds.length === 0} onClick={() => void load()}>
            {busy ? "Preparing…" : `Prepare the parent list (${reportIds.length} report${reportIds.length === 1 ? "" : "s"})`}
          </button>
          {error && <p role="alert">{error}</p>}
        </>
      ) : (
        <>
          <p className="muted">
            {share.reportCount} published report{share.reportCount === 1 ? "" : "s"} · {share.people.length} parent
            {share.people.length === 1 ? "" : "s"}
            {share.notPublished.length ? ` · ${share.notPublished.length} left out because not published` : ""}
          </p>
          {share.people.length === 0 && <p className="muted">No parent account is linked to these players yet.</p>}
          {share.people.length > 0 && (
            <ShareList
              people={share.people}
              country={share.country}
              messageFor={(p) => {
                const names = p.children.length > 1 ? `${p.children.slice(0, -1).join(", ")} and ${p.children.at(-1)}` : (p.children[0] ?? "your child");
                return {
                  subject: `${names}'s development report`,
                  text: [
                    `Hello ${p.name.trim().split(/\s+/)[0] || "there"},`,
                    "",
                    p.children.length > 1 ? `${names}'s reports are ready.` : `${names}'s report is ready.`,
                    `You can read ${p.children.length > 1 ? "them" : "it"} privately here after signing in: ${window.location.origin}`,
                    "",
                    `— ${share.academyName}`,
                  ].join("\n"),
                };
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
