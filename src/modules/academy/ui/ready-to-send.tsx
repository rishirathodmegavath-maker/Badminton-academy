"use client";
import { useCallback, useEffect, useState } from "react";
import { academyRequest } from "./shared";
import { gmailLink, mailtoLink, outlookLink, whatsappLink } from "../../communications/share-links";

type Item = {
  id: string;
  messageId: string;
  userId: string;
  channel: "EMAIL" | "WHATSAPP";
  name: string;
  email: string | null;
  phone: string | null;
  subject: string;
  body: string;
};

/**
 * Approved announcements are sent by a person, for free: each row opens that person's WhatsApp (wa.me) or mail app
 * (mailto:) with the recipient and the text already filled in. Opening it is recorded as "opened", never as "delivered":
 * nothing here can know whether the message was sent, received or read.
 */
export function ReadyToSend({ academyName, mutate }: { academyName: string; mutate: (path: string, body: unknown) => Promise<boolean> }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [numbers, setNumbers] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setItems((await academyRequest<{ items: Item[] }>("/communications/share-list", {})).items);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function markOpened(id: string) {
    setOpened((s) => new Set(s).add(id));
    // `mutate` records it and refreshes the delivery log behind this list.
    await mutate("/communications/mark-shared", { id });
  }
  async function saveNumber(userId: string) {
    setError("");
    try {
      await academyRequest("/communications/phone", { userId, phone: numbers[userId] ?? "" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const text = (i: Item) => `Hello ${i.name},\n\n${i.subject}\n\n${i.body}\n\n— ${academyName}`;
  if (!items) return <p role="status">{error ? "" : "Loading…"}</p>;
  return (
    <div className="ready-to-send">
      <p>
        These approved messages are waiting for you to send. Press a button: WhatsApp or your mail app opens with the message
        ready, and you press Send there. It is free, and it is sent from your own number or address.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {items.length === 0 && <p className="muted">Nothing is waiting. Approve and schedule an announcement with WhatsApp or Email ticked, then press “Process due approved messages”.</p>}
      {items.length > 0 && (
        <table className="grid-table">
          <thead>
            <tr>
              <th scope="col">Message</th>
              <th scope="col">To</th>
              <th scope="col">Send</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>
                  <strong>{i.subject}</strong>
                </td>
                <td>
                  {i.name} <small>· {i.channel === "EMAIL" ? i.email : i.phone ?? "no WhatsApp number yet"}</small>
                </td>
                <td>
                  {i.channel === "EMAIL" ? (
                    <span className="button-row">
                    <a
                      className="primary button-link"
                      href={mailtoLink(i.email, i.subject, text(i))}
                      onClick={() => void markOpened(i.id)}
                    >
                      {opened.has(i.id) ? "Opened mail app" : "Open mail app"}
                    </a>
                    <a
                      className="secondary button-link"
                      target="_blank"
                      rel="noopener noreferrer"
                      href={gmailLink(i.email, i.subject, text(i))}
                      onClick={() => void markOpened(i.id)}
                    >
                      Gmail
                    </a>
                    <a
                      className="secondary button-link"
                      target="_blank"
                      rel="noopener noreferrer"
                      href={outlookLink(i.email, i.subject, text(i))}
                      onClick={() => void markOpened(i.id)}
                    >
                      Outlook
                    </a>
                    </span>
                  ) : i.phone ? (
                    <a
                      className="primary button-link"
                      target="_blank"
                      rel="noopener noreferrer"
                      href={whatsappLink(i.phone, text(i))}
                      onClick={() => void markOpened(i.id)}
                    >
                      {opened.has(i.id) ? "Opened WhatsApp" : "Open WhatsApp"}
                    </a>
                  ) : (
                    <span className="button-row">
                      <input
                        aria-label={`WhatsApp number for ${i.name}`}
                        type="tel"
                        placeholder="+91 98765 43210"
                        value={numbers[i.userId] ?? ""}
                        onChange={(e) => setNumbers({ ...numbers, [i.userId]: e.target.value })}
                      />
                      <button type="button" className="secondary" onClick={() => void saveNumber(i.userId)}>
                        Save number
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
