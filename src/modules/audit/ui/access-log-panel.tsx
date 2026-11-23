"use client";
import { useCallback, useEffect, useState } from "react";
import { academyRequest } from "../../academy/ui/shared";
import {
  ACCESS_CATEGORIES,
  ACCESS_LABEL,
  ACCESS_OPERATIONS,
  ACCESS_OUTCOMES,
  OPERATION_LABEL,
  type AccessCategory,
  type AccessOperation,
} from "../domain";
/**
 * Settings -> Access history (owners and admins). Who looked at sensitive information, when, through
 * what, and whether it was allowed. Read-only: the server decides who may see it, which academy it
 * covers and which fields leave the database. The history holds identifiers, kinds, counts and
 * outcomes - never the information itself - and cannot be edited or deleted. Text is rendered as text.
 */
type Row = {
  id: string;
  at: string;
  category: string;
  categoryLabel: string;
  operation: string;
  operationLabel: string;
  outcome: "SUCCESS" | "DENIED";
  actor: { id: string; role: string; name: string | null; active: boolean };
  resourceId: string | null;
  player: { id: string; name: string | null } | null;
  channel: string;
  requestId: string | null;
  context: {
    status?: number;
    reason?: string;
    count?: number;
    counts?: Record<string, number>;
    withdrawn?: boolean;
    limit?: number;
    windowMinutes?: number;
  };
};
type Page = { events: Row[]; nextCursor: string | null };
const dayStart = (v: string) => new Date(`${v}T00:00:00`).toISOString();
const dayEnd = (v: string) => new Date(`${v}T23:59:59.999`).toISOString();
const role = (r: string) => r.toLowerCase().replaceAll("_", " ");
function describe(row: Row) {
  const c = row.context;
  const parts: string[] = [];
  if (row.operation === "THROTTLED")
    parts.push(
      `further refusals for this person were not itemised for ${c.windowMinutes ?? "a few"} minutes`,
    );
  if (c.reason)
    parts.push(
      c.reason === "ROLE"
        ? "not permitted for this role"
        : "not found or not available to this person",
    );
  if (typeof c.count === "number") parts.push(`${c.count} item(s)`);
  if (c.withdrawn) parts.push("withdrawn content");
  if (c.counts)
    parts.push(
      Object.entries(c.counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}`)
        .join(", "),
    );
  return parts.filter(Boolean).join(" · ");
}
export function AccessLogPanel({
  people,
}: {
  people: { id: string; name: string }[];
}) {
  const [filters, setFilters] = useState({
    category: "",
    operation: "",
    outcome: "",
    actor: "",
    resource: "",
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
        if (filters.category) q.set("category", filters.category);
        if (filters.operation) q.set("operation", filters.operation);
        if (filters.outcome) q.set("outcome", filters.outcome);
        if (filters.actor) q.set("actor", filters.actor);
        if (filters.resource.trim()) q.set("resource", filters.resource.trim());
        if (filters.from) q.set("from", dayStart(filters.from));
        if (filters.to) q.set("to", dayEnd(filters.to));
        if (cursor) q.set("cursor", cursor);
        const page = await academyRequest<Page>(`/access-events?${q.toString()}`);
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
        Who opened sensitive information in this academy, and whether they were allowed to. Only the
        kind of information, the record reference, the person, the time and the outcome are kept - never
        the information itself. Opening this page is recorded too. This list cannot be edited or deleted.
      </p>
      <fieldset className="security-events-filters" disabled={loading}>
        <label>
          Information
          <select
            aria-label="Kind of information"
            value={filters.category}
            onChange={(e) => set("category")(e.target.value)}
          >
            <option value="">All kinds</option>
            {ACCESS_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ACCESS_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label>
          How
          <select
            aria-label="Operation"
            value={filters.operation}
            onChange={(e) => set("operation")(e.target.value)}
          >
            <option value="">Any</option>
            {ACCESS_OPERATIONS.map((o) => (
              <option key={o} value={o}>
                {OPERATION_LABEL[o]}
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
            {ACCESS_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o === "SUCCESS" ? "Allowed" : "Denied"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Person
          <select
            aria-label="Person"
            value={filters.actor}
            onChange={(e) => set("actor")(e.target.value)}
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
          Record or player reference
          <input
            aria-label="Record reference"
            maxLength={64}
            value={filters.resource}
            onChange={(e) => set("resource")(e.target.value)}
          />
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
          <strong>No matching access events.</strong>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ops-table">
            <caption>Sensitive-data access history, newest first</caption>
            <thead>
              <tr>
                <th>When</th>
                <th>Person</th>
                <th>Information</th>
                <th>How</th>
                <th>Outcome</th>
                <th>Player / record</th>
                <th>Through</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td data-label="When">{new Date(row.at).toLocaleString()}</td>
                  <td data-label="Person">
                    {row.actor.name ?? "Former member"} ({role(row.actor.role)})
                  </td>
                  <td data-label="Information">{row.categoryLabel}</td>
                  <td data-label="How">{row.operationLabel}</td>
                  <td data-label="Outcome">
                    {row.outcome === "DENIED" ? "Denied" : "Allowed"}
                  </td>
                  <td data-label="Player / record">
                    {row.player ? (row.player.name ?? row.player.id) : ""}
                    {row.resourceId && !row.player ? row.resourceId : ""}
                    {!row.player && !row.resourceId ? "—" : ""}
                  </td>
                  <td data-label="Through">
                    {row.channel}
                    {row.requestId ? ` · ${row.requestId.slice(0, 8)}` : ""}
                  </td>
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
export type { AccessCategory, AccessOperation };
