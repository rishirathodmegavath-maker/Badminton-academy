/**
 * Bulk report delivery, pure rules. No database, no clock, no I/O.
 *
 *  - `planDispatch`   turns published reports and a recipient choice (parents, players, or both) into the list of messages to
 *                     send and the list of people who will NOT be reached, each with the reason.
 *  - `renderMessage`  the words of one message, for e-mail or for a WhatsApp template.
 *
 * Rules that matter:
 *  - A person is never matched to another by an address. Two RECIPIENTS that happen to share an address at the same channel
 *    receive ONE message there (so nobody is sent the same thing twice), and the preview says so.
 *  - Consolidation PER_PARENT (the default): a parent with several selected children gets ONE message with a separate link
 *    for each child. PER_CHILD: one message per child. A message only ever names and links the children of its recipient.
 *  - WhatsApp (the official channel) needs a live opt-in on that number; e-mail needs only that the address is not suppressed.
 *  - Players are under 18 and have no login. A message to a player's own contact says the report is for their parent or
 *    guardian to open, because the link works only for a signed-in linked parent.
 */
export type Channel = "EMAIL" | "WHATSAPP";
export type Mode = "PARENTS" | "PLAYERS" | "BOTH";
export type Consolidation = "PER_PARENT" | "PER_CHILD";
export type SkipReason = "NO_CONTACT" | "UNREADABLE_NUMBER" | "NOT_OPTED_IN" | "SUPPRESSED" | "NO_PARENT" | "ALREADY_SENT";
export const SKIP_TEXT: Record<SkipReason, string> = {
  NO_CONTACT: "No address or number is saved.",
  UNREADABLE_NUMBER: "The saved number cannot be read (it needs a country code).",
  NOT_OPTED_IN: "No WhatsApp opt-in is recorded for this number.",
  SUPPRESSED: "Sending to this address is stopped (a bounce, a complaint or a stop request).",
  NO_PARENT: "No parent account is linked to this player.",
  ALREADY_SENT: "These reports were already sent, or are already queued, to this address.",
};

export type Subject = { kind: "ACCOUNT" | "PLAYER"; id: string };
export type PlanReport = { id: string; playerId: string; title: string; childFirstName: string };
export type PlanGuardian = { userId: string; name: string; email: string | null; phone: string | null };
export type PlanPlayer = {
  id: string;
  name: string;
  email: string | null;
  /** E.164, or null when none is saved or the saved text cannot be read. */
  phone: string | null;
  phoneUnreadable: boolean;
  guardians: PlanGuardian[];
};
export type ContactFlags = (subject: Subject, channel: Channel, address: string) => { optedIn: boolean; suppressed: boolean };

export type PlannedItem = {
  channel: Channel;
  address: string;
  /** Digest input for duplicate detection: includes the child in PER_CHILD mode. */
  dedupeKey: string;
  recipientNames: string[];
  subjects: Subject[];
  reportIds: string[];
};
export type SkippedRecipient = {
  channel: Channel | null;
  recipientName: string;
  recipientKind: "PARENT" | "PLAYER" | "CHILD";
  childNames: string[];
  /** The reports this recipient would have received, so the record of who was left out also says what they missed. */
  reportIds: string[];
  reason: SkipReason;
  detail: string;
  subject: Subject | null;
  address: string;
};
export type Plan = {
  items: PlannedItem[];
  skipped: SkippedRecipient[];
  /** Messages where two or more recipients share the address: they get one message between them. */
  sharedAddress: number;
};

const unique = <T>(xs: T[], key: (x: T) => string = (x) => String(x)) => {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
};

