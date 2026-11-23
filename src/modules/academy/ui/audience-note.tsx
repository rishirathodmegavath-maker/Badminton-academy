"use client";

/**
 * Says, before anything is approved, who a message would reach and, when nobody qualifies, why and what to change. The numbers
 * come from the server's preview (`audience` = players covered, how many have a parent account, how many parents agreed to each
 * channel). Nothing here is a delivery claim: it only describes who may be offered the message.
 */
export type AudienceSummary = {
  players: number;
  playersWithParent: number;
  reach: { PORTAL: number; EMAIL: number; WHATSAPP: number };
  /** Parents with no WhatsApp number saved yet: they can still be messaged once a number is added. */
  needNumber: number;
};
export type PreviewRecipient = { name: string; channels: string[]; playerIds?: string[] };

const NAME: Record<string, string> = { PORTAL: "Portal", EMAIL: "Email", WHATSAPP: "WhatsApp" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The one-sentence reason nobody can receive the message, with the fix. Null when at least one family can. */
export function whyNobody(
  audience: AudienceSummary,
  recipients: PreviewRecipient[],
  channels: string[],
): string | null {
  if (recipients.length) return null;
  if (!audience.players)
    return "No players are covered yet. Choose “All families”, or tick the batches or players you want to reach.";
  if (!audience.playersWithParent)
    return `${plural(audience.players, "player")} covered, but none has a parent account linked yet. Invite the parent first.`;
  const others = (["PORTAL", "EMAIL", "WHATSAPP"] as const).filter((c) => !channels.includes(c) && audience.reach[c] > 0);
  if (others.length)
    return `None of the channels you ticked can reach anyone. Tick ${others
      .map((c) => `${NAME[c]} (${plural(audience.reach[c], "family", "families")})`)
      .join(" or ")} instead.`;
  return "None of the parents can be reached on the channels you ticked. Tick another channel.";
}

export function AudienceNote({
  audience,
  recipients,
  channels,
  showPeople = false,
}: {
  audience: AudienceSummary | null;
  recipients: PreviewRecipient[] | null;
  channels: string[];
  showPeople?: boolean;
}) {
  if (!audience || !recipients) return <p className="muted">Checking who this would reach…</p>;
  const problem = whyNobody(audience, recipients, channels);
  return (
    <div className="wb-recipient-preview" role="status">
      <h3>
        {recipients.length
          ? `${plural(recipients.length, "family", "families")} will receive this`
          : "Nobody can receive this yet"}
      </h3>
      <p className="muted">
        {plural(audience.players, "player")} covered · {audience.playersWithParent} with a parent account · can be reached:{" "}
        {(["PORTAL", "EMAIL", "WHATSAPP"] as const).map((c) => `${NAME[c]} ${audience.reach[c]}`).join(" · ")}
      </p>
      {problem && (
        <div className="error" role="alert">
          {problem}
        </div>
      )}
      {!problem && audience.needNumber > 0 && channels.includes("WHATSAPP") && (
        <p className="muted">
          {plural(audience.needNumber, "parent")} {audience.needNumber === 1 ? "has" : "have"} no WhatsApp number saved yet. You
          can add it under “Ready to send”.
        </p>
      )}
      {showPeople &&
        recipients.map((r, i) => (
          <p key={i}>
            {r.name} · {r.channels.map((c) => NAME[c] ?? c).join(", ")}
          </p>
        ))}
    </div>
  );
}
