"use client";
import { useEffect, useState } from "react";
import {
  LogOut,
  Home,
  CalendarDays,
  FileText,
  Ellipsis,
  MessagesSquare,
  ShieldCheck,
} from "lucide-react";
import type { AcademyPayload } from "../application/bootstrap";
import { ErrorContext } from "../../training/ui/common";
import { ENVIRONMENT_NOTICE, formatDateTime } from "./labels";
import { ConsentPanel } from "../../consent/ui/consent-panel";
import { GuardianAccessPanel } from "./guardian-access-panel";
import { authorityOf } from "../../identity/authority";
import {
  Editor,
  Details,
  ModuleHeading,
  Status,
  Tabs,
  options,
  text,
  flag,
  academyRequest,
  type DialogSpec,
} from "./shared";
import { Fees, Reports, Nutrition } from "./reviews-finance";
import { AppShell, signOut } from "../../../shell/app-shell";
import { Toast } from "../../../shell/toast";
import { OwnDetails } from "./own-details";
import { PRIMARY_OF, isSection, sectionOfSlug, urlOfSection, type Section } from "./family-sections";
import { CalendarLinkCard } from "./sharing";
import type { ShellItem } from "../../../shell/app-shell";

/**
 * The four primary items (UX-D2): Home, Schedule, Messages, More. Reports sit under Schedule; Fees, Nutrition and
 * Access & preferences sit under More. This is navigation only: every section still loads the same authorised data
 * and the server decides what each person may read or change.
 */
const FAMILY_ITEMS: ShellItem[] = [
  { key: "Home", label: "Home", icon: Home },
  { key: "Schedule", label: "Schedule", icon: CalendarDays },
  { key: "Messages", label: "Messages", icon: MessagesSquare },
  { key: "More", label: "More", icon: Ellipsis },
];
const SCHEDULE_TABS = [
  { value: "Schedule", label: "Sessions" },
  { value: "Reports", label: "Reports" },
];
const sectionFromLocation = (): Section =>
  typeof window === "undefined" ? "Home" : sectionOfSlug(new URLSearchParams(window.location.search).get("section"));
