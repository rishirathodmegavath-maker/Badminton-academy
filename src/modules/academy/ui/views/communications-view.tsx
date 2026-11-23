"use client";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceProps } from "../context";
import { Tabs, Status, GridTable, Action, academyRequest } from "../shared";
import { CHANNELS, channelLabel } from "../labels";
import { Pane, Blank, ContextNote } from "../workbench";
import { ReadyToSend } from "../ready-to-send";
import {
  AudienceNote,
  type AudienceSummary,
  type PreviewRecipient,
} from "../audience-note";
export function CommunicationsView(
  p: WorkspaceProps & {
    message: (id?: string, action?: string) => void;
    preview: (id: string) => void;
    conversation: (id?: string) => void;
    template: () => void;
  },
) {
  const d = p.data;
  const [tab, setTab] = useState(
    d.messages.some((m) => m.id === p.focusId)
      ? "Delivery log"
      : "Announcements",
  );
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [playerIds, setPlayers] = useState<string[]>([]);
  const [batchIds, setBatches] = useState<string[]>([]);
  // "All families" or "Only selected" (the ticked batches and players). Choosing one never throws the other list away.
  const [audience, setAudience] = useState<"ALL" | "SELECTED">("ALL");
  const allBatches = audience === "ALL";
  const [channels, setChannels] = useState(["PORTAL"]);
  const [recipients, setRecipients] = useState<PreviewRecipient[] | null>(null);
  const [summary, setSummary] = useState<AudienceSummary | null>(null);
  const [channel, setChannel] = useState("PORTAL");
  const data = {
    subject,
    body,
    playerIds: allBatches ? [] : playerIds,
    batchIds: allBatches ? [] : batchIds,
    allBatches,
    channels,
    templateId: null,
  };
  // Who it would reach depends only on the audience and channels, so it is re-checked when those change (not while typing).
  const check = useRef(0);
  const audienceKey = JSON.stringify([allBatches, allBatches ? [] : playerIds, allBatches ? [] : batchIds, channels]);
  useEffect(() => {
    if (!channels.length) {
      setRecipients([]);
      setSummary({ players: 0, playersWithParent: 0, reach: { PORTAL: 0, EMAIL: 0, WHATSAPP: 0 }, needNumber: 0 });
      return;
    }
    const mine = ++check.current;
    academyRequest<{ recipients: PreviewRecipient[]; audience: AudienceSummary }>("/communications/preview", {
      ...data,
      // The wording does not change who is covered, so placeholders keep the check working before anything is typed.
      subject: subject.length >= 2 ? subject : "Preview",
      body: body.length >= 3 ? body : "Preview",
    })
      .then((r) => {
        if (mine !== check.current) return;
        setRecipients(r.recipients);
        setSummary(r.audience);
      })
      .catch(() => {
        if (mine === check.current) {
          setRecipients(null);
          setSummary(null);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audienceKey]);
  const change = () => undefined;
  // Nothing else runs scheduled messages, so opening this page does it: once per visit, only for a message that is due.
  const processed = useRef(false);
  const canProcess = d.permissions.ops;
  const hasDue = d.messages.some(
    (m) =>
      m.status === "SCHEDULED" &&
      !!m.data.scheduledAt &&
      Date.parse(m.data.scheduledAt) <= Date.now(),
  );
  useEffect(() => {
    if (!canProcess || !hasDue || processed.current) return;
    processed.current = true;
    void p.mutate("/communications/process", {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canProcess, hasDue]);
  async function sendNow(m: (typeof d.messages)[number]) {
    const ok = await p.mutate("/communications/save", {
      id: m.id,
      version: m.version,
      action: "schedule",
      scheduledAt: new Date().toISOString(),
      data: {
        subject: m.data.subject,
        body: m.data.body,
        playerIds: m.data.playerIds,
        batchIds: m.data.batchIds,
        allBatches: m.data.allBatches,
        channels: m.data.channels,
        templateId: m.data.templateId ?? null,
      },
    });
    if (ok) await p.mutate("/communications/process", {});
  }
  return (
    <div className="reference-view">
      <Tabs
        items={[
          "Announcements",
          "Private conversations",
          "Templates",
          "Scheduled outbox",
          "Ready to send",
          "Delivery log",
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "Announcements" ? (
        <div className="communications-workbench">
          <Pane title="Compose announcement">
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await p.mutate("/communications/save", {
                    action: "save",
                    scheduledAt: null,
                    data,
                  })
                ) {
                  setSubject("");
                  setBody("");
                }
              }}
            >
              <fieldset disabled={p.busy || !d.permissions.coaching}>
                <label>
                  Saved template
                  <select
                    onChange={(e) => {
                      const t = d.templates.find(
                        (t) => t.id === e.target.value,
                      );
                      if (t) {
                        setSubject(t.subject);
                        setBody(t.body);
                        change();
                      }
                    }}
                    defaultValue=""
                  >
                    <option value="">Choose template</option>
                    {d.templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Subject
                  <input
                    value={subject}
                    onChange={(e) => {
                      setSubject(e.target.value);
                      change();
                    }}
                    required
                    minLength={2}
                    maxLength={150}
                  />
                </label>
                <label>
                  Message
                  <textarea
                    value={body}
                    onChange={(e) => {
                      setBody(e.target.value);
                      change();
                    }}
                    rows={7}
                    required
                    minLength={3}
                    maxLength={5000}
                  />
                </label>
                <fieldset className="choice-group">
                  <legend>Who should get it?</legend>
                  <label className="wb-check">
                    <input
                      type="radio"
                      name="audience"
                      checked={audience === "ALL"}
                      onChange={() => setAudience("ALL")}
                    />
                    All families (every player you are allowed to message)
                  </label>
                  <label className="wb-check">
                    <input
                      type="radio"
                      name="audience"
                      checked={audience === "SELECTED"}
                      onChange={() => setAudience("SELECTED")}
                    />
                    Only the batches / players I choose
                  </label>
                </fieldset>
                {audience === "SELECTED" && (
                  <>
                    <label>
                      Batches (hold Ctrl to pick more than one)
                      <select
                        multiple
                        value={batchIds}
                        onChange={(e) =>
                          setBatches(
                            Array.from(e.target.selectedOptions, (o) => o.value),
                          )
                        }
                      >
                        {d.batches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Players’ parents (hold Ctrl to pick more than one)
                      <select
                        multiple
                        value={playerIds}
                        onChange={(e) =>
                          setPlayers(
                            Array.from(e.target.selectedOptions, (o) => o.value),
                          )
                        }
                      >
                        {d.players.map((pl) => (
                          <option key={pl.id} value={pl.id}>
                            {pl.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <div className="wb-channel-options">
                  {["PORTAL", "EMAIL", "WHATSAPP"].map((c) => (
                    <label className="wb-check" key={c}>
                      <input
                        type="checkbox"
                        checked={channels.includes(c)}
                        onChange={(e) => {
                          setChannels(
                            e.target.checked
                              ? [...channels, c]
                              : channels.filter((v) => v !== c),
                          );
                          change();
                        }}
                      />
                      {channelLabel(c)}
                      {c !== "PORTAL" &&
                        ` · you send it from your own ${c === "EMAIL" ? "mail app" : "WhatsApp"} (free)`}
                    </label>
                  ))}
                </div>
                <div className="wb-bottom-actions">
                  <button className="primary" disabled={!channels.length}>
                    Save draft
                  </button>
                </div>
              </fieldset>
            </form>
          </Pane>
          <div>
            <Pane title="Channel preview">
              <Tabs
                items={CHANNELS.map((c) => ({ value: c, label: channelLabel(c) }))}
                value={channel}
                onChange={setChannel}
              />
              <div className={`wb-message-preview ${channel.toLowerCase()}`}>
                <small>{d.academy.name}</small>
                <h3>{subject || "Announcement subject"}</h3>
                <p className="preserve-lines">
                  {body || "Your message preview appears here as you write."}
                </p>
              </div>
              <Status
                value={
                  channel === "PORTAL" ? "PRIVATE_PORTAL" : "READY_TO_SHARE"
                }
              />
              <AudienceNote
                audience={summary}
                recipients={recipients}
                channels={channels}
                showPeople
              />
              <ContextNote>
                Save, review exact recipients, approve, then schedule. Email and
                WhatsApp are free: after you process the message, each family
                appears under “Ready to send” with a button that opens your own
                WhatsApp or mail app.
              </ContextNote>
            </Pane>
            <Pane
              title="Recent private conversations"
              action={
                <button
                  className="text-button"
                  onClick={() => p.conversation()}
                >
                  New conversation
                </button>
              }
            >
              {d.conversations.slice(0, 3).map((c) => (
                <button
                  className="wb-conversation-row"
                  key={c.id}
                  onClick={() => p.conversation(c.id)}
                >
                  <strong>{c.subject}</strong>
                  <span>{c.entries.at(-1)?.text}</span>
                </button>
              ))}
              {!d.conversations.length && (
                <p className="muted">No private conversations yet.</p>
              )}
            </Pane>
          </div>
        </div>
      ) : null}
      {(tab === "Announcements" || tab === "Scheduled outbox") && (
        <Pane
          title={
            tab === "Announcements" ? "Saved announcements" : "Scheduled outbox"
          }
          action={
            tab === "Scheduled outbox" &&
            d.permissions.ops && (
              <button
                className="secondary"
                disabled={p.busy}
                onClick={() => p.mutate("/communications/process", {})}
              >
                Process due approved messages
              </button>
            )
          }
        >
          <GridTable
            rows={d.messages.filter(
              (m) =>
                (!d.messages.some((item) => item.id === p.focusId) ||
                  m.id === p.focusId) &&
                (tab !== "Scheduled outbox" ||
                  ["SCHEDULED", "BLOCKED"].includes(m.status)),
            )}
            columns={[
              {
                label: "Message",
                render: (m) => (
                  <>
                    <strong>{m.data.subject}</strong>
                    <small>{m.data.body.slice(0, 90)}</small>
                  </>
                ),
              },
              {
                label: "Recipients",
                render: (m) => `${m.data.recipients.length} approved`,
              },
              { label: "State", render: (m) => <Status value={m.status} /> },
            ]}
            actions={(m) => (
              <>
                <Action onClick={() => p.preview(m.id)}>
                  Review recipients
                </Action>
                {m.status === "DRAFT" && (
                  <>
                    <Action onClick={() => p.message(m.id)}>Edit</Action>
                    {d.permissions.ops && (
                      <Action onClick={() => p.message(m.id, "approve")}>
                        Approve
                      </Action>
                    )}
                  </>
                )}
                {m.status === "APPROVED" && d.permissions.ops && (
                  <>
                    <Action onClick={() => void sendNow(m)}>Send now</Action>
                    <Action onClick={() => p.message(m.id, "schedule")}>
                      Schedule
                    </Action>
                  </>
                )}
                {["APPROVED", "SCHEDULED", "BLOCKED"].includes(m.status) && (
                  <Action onClick={() => p.message(m.id, "revise")}>
                    Revise draft
                  </Action>
                )}
              </>
            )}
          />
        </Pane>
      )}
      {tab === "Private conversations" && (
        <Pane
          title="Private conversations"
          action={
            <button className="primary" onClick={() => p.conversation()}>
              New private conversation
            </button>
          }
        >
          {d.conversations.map((c) => (
            <article className="wb-inset" key={c.id}>
              <h3>{c.subject}</h3>
              {c.entries.map((e) => (
                <blockquote key={e.id}>
                  <strong>{e.name}</strong>
                  <p>{e.text}</p>
                </blockquote>
              ))}
              <Action onClick={() => p.conversation(c.id)}>
                Reply privately
              </Action>
            </article>
          ))}
          {!d.conversations.length && (
            <Blank text="Private family conversations appear here." />
          )}
        </Pane>
      )}
      {tab === "Templates" && (
        <Pane
          title="Saved templates"
          action={
            d.permissions.ops && (
              <button className="primary" onClick={p.template}>
                Create template
              </button>
            )
          }
        >
          <GridTable
            rows={d.templates}
            columns={[
              { label: "Template", render: (t) => t.name },
              { label: "Subject", render: (t) => t.subject },
              { label: "Message", render: (t) => t.body },
            ]}
          />
        </Pane>
      )}
      {tab === "Ready to send" && (
        <Pane title="Ready to send">
          <ReadyToSend academyName={d.academy.name} mutate={p.mutate} />
        </Pane>
      )}
      {tab === "Delivery log" && (
        <Pane title="Delivery history">
          <GridTable
            rows={d.deliveries}
            columns={[
              {
                label: "Message",
                render: (r) =>
                  d.messages.find((m) => m.id === r.messageId)?.data.subject ??
                  "Message",
              },
              { label: "Channel", render: (r) => r.channel },
              {
                label: "Actual status",
                render: (r) => (
                  <>
                    <Status value={r.status} />
                    <small>{r.detail}</small>
                  </>
                ),
              },
            ]}
          />
        </Pane>
      )}
    </div>
  );
}
