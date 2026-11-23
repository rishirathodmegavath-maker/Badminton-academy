"use client";
import { useCallback, useEffect, useState } from "react";
/**
 * Settings -> Two-factor policy. Shows where the rollout stands and, for owners, changes it. The
 * server decides everything (who may see or change the policy, the staged-rollout rules, the
 * re-authentication); this panel displays its answers and its refusal messages. No authenticator
 * material is ever received here.
 */
const ROLES = [
  "OWNER",
  "ADMIN",
  "HEAD_COACH",
  "COACH",
  "FINANCE",
  "NUTRITION_PRO",
  "GUARDIAN",
  "ADULT_PLAYER",
];
const DEFAULT_STAFF = ROLES.slice(0, 6);
type Finding = { code: string; message: string };
type Overview = {
  stage: "off" | "warn" | "enforce";
  canEdit: boolean;
  deployment: { mode: string; roles: string[] };
  academy: {
    mode: "off" | "warn" | "enforce";
    roles: string[];
    warnSince: string | null;
  };
  roles: {
    role: string;
    level: string;
    source: string;
    members: number;
    enrolled: number;
  }[];
  totals: { accounts: number; enrolled: number; needingAction: number };
  needsAction: {
    id: string;
    name: string;
    role: string;
    level: string;
    hasTemporaryPassword: boolean;
  }[];
  recovery: {
    activeOwners: number;
    enrolledOwners: number;
    singleOwner: boolean;
  };
  grace: { days: number; eligibleAt: string | null; met: boolean };
  enforcement: { ready: boolean; blockers: Finding[]; warnings: Finding[] };
};
const LEVEL: Record<string, string> = {
  optional: "Optional",
  warn: "Warning only",
  required: "Required",
};
const STAGE_HELP: Record<string, string> = {
  off: "Off — two-factor authentication is available but nobody is asked to use it.",
  warn: "Warning — the chosen roles are asked to set it up and keep full access.",
  enforce:
    "Required — the chosen roles must set it up. People who have not can still sign in, but only to set it up.",
};
const label = (r: string) => r.toLowerCase().replaceAll("_", " ");
export function MfaPolicyPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"off" | "warn" | "enforce">("off");
  const [roles, setRoles] = useState<string[]>(DEFAULT_STAFF);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/account/mfa-policy", {
        cache: "no-store",
      });
      const json = await response.json();
      if (!response.ok)
        throw new Error(json?.message ?? "The policy could not be loaded.");
      setData(json);
      setMode(json.academy.mode);
      setRoles(json.academy.roles.length ? json.academy.roles : DEFAULT_STAFF);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const v = new FormData(form);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/auth/account/mfa-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          roles,
          reason: String(v.get("reason") ?? ""),
          ownerPassword: String(v.get("password") ?? ""),
          acknowledgeRisk: v.get("acknowledge") === "on",
          ...(v.get("emergency") === "on"
            ? {
                emergencyOverride: true,
                emergencyReason: String(v.get("emergencyReason") ?? ""),
              }
            : {}),
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        setError(json?.message ?? "That change was not accepted.");
        return;
      }
      setData(json.overview);
      setMessage(
        json.changed
          ? "Policy saved and recorded in the security log."
          : "Nothing changed.",
      );
      form.reset();
    } catch {
      setError("The server is unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <p
        role={error ? "alert" : "status"}
        className={error ? "error" : undefined}
      >
        {error || "Loading…"}
      </p>
    );
  return (
    <div className="ops-records">
      <p className="wb-context">
        Stage now: <strong>{STAGE_HELP[data.stage]}</strong> Your academy can
        only raise what the server&apos;s own setting asks (currently{" "}
        {data.deployment.mode}); it can never lower it.
      </p>
      <div className="table-wrap">
        <table className="ops-table">
          <caption>Two-factor requirement by role</caption>
          <thead>
            <tr>
              <th>Role</th>
              <th>Requirement</th>
              <th>Set by</th>
              <th>Enrolled</th>
            </tr>
          </thead>
          <tbody>
            {data.roles.map((r) => (
              <tr key={r.role}>
                <td data-label="Role">{label(r.role)}</td>
                <td data-label="Requirement">{LEVEL[r.level]}</td>
                <td data-label="Set by">
                  {r.source === "none" ? "—" : r.source}
                </td>
                <td data-label="Enrolled">
                  {r.enrolled} of {r.members}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Readiness</h4>
      <p>
        {data.totals.enrolled} of {data.totals.accounts} people in roles that
        are asked have set up two-factor authentication;{" "}
        {data.totals.needingAction} still need to.
      </p>
      {data.needsAction.length > 0 && (
        <ul>
          {data.needsAction.map((m) => (
            <li key={m.id}>
              {m.name} ({label(m.role)}) —{" "}
              {m.hasTemporaryPassword
                ? "must replace their temporary password first"
                : "has not set it up"}
            </li>
          ))}
        </ul>
      )}
      <p>
        Recovery: {data.recovery.enrolledOwners} of {data.recovery.activeOwners}{" "}
        owner(s) enrolled.{" "}
        {data.recovery.singleOwner
          ? "With a single owner, a lost authenticator and recovery codes can only be fixed by the server operator."
          : "Another owner can reset a member's authenticator after verifying who they are."}
      </p>
      {data.enforcement.blockers.length > 0 && data.stage !== "enforce" && (
        <ul aria-label="Before making it required">
          {data.enforcement.blockers.map((b) => (
            <li key={b.code}>Not ready: {b.message}</li>
          ))}
        </ul>
      )}
      {data.enforcement.warnings.length > 0 && (
        <ul aria-label="Things to know">
          {data.enforcement.warnings.map((w) => (
            <li key={w.code}>{w.message}</li>
          ))}
        </ul>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {data.canEdit ? (
        <form onSubmit={save}>
          <fieldset disabled={busy}>
            <legend>Change the academy policy (owners only)</legend>
            <label>
              Stage
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
              >
                <option value="off">Off (optional for everyone)</option>
                <option value="warn">Warning (ask the chosen roles)</option>
                <option value="enforce">
                  Required (chosen roles must enrol)
                </option>
              </select>
            </label>
            <small>{STAGE_HELP[mode]}</small>
            <fieldset>
              <legend>Roles this applies to</legend>
              {ROLES.map((role) => (
                <label key={role} className="check">
                  <input
                    type="checkbox"
                    checked={roles.includes(role)}
                    onChange={(e) =>
                      setRoles((old) =>
                        e.target.checked
                          ? [...old, role]
                          : old.filter((r) => r !== role),
                      )
                    }
                  />
                  {label(role)}
                  {role === "GUARDIAN" || role === "ADULT_PLAYER"
                    ? " (optional by default)"
                    : ""}
                </label>
              ))}
            </fieldset>
            <label>
              Reason (recorded in the security log)
              <textarea
                name="reason"
                minLength={10}
                maxLength={500}
                required
                rows={2}
              />
            </label>
            {mode === "enforce" && (
              <label className="check">
                <input type="checkbox" name="acknowledge" />I have reviewed the
                readiness above and understand that people who have not
                enrolled will be limited to setting it up.
              </label>
            )}
            {mode === "enforce" && !data.grace.met && (
              <fieldset>
                <legend>Emergency override (owners only)</legend>
                <small>
                  People must have {data.grace.days} full days of warning before
                  a role becomes required
                  {data.grace.eligibleAt
                    ? ` (from ${new Date(data.grace.eligibleAt).toLocaleString()})`
                    : ""}
                  . Skipping that is recorded in the security log with your
                  reason.
                </small>
                <label className="check">
                  <input type="checkbox" name="emergency" />I am skipping the
                  warning period because of an emergency.
                </label>
                <label>
                  Why the full warning period cannot be given
                  <textarea
                    name="emergencyReason"
                    minLength={20}
                    maxLength={500}
                    rows={2}
                  />
                </label>
              </fieldset>
            )}
            <label>
              Your password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <button className="primary" disabled={busy}>
              Save policy
            </button>
          </fieldset>
        </form>
      ) : (
        <p>Only an academy owner can change this policy.</p>
      )}
    </div>
  );
}