export default function FamilyPortal() {
  const [data, setData] = useState<AcademyPayload | null>(null);
  const [tab, setTab] = useState<Section>("Home");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<DialogSpec | null>(null);
  const [detail, setDetail] = useState<{
    title: string;
    content: React.ReactNode;
  } | null>(null);
  const [myLast4, setMyLast4] = useState<string | null>(null);
  const [waOptIn, setWaOptIn] = useState(false);
  async function loadPhone() {
    try {
      setMyLast4((await academyRequest<{ last4: string | null }>("/communications/my-phone", {})).last4);
      setWaOptIn((await academyRequest<{ optedIn: boolean }>("/contacts/my-opt-in-state", {})).optedIn);
    } catch {
      // The card still works without it: it just says no number is saved.
    }
  }
  async function load() {
    try {
      const result = await academyRequest<AcademyPayload>();
      if (!result.permissions.family) {
        window.location.replace("/");
        return;
      }
      setData(result);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    void loadPhone();
  }, []);
  // The section is part of the address, so a section can be bookmarked or opened directly and the browser's Back and
  // Forward buttons move between sections. Only a known section name is accepted; anything else opens Home.
  useEffect(() => {
    const first = sectionFromLocation();
    setTab(first);
    const given = new URLSearchParams(window.location.search).get("section");
    if (given !== null && first === "Home") window.history.replaceState(null, "", "/family");
    const onPop = () => setTab(sectionFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  function go(name: string) {
    if (!isSection(name) || name === tab) return;
    window.history.pushState(null, "", urlOfSection(name));
    setTab(name);
  }
  async function mutate(path: string, body: unknown) {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await academyRequest(path, body);
      await load();
      setNotice("Saved to your private academy account.");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <main className="loading">
        <h1>Family workspace</h1>
        <p role={error ? "alert" : "status"}>
          {error || "Loading authorised records…"}
        </p>
        <div className="button-row">
          {error && (
            <button
              type="button"
              className="primary"
              onClick={() => {
                setError("");
                void load();
              }}
            >
              Try again
            </button>
          )}
          <a className="secondary" href="/login">
            Sign in
          </a>
        </div>
      </main>
    );
  const p = {
    data,
    mutate,
    open: (spec: DialogSpec) => {
      setError("");
      setEditor(spec);
    },
    detail: (title: string, content: React.ReactNode) =>
      setDetail({ title, content }),
    nav: (name: string) => go(name),
    onSession: () => go("Schedule"),
    busy,
    error: setError,
  };
  function question() {
    p.open({
      title: "Ask a private nutrition question",
      initial: { playerId: data!.players[0]?.id ?? "", question: "" },
      fields: [
        {
          name: "playerId",
          label: "Player",
          kind: "select",
          options: options(data!.players),
          required: true,
        },
        {
          name: "question",
          label: "Question for the nutrition professional",
          kind: "textarea",
          required: true,
          max: 2000,
        },
      ],
      notice:
        "Only an authorised nutrition professional and your account can access this question. This is not an emergency or diagnosis service.",
      submit: (v) =>
        mutate("/nutrition/question", {
          playerId: text(v, "playerId"),
          question: text(v, "question"),
          answer: "",
        }),
    });
  }
  function conversation(id?: string) {
    const c = data!.conversations.find((c) => c.id === id);
    const entryId = crypto.randomUUID();
    p.open({
      title: c ? "Reply to your academy" : "New private conversation",
      initial: {
        playerId: c?.playerId ?? data!.players[0]?.id ?? "",
        subject: c?.subject ?? "",
        text: "",
      },
      fields: [
        ...(!c
          ? [
              {
                name: "playerId",
                label: "Player context",
                kind: "select" as const,
                options: options(data!.players),
                required: true,
              },
              { name: "subject", label: "Subject", required: true },
            ]
          : []),
        {
          name: "text",
          label: "Private message",
          kind: "textarea",
          required: true,
          max: 5000,
        },
      ],
      notice:
        "Messages stay in the academy portal. No WhatsApp or email is sent.",
      submit: (v) =>
        mutate("/communications/conversation", {
          id: c?.id,
          version: c?.version,
          guardianId: data!.actor.id,
          playerId: c?.playerId ?? text(v, "playerId"),
          subject: c?.subject ?? text(v, "subject"),
          text: text(v, "text"),
          entryId,
        }),
    });
  }
  return (
    <ErrorContext.Provider value={error}>
      <AppShell
        product="Family workspace"
        homeHref="/family"
        academy={{
          name: data.academy.name,
          accent: data.settings.data.colour,
          subtitle: "Your authorised records",
        }}
        user={{ name: data.actor.name, role: data.actor.role }}
        items={FAMILY_ITEMS}
        bottomItems={FAMILY_ITEMS}
        activeKey={PRIMARY_OF[tab]}
        onSelect={go}
        breadcrumb={["Family workspace", tab]}
        headerExtras={
          <span className="ax-pill">
            <ShieldCheck size={14} aria-hidden="true" />
            Private · linked players only
          </span>
        }
      >
        <div className="page-heading">
          <div>
            <span className="eyebrow">Connected to their next step</span>
            <h1>{tab === "Home" ? "Your academy connection" : tab}</h1>
            <p>
              {data.academy.name} · {data.academy.timezone}
              {data.development ? ` · ${ENVIRONMENT_NOTICE}` : ""}
            </p>
          </div>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <Toast message={notice} onDismiss={() => setNotice("")} />
        {PRIMARY_OF[tab] === "More" && tab !== "More" && (
          <button type="button" className="text-button" onClick={() => go("More")}>
            ← Back to More
          </button>
        )}
        {tab === "Home" ? (
          <>
            {authorityOf(data.actor.role)?.accountType === "PLAYER" && (
              <OwnDetails mutate={mutate} open={p.open} busy={busy} />
            )}
            <div className="ops-card-grid">
              {data.players.map((pl) => (
                <article className="panel" key={pl.id}>
                  <span className="avatar">{pl.name.charAt(0)}</span>
                  <h2>{pl.name}</h2>
                  <p>{data.batches.find((b) => b.id === pl.batchId)?.name}</p>
                  <Status value={pl.profile.status} />
                  <p className="muted">
                    Training placement is separate from age category.
                  </p>
                </article>
              ))}
            </div>
            <div className="ops-two-col ops-subheading">
              <section className="panel">
                <h3>Published training schedule</h3>
                {data.sessions.slice(0, 5).map((s) => (
                  <button
                    className="record-link"
                    key={s.id}
                    onClick={() => go("Schedule")}
                  >
                    <strong>{s.data.title}</strong>
                    <span>
                      {formatDateTime(s.data.localDate, s.data.localTime)}
                    </span>
                  </button>
                ))}
                {!data.sessions.length && (
                  <p className="muted">No published sessions available yet.</p>
                )}
              </section>
              <section className="panel">
                <h3>Approved updates</h3>
                <p>
                  {data.reports.length} published report(s) ·{" "}
                  {data.nutrition.length} shared nutrition plan(s)
                </p>
                <button
                  className="text-button"
                  onClick={() => go("Reports")}
                >
                  Open published reports →
                </button>
                <div className="notice">
                  Private coaching notes and other players’ records are
                  excluded. Session completion does not automatically send a
                  message.
                </div>
              </section>
            </div>
            <section className="panel ops-subheading" aria-label="Your WhatsApp number">
              <h3>Your WhatsApp number</h3>
              <form
                className="button-row"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const input = e.currentTarget.elements.namedItem("phone") as HTMLInputElement;
                  if (await mutate("/communications/phone", { phone: input.value })) {
                    input.value = "";
                    await loadPhone();
                  }
                }}
              >
                <input
                  name="phone"
                  type="tel"
                  aria-label="Your WhatsApp number"
                  maxLength={40}
                  placeholder="+91 98765 43210"
                />
                <button type="submit" className="secondary" disabled={busy}>
                  {myLast4 ? "Change number" : "Save number"}
                </button>
              </form>
              <p className="muted">
                {myLast4
                  ? `Saved (ending ${myLast4}).`
                  : "Add it once and you will not be asked again."}
              </p>
              {myLast4 && (
                <label className="wb-check">
                  <input
                    type="checkbox"
                    checked={waOptIn}
                    disabled={busy}
                    onChange={async (e) => {
                      if (await mutate("/contacts/my-opt-in", { optIn: e.target.checked })) await loadPhone();
                    }}
                  />{" "}
                  The academy may message me on WhatsApp at this number
                </label>
              )}
            </section>
          </>
        ) : tab === "Schedule" ? (
          <>
            <Tabs items={SCHEDULE_TABS} value={tab} onChange={go} />
            <ModuleHeading
              eyebrow="The shared plan, ready to see"
              title="What’s coming up on court."
              description="Published session focus and your linked players’ adjustments. Internal notes and other players are excluded."
            />
            <CalendarLinkCard />
            <div className="ops-card-grid">
              {data.sessions.map((s) => (
                <article className="panel" key={s.id}>
                  <Status value={s.status} />
                  <h3>{s.data.title}</h3>
                  <p>
                    {formatDateTime(s.data.localDate, s.data.localTime)} ·{" "}
                    {s.data.duration} minutes
                  </p>
                  <p>{s.data.objective}</p>
                  <ul>
                    {s.data.activities.map((a) => (
                      <li key={a.id}>
                        {a.title} · {a.minutes} minutes planned
                      </li>
                    ))}
                  </ul>
                  {s.data.adjustments.map((ad, i) => (
                    <p key={i}>
                      {data.players.find((pl) => pl.id === ad.playerId)?.name}:{" "}
                      {ad.focus}
                    </p>
                  ))}
                </article>
              ))}
            </div>
          </>
        ) : tab === "Reports" ? (
          <>
            <Tabs items={SCHEDULE_TABS} value={tab} onChange={go} />
            <Reports {...p} />
          </>
        ) : tab === "Nutrition" ? (
          <>
            {data.enabled.nutrition && (
              <button className="secondary ops-ask" onClick={question}>
                Ask a private question
              </button>
            )}
            <Nutrition {...p} />
          </>
        ) : tab === "Fees" ? (
          <Fees {...p} />
        ) : tab === "More" ? (
          <>
            <ModuleHeading
              eyebrow="Everything else"
              title="More from your academy."
              description="Fees, nutrition, access and preferences, and signing out."
            />
            <div className="ops-card-grid">
              {(
                [
                  ["Fees", "Invoices and payments for your linked players."],
                  ["Nutrition", "Shared nutrition plans and private questions."],
                  ["Access & preferences", "Which players you can see, and how the academy may contact you."],
                ] as const
              ).map(([name, summary]) => (
                <article className="panel" key={name}>
                  <h3>{name}</h3>
                  <p>{summary}</p>
                  <button type="button" className="text-button" onClick={() => go(name)}>
                    {`Open ${name.toLowerCase()} →`}
                  </button>
                </article>
              ))}
              <article className="panel">
                <h3>Sign out</h3>
                <p>Leave this device signed out of your family account.</p>
                <button type="button" className="secondary" onClick={() => void signOut()}>
                  Sign out
                </button>
              </article>
            </div>
          </>
        ) : tab === "Messages" ? (
          <>
            <ModuleHeading
              eyebrow="Your private academy inbox"
              title="Stay connected, on your terms."
              description="Approved portal updates and private conversations. Email and WhatsApp are not configured."
            />
            <div className="ops-card-grid">
              {data.messages.map((m) => (
                <article className="panel" key={m.id}>
                  <h3>{m.data.subject}</h3>
                  <p className="preserve-lines">{m.data.body}</p>
                  <Status value="AVAILABLE_IN_PORTAL" />
                </article>
              ))}
            </div>
            {data.enabled.communications && (
              <>
                <h3 className="ops-subheading">Private conversations</h3>
                <button className="secondary" onClick={() => conversation()}>
                  Message your academy
                </button>
                <div className="ops-card-grid">
                  {data.conversations.map((c) => (
                    <article className="panel" key={c.id}>
                      <h3>{c.subject}</h3>
                      <small>
                        {data.players.find((pl) => pl.id === c.playerId)?.name}
                      </small>
                      {c.entries.map((e) => (
                        <div className="observation" key={e.id}>
                          <strong>{e.name}</strong>
                          <p>{e.text}</p>
                          <small>{e.at.slice(0, 10)}</small>
                        </div>
                      ))}
                      <button
                        className="text-button"
                        onClick={() => conversation(c.id)}
                      >
                        Reply privately →
                      </button>
                    </article>
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <ModuleHeading
              eyebrow="Access should be explicit"
              title="Your connections and preferences."
              description="Each child’s access is authorised separately. Channel consent controls communication delivery."
            />
            <div className="ops-card-grid">
              {data.players.map((pl) => {
                const link = data.guardianLinks.find(
                  (l) => l.playerId === pl.id,
                );
                // RC-4: a guardian reading an adult player's record through that player's grant holds no consent
                // authority over it (the server sends no link and refuses the consent routes), so no panel is shown.
                // RC-5: "a guardian" is the account whose player scope is LINKED (derived from the authority module),
                // not a stored-role comparison.
                if (!link && authorityOf(data.actor.role)?.scope === "LINKED")
                  return (
                    <article className="panel" key={pl.id}>
                      <h3>{pl.name}</h3>
                      <p>
                        Adult player · You see the sections this player has
                        chosen to share with you. Consent is managed by the
                        player.
                      </p>
                    </article>
                  );
                return (
                  <article className="panel" key={pl.id}>
                    <h3>{pl.name}</h3>
                    <p>
                      {link?.relationship ?? "Adult self-access"} · Authorised
                    </p>
                    <ConsentPanel playerId={pl.id} />
                  </article>
                );
              })}
            </div>
            {/* RC-5: only an adult player's own account sees the guardian-access controls. The server decides
                whether anything is offered (`manage`) and refuses every other account. */}
            {authorityOf(data.actor.role)?.accountType === "PLAYER" && (
              <GuardianAccessPanel />
            )}
            <div className="notice">
              Contact the academy to change authorised guardian-child links.
              Giving or withdrawing consent here never creates access to another
              player.
            </div>
          </>
        )}
        <footer className="workspace-footer">
          <span>Sportozen · Private family workspace</span>
          <span>Human-reviewed records. No generated performance scores.</span>
        </footer>
      </AppShell>
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
    </ErrorContext.Provider>
  );
}
