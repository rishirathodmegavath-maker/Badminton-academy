"use client";
import { useCallback, useEffect, useState } from "react";
import { academyRequest } from "../../academy/ui/shared";
import {
  SECURITY_EVENT_META,
  SECURITY_EVENT_NAMES,
  SECURITY_OUTCOMES,
} from "../security-event-meta";
/**
 * Account-security log for owners and admins (Settings -> Security events). Read-only: the server
 * decides who may see it, which academy it covers and which fields leave the database; this panel
 * only asks and displays. Text is rendered as text, never as markup.
 */
type Person = { id: string; name: string; role: string; active: boolean };
type Row = {
  id: string;
  event: string;
  label: string;
  outcome: string | null;
  at: string;
  actor: Person | null;
  target: Person | null;
  detail: Record<string, unknown>;
};
type Page = { events: Row[]; nextCursor: string | null };
const dayStart = (v: string) => new Date(`${v}T00:00:00`).toISOString();
const dayEnd = (v: string) => new Date(`${v}T23:59:59.999`).toISOString();
function describe(row: Row) {
  const d = row.detail;
  const parts: string[] = [];
  if (typeof d.reason === "string") parts.push(`Reason: ${d.reason}`);
  if (typeof d.fromRole === "string" && typeof d.toRole === "string")
    parts.push(`${d.fromRole} → ${d.toRole}`);
  if (typeof d.fromMode === "string" && typeof d.toMode === "string")
    parts.push(
      `${d.fromMode} → ${d.toMode}${
        Array.isArray(d.roles) ? ` for ${(d.roles as string[]).join(", ")}` : ""
      }`,
    );
  if (typeof d.contentType === "string")
    parts.push(
      `${d.contentType.replaceAll("-", " ")}${
        typeof d.version === "number" ? ` v${d.version}` : ""
      }${typeof d.actorRole === "string" ? ` by ${d.actorRole.toLowerCase().replaceAll("_", " ")}` : ""}`,
    );
  if (typeof d.scope === "string") parts.push(`${d.scope.toLowerCase()} hold`);
  if (typeof d.action === "string") parts.push(d.action.toLowerCase());
  if (typeof d.days === "number") parts.push(`${d.days} day(s)`);
  if (d.emergency === true) parts.push("emergency override");
  if (typeof d.daysElapsed === "number" && typeof d.requiredDays === "number")
    parts.push(`${d.daysElapsed} of ${d.requiredDays} warning days`);
  if (typeof d.category === "string")
    parts.push(
      `${d.category.toLowerCase()}${
        typeof d.version === "number" ? ` v${d.version}` : ""
      }${typeof d.method === "string" ? ` (${d.method.toLowerCase().replaceAll("_", " ")})` : ""}`,
    );
  if (typeof d.lapsed === "number") parts.push(`${d.lapsed} consent(s) lapsed`);
  if (typeof d.revokedSessions === "number")
    parts.push(`${d.revokedSessions} session(s) ended`);
  if (d.authenticatorRemoved === true) parts.push("authenticator removed");
  if (d.wasTemporary === true) parts.push("replaced a temporary password");
  if (d.generated === true) parts.push("generated password");
  if (typeof d.failures === "number") parts.push(`${d.failures} failures`);
  if (typeof d.expiresAt === "string")
    parts.push(`valid until ${new Date(d.expiresAt).toLocaleString()}`);
  if (typeof d.operator === "string") parts.push(`operator: ${d.operator}`);
  return parts.join(" · ");
}
export function SecurityEventsPanel({
  people,
}: {
  people: { id: string; name: string }[];
}) {
  const [filters, setFilters] = useState({
    event: "",
    outcome: "",
    person: "",
    from: "",
    to: "",
  });
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError("");
      try {
        const q = new URLSearchParams();
        if (filters.event) q.set("event", filters.event);
        if (filters.outcome) q.set("outcome", filters.outcome);
        if (filters.person) q.set("person", filters.person);
        if (filters.from) q.set("from", dayStart(filters.from));
        if (filters.to) q.set("to", dayEnd(filters.to));
        if (cursor) q.set("cursor", cursor);
        const page = await academyRequest<Page>(
          `/security-events?${q.toString()}`,
        );
        setRows((old) => (cursor ? [...old, ...page.events] : page.events));
        setNext(page.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [filters],
  );
  useEffect(() => {
    void load();
    // Reload from the first page whenever a filter changes.
  }, [load]);
  const set = (key: keyof typeof filters) => (value: string) =>
    setFilters((f) => ({ ...f, [key]: value }));
  return (
    <div className="ops-records">
      <p className="wb-context">
        Sign-in, password and two-factor events for people in this academy. Passwords, codes and
        secrets are never recorded. This list cannot be edited or deleted.
      </p>
      <fieldset className="security-events-filters" disabled={loading}>
        <label>
          Event
          <select
            aria-label="Event type"
            value={filters.event}
            onChange={(e) => set("event")(e.target.value)}
          >
            <option value="">All events</option>
            {SECURITY_EVENT_NAMES.map((name) => (
              <option key={name} value={name}>
                {SECURITY_EVENT_META[name].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Outcome
          <select
            aria-label="Outcome"
            value={filters.outcome}
            onChange={(e) => set("outcome")(e.target.value)}
          >
            <option value="">Any outcome</option>
            {SECURITY_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label>
          Person
          <select
            aria-label="Person"
            value={filters.person}
            onChange={(e) => set("person")(e.target.value)}
          >
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            aria-label="From date"
            value={filters.from}
            onChange={(e) => set("from")(e.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            aria-label="To date"
            value={filters.to}
            onChange={(e) => set("to")(e.target.value)}
          />
        </label>
      </fieldset>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!rows.length && !loading && !error ? (
        <div className="empty compact">
          <strong>No matching security events.</strong>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Outcome</th>
                <th>Done by</th>
                <th>Account</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td data-label="When">{new Date(row.at).toLocaleString()}</td>
                  <td data-label="Event">{row.label}</td>
                  <td data-label="Outcome">{row.outcome ?? "—"}</td>
                  <td data-label="Done by">
                    {row.actor
                      ? row.actor.name
                      : row.event === "OPERATOR_RECOVERY"
                        ? "Server operator"
                        : row.actor === null && row.target
                          ? "The account holder or sign-in attempt"
                          : "—"}
                  </td>
                  <td data-label="Account">{row.target?.name ?? "—"}</td>
                  <td data-label="Details">{describe(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <button
          className="secondary"
          disabled={loading}
          onClick={() => void load(next)}
        >
          Load older events
        </button>
      )}
    </div>
  );
}