export function planDispatch(input: {
  reports: PlanReport[];
  players: PlanPlayer[];
  mode: Mode;
  channels: Channel[];
  consolidation: Consolidation;
  flags: ContactFlags;
}): Plan {
  const byKey = new Map<string, PlannedItem>();
  const skipped: SkippedRecipient[] = [];
  const noteSkip = (s: SkippedRecipient) => {
    const dup = skipped.find((x) => x.reason === s.reason && x.channel === s.channel && x.subject?.id === s.subject?.id && x.subject?.kind === s.subject?.kind && x.recipientName === s.recipientName);
    if (dup) {
      dup.childNames = unique([...dup.childNames, ...s.childNames]);
      dup.reportIds = unique([...dup.reportIds, ...s.reportIds]);
    }
    else skipped.push(s);
  };
  for (const player of input.players) {
    const reports = input.reports.filter((r) => r.playerId === player.id);
    if (!reports.length) continue;
    const child = reports[0].childFirstName;
    const candidates: { subject: Subject; name: string; kind: "PARENT" | "PLAYER"; email: string | null; phone: string | null; unreadable: boolean }[] = [];
    if (input.mode !== "PLAYERS") {
      for (const g of player.guardians)
        candidates.push({ subject: { kind: "ACCOUNT", id: g.userId }, name: g.name, kind: "PARENT", email: g.email, phone: g.phone, unreadable: false });
      if (!player.guardians.length)
        for (const channel of input.channels)
          noteSkip({ channel, recipientName: player.name, recipientKind: "CHILD", childNames: [child], reportIds: reports.map((r) => r.id), reason: "NO_PARENT", detail: SKIP_TEXT.NO_PARENT, subject: null, address: "" });
    }
    if (input.mode !== "PARENTS")
      candidates.push({ subject: { kind: "PLAYER", id: player.id }, name: player.name, kind: "PLAYER", email: player.email, phone: player.phone, unreadable: player.phoneUnreadable });
    for (const c of candidates)
      for (const channel of input.channels) {
        const address = channel === "EMAIL" ? c.email : c.phone;
        const skip = (reason: SkipReason) =>
          noteSkip({ channel, recipientName: c.name, recipientKind: c.kind, childNames: [child], reportIds: reports.map((r) => r.id), reason, detail: SKIP_TEXT[reason], subject: c.subject, address: address ?? "" });
        if (!address) {
          skip(channel === "WHATSAPP" && c.unreadable ? "UNREADABLE_NUMBER" : "NO_CONTACT");
          continue;
        }
        const f = input.flags(c.subject, channel, address);
        if (f.suppressed) {
          skip("SUPPRESSED");
          continue;
        }
        if (channel === "WHATSAPP" && !f.optedIn) {
          skip("NOT_OPTED_IN");
          continue;
        }
        const dedupeKey = input.consolidation === "PER_CHILD" ? `${channel}|${address}|${player.id}` : `${channel}|${address}`;
        const item = byKey.get(dedupeKey) ?? { channel, address, dedupeKey, recipientNames: [], subjects: [], reportIds: [] };
        item.recipientNames = unique([...item.recipientNames, c.name]);
        item.subjects = unique([...item.subjects, c.subject], (s) => `${s.kind}:${s.id}`);
        item.reportIds = unique([...item.reportIds, ...reports.map((r) => r.id)]);
        byKey.set(dedupeKey, item);
      }
  }
  const items = [...byKey.values()].sort((a, b) => a.recipientNames[0].localeCompare(b.recipientNames[0]) || a.channel.localeCompare(b.channel));
  return { items, skipped, sharedAddress: items.filter((i) => i.subjects.length > 1).length };
}

export type MessageChild = { childFirstName: string; title: string; url: string };
export type Rendered = { subject: string; text: string; templateParams: string[] };
const first = (name: string) => name.trim().split(/\s+/)[0] || "there";
const join = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

/**
 * The words of one message. It names only the children it carries and carries one link per child. The link opens a private,
 * signed-in page; the message never contains any part of a report. `forPlayerOnly` is true when no parent is among the
 * recipients: the text then says a parent or guardian must open it.
 */
export function renderMessage(input: { academyName: string; recipientNames: string[]; children: MessageChild[]; forPlayerOnly: boolean }): Rendered {
  const names = input.children.map((c) => c.childFirstName);
  const hello = `Hello ${first(input.recipientNames[0] ?? "")},`;
  const many = input.children.length > 1;
  const sentence = input.forPlayerOnly
    ? `${many ? `The development reports for ${join(names)} are` : `${names[0]}'s development report is`} ready. A parent or guardian opens ${many ? "them" : "it"} by signing in to their academy account.`
    : `${many ? `The development reports for ${join(names)} are` : `${names[0]}'s development report is`} ready. Open ${many ? "each one" : "it"} privately after signing in:`;
  const links = input.children.map((c) => (many ? `${c.childFirstName}: ${c.url}` : c.url));
  const text = [hello, "", sentence, ...links, "", `— ${input.academyName}`].join("\n");
  return {
    subject: many ? `${join(names)}: development reports` : `${names[0]}'s development report`,
    text,
    // A WhatsApp template body takes single-line variables: the greeting name, the child names, and the links on one line.
    templateParams: [first(input.recipientNames[0] ?? ""), join(names), input.children.map((c) => (many ? `${c.childFirstName}: ${c.url}` : c.url)).join(" | ")],
  };
}
