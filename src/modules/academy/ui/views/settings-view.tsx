"use client";
import { useEffect, useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import type { WorkspaceProps } from "../context";
import { Tabs, Status, GridTable, Action } from "../shared";
import { Pane, Toolbar, ContextNote } from "../workbench";
import { SecurityEventsPanel } from "../../../identity/ui/security-events-panel";
import { AccessLogPanel } from "../../../audit/ui/access-log-panel";
import { PrivacyPanel } from "../../../privacy/ui/privacy-panel";
import { MfaPolicyPanel } from "../../../identity/ui/mfa-policy-panel";
import { InvitationsPanel } from "../../../invitations/ui/invitations-panel";
import { ConsentPoliciesPanel } from "../../../consent/ui/consent-policies-panel";
import { can } from "../../../identity/authority";
import { accountLabel } from "../navigation";
import { label as displayLabel } from "../labels";
import { initials } from "@/shell/brand";

/**
 * Settings, in six groups (the same idea as the football app):
 *   Academy            profile and logo, regional settings, branding, modules, plan
 *   Team               who has access, and invitations
 *   Sessions           branches and batches
 *   Privacy & policies academy policy, consent documents, privacy and erasure
 *   Security & audit   two-factor policy, security events, access history, audit history
 *   Integrations       connected services and the Sportozen subscription
 * Every control keeps the permission it always had: what a person is shown is a convenience, the server decides.
 */
const GROUPS = ["Academy", "Team", "Sessions", "Privacy & policies", "Security & audit", "Integrations"] as const;
type Group = (typeof GROUPS)[number];
const LOGO_MAX_BYTES = 200_000;
const MODULE_LABEL: Record<string, string> = {
  reports: "Reports",
  nutrition: "Nutrition",
  communications: "Communications",
  manualVideo: "Manual video review",
};
const PLAN_LABEL: Record<string, string> = {
  reports: "Reviewed player reports",
  nutrition: "Nutrition guidance",
  communications: "Messages to families",
  manualVideo: "Manual video review",
};

export function SettingsView(
  p: WorkspaceProps & {
    branch: (id?: string) => void;
    batch: (id?: string) => void;
    member: (id?: string) => void;
    resetPassword: (id: string) => void;
    assignPlayers: (id: string) => void;
  },
) {
  const d = p.data;
  // The first-run checklist opens Settings on the group that holds the step (`group:Sessions`, `group:Team`).
  const requested = p.focusId?.startsWith("group:") ? p.focusId.slice(6).split("|")[0] : "";
  const [group, setGroup] = useState<Group>(GROUPS.find((g) => g === requested) ?? "Academy");
  const [sub, setSub] = useState<Partial<Record<Group, string>>>(requested === "Team" ? { Team: "Invitations" } : {});
  // The sidebar's "Batches" group opens this pane (`group:Sessions|branch|<time>`) and, for the two "Create" entries, the form.
  const asked = /^group:Sessions\|(branch|batch)\|/.exec(p.focusId ?? "")?.[1];
  useEffect(() => {
    if (!p.focusId?.startsWith("group:Sessions|")) return;
    setGroup("Sessions");
    if (!d.permissions.ops) return;
    if (asked === "branch") p.branch();
    else if (asked === "batch") p.batch();
    // Run once per click: the time in the hint makes every click a new value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focusId]);
  const [name, setName] = useState(d.academy.name);
  const [city, setCity] = useState(d.settings.data.city ?? "");
  const [contactEmail, setContactEmail] = useState(d.settings.data.contactEmail ?? "");
  const [about, setAbout] = useState(d.settings.data.about ?? "");
  const [country, setCountry] = useState(d.settings.data.country);
  const [currency, setCurrency] = useState(d.settings.data.currency);
  const [timezone, setTimezone] = useState(d.academy.timezone);
  const [colour, setColour] = useState(d.settings.data.colour);
  const [policy, setPolicy] = useState(d.settings.data.policy);
  const [retentionDays, setRetention] = useState(d.settings.data.retentionDays);
  const [features, setFeatures] = useState(d.settings.data.features);
  // undefined = keep the saved logo, null = remove it, a string = a new PNG chosen but not saved yet.
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [logoError, setLogoError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  // RC-5: each control is shown for the capability its server endpoint checks (a convenience only; the server decides).
  const allowed = can(d.actor, "academy.settings");
  const may = {
    consent: can(d.actor, "consent.admin"),
    mfa: can(d.actor, "security.mfa.view"),
    securityLog: can(d.actor, "logs.security"),
    accessLog: can(d.actor, "logs.access"),
    privacy: can(d.actor, "privacy.manage"),
    members: can(d.actor, "members.manage"),
    reset: can(d.actor, "members.resetCredentials"),
    assignNutrition: can(d.actor, "nutrition.assign"),
  };
  const subtabs: Record<Group, string[]> = {
    Academy: [],
    Team: ["Roles & permissions", ...(may.members ? ["Invitations"] : [])],
    Sessions: [],
    "Privacy & policies": ["Policies", ...(may.consent ? ["Consent documents"] : []), ...(may.privacy ? ["Privacy and erasure"] : [])],
    "Security & audit": [
      ...(may.mfa ? ["Two-factor policy"] : []),
      ...(may.securityLog ? ["Security events"] : []),
      ...(may.accessLog ? ["Access history"] : []),
      "Audit history",
    ],
    Integrations: [],
  };
  const current = sub[group] && subtabs[group].includes(sub[group]!) ? sub[group]! : subtabs[group][0];
  const savedLogo = d.settings.data.hasLogo ? `/api/academy/logo?v=${d.settings.version}` : null;
  const logoSrc = logo === undefined ? savedLogo : logo;
  // The save button belongs to the screens whose fields it saves.
  const savesHere = group === "Academy" || (group === "Privacy & policies" && current === "Policies");

  async function save() {
    const saved = await p.mutate("/settings/save", {
      version: d.settings.version,
      name,
      city,
      contactEmail,
      about,
      country,
      currency,
      timezone,
      colour,
      policy,
      retentionDays,
      features,
      ...(logo !== undefined ? { logoData: logo } : {}),
    });
    if (saved) setLogo(undefined);
  }
  async function chooseLogo(chosen?: File) {
    if (!chosen) return;
    setLogoError("");
    // The server checks the picture again; this only spares a round trip for the obvious mistakes.
    if (chosen.type !== "image/png" || chosen.size > LOGO_MAX_BYTES) {
      setLogoError("Choose a PNG logo under 200 KB. JPG is not supported.");
      return;
    }
    try {
      const value = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("The logo could not be read."));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(chosen);
      });
      setLogo(value);
    } catch (e) {
      setLogoError((e as Error).message);
    }
    if (file.current) file.current.value = "";
  }
  const logoMark = (large = false) => (
    <span className={`set-logo${large ? " large" : ""}`}>
      {logoSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoSrc} alt="Academy logo" />
      ) : (
        <span aria-hidden="true">{initials(name || d.academy.name)}</span>
      )}
    </span>
  );

  return (
    <div className="reference-view">
      <Toolbar>
        <Tabs items={[...GROUPS]} value={group} onChange={(g) => setGroup(g as Group)} />
        {allowed && savesHere && (
          <button className="primary" disabled={p.busy} onClick={save}>
            Save academy settings
          </button>
        )}
      </Toolbar>
      {subtabs[group].length > 1 && (
        <div className="set-subtabs">
          <Tabs items={subtabs[group]} value={current} onChange={(s) => setSub({ ...sub, [group]: s })} />
        </div>
      )}

      {group === "Academy" && (
        <div className="set-grid">
          <div className="set-col">
            <Pane title="Academy profile">
              <div className="set-profile">
                {logoMark()}
                <fieldset disabled={!allowed || p.busy}>
                  <label>
                    Academy name
                    <input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} />
                  </label>
                  <label>
                    Location
                    <input
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      maxLength={80}
                      placeholder="City the academy is in"
                    />
                  </label>
                  <label>
                    Contact email
                    <input
                      type="email"
                      value={contactEmail}
                      onChange={(e) => setContactEmail(e.target.value)}
                      maxLength={254}
                      placeholder="academy@example.com"
                    />
                  </label>
                </fieldset>
              </div>
              <fieldset disabled={!allowed || p.busy}>
                <label>
                  About academy
                  <textarea
                    value={about}
                    onChange={(e) => setAbout(e.target.value)}
                    maxLength={250}
                    rows={4}
                    placeholder="A short description families and coaches will recognise."
                  />
                </label>
                <small className="set-counter">{about.length}/250</small>
              </fieldset>
            </Pane>
            <Pane title="Regional settings">
              <fieldset disabled={!allowed || p.busy}>
                <label>
                  Country defaults
                  <select
                    aria-label="Country defaults"
                    value={country}
                    onChange={(e) => {
                      const us = e.target.value === "US";
                      setCountry(us ? "US" : "IN");
                      setCurrency(us ? "USD" : "INR");
                      setTimezone(us ? "America/New_York" : "Asia/Kolkata");
                    }}
                  >
                    <option value="IN">India</option>
                    <option value="US">United States</option>
                  </select>
                </label>
                <label>
                  Currency
                  <select
                    aria-label="Currency"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value as "INR" | "USD")}
                  >
                    <option>INR</option>
                    <option>USD</option>
                  </select>
                </label>
                <label>
                  Academy timezone
                  <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                </label>
              </fieldset>
              <ContextNote>
                Country presets initialise defaults. Stored session instants and timezone snapshots are preserved.
              </ContextNote>
            </Pane>
            <Pane title="Module preferences">
              <fieldset disabled={!allowed || p.busy}>
                {Object.entries(features).map(([key, on]) => (
                  <div className="wb-setting-row" key={key}>
                    <label className="wb-check">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!d.entitlements[key] && !on}
                        onChange={(e) => setFeatures({ ...features, [key]: e.target.checked })}
                      />
                      {MODULE_LABEL[key] ?? key}
                    </label>
                    <Status value={d.entitlements[key] ? "ENTITLED" : "LOCKED"} />
                  </div>
                ))}
              </fieldset>
              <div className="wb-inset">
                <h3>AI Analysis</h3>
                <Status value="COMING_SOON" />
                <p>Automated analysis is not available.</p>
              </div>
              <ContextNote>Preferences cannot unlock subscription capabilities.</ContextNote>
            </Pane>
          </div>
          <div className="set-col">
            <Pane title="Academy logo">
              <p className="set-note">PNG under 200 KB; JPG unavailable. Recommended: 512 × 512 px.</p>
              <div className="set-logo-row">
                {logoMark(true)}
                {allowed && (
                  <div className="set-logo-actions">
                    <input
                      ref={file}
                      type="file"
                      accept="image/png"
                      className="sr-only"
                      tabIndex={-1}
                      aria-label="Choose academy PNG logo"
                      onChange={(e) => void chooseLogo(e.target.files?.[0])}
                    />
                    <button type="button" className="secondary" disabled={p.busy} onClick={() => file.current?.click()}>
                      <ImagePlus size={16} aria-hidden="true" />
                      Change logo
                    </button>
                    <button
                      type="button"
                      className="secondary danger"
                      disabled={p.busy || !logoSrc}
                      onClick={() => {
                        setLogoError("");
                        setLogo(null);
                      }}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                      Remove
                    </button>
                  </div>
                )}
              </div>
              {logoError && (
                <p role="alert" className="set-error">
                  {logoError}
                </p>
              )}
              {logo !== undefined && (
                <p role="status" className="set-note">
                  {logo === null ? "The logo will be removed" : "New logo chosen"}. Choose <strong>Save academy settings</strong> to apply it.
                </p>
              )}
              {!allowed && <p className="set-note">Only the academy owner or an administrator can change the logo.</p>}
            </Pane>
            <Pane title="Brand accent">
              <fieldset disabled={!allowed || p.busy}>
                <label>
                  Brand accent
                  <input type="color" value={colour} onChange={(e) => setColour(e.target.value)} />
                </label>
              </fieldset>
            </Pane>
            <Pane title="Academy plan" action={<span className="set-badge">Local pilot</span>}>
              <p className="set-note">Sportozen subscription · active. Billing is not connected in this pilot.</p>
              {Object.entries(d.entitlements).map(([key, on]) => (
                <div className="wb-setting-row" key={key}>
                  <strong>{PLAN_LABEL[key] ?? key}</strong>
                  <Status value={on ? "ENTITLED" : "LOCKED"} />
                </div>
              ))}
              <button type="button" className="secondary" onClick={() => setGroup("Integrations")}>
                See subscription details
              </button>
            </Pane>
          </div>
        </div>
      )}

      {group === "Team" && current === "Roles & permissions" && (
        <>
          <Pane title="Roles & access">
            <table className="wb-permission-table">
              <thead>
                <tr>
                  <th>Academy role</th>
                  <th>Active logins</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(
                  d.members
                    .filter((m) => m.active)
                    .reduce(
                      (counts, m) => ({ ...counts, [m.role]: (counts[m.role] ?? 0) + 1 }),
                      {} as Record<string, number>,
                    ),
                ).map(([role, count]) => (
                  <tr key={role}>
                    <td>{displayLabel(role)}</td>
                    <td>{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>Role permissions are enforced by the server. Only the academy owner can provision logins and change access.</p>
          </Pane>
          <Pane
            title="Staff & family access"
            action={
              may.members && (
                <button className="primary" onClick={() => p.member()}>
                  Create login
                </button>
              )
            }
          >
            <GridTable
              rows={d.members}
              columns={[
                {
                  label: "Person",
                  render: (m) => (
                    <>
                      <strong>{m.name}</strong>
                      <small>{m.email}</small>
                    </>
                  ),
                },
                { label: "Role", render: (m) => <span title={m.role}>{accountLabel(m.role)}</span> },
                { label: "Access", render: (m) => <Status value={m.active ? "ACTIVE" : "REVOKED"} /> },
              ]}
              actions={(m) =>
                (may.members || may.assignNutrition) && (
                  <>
                    {may.members && <Action onClick={() => p.member(m.id)}>Manage access</Action>}
                    {/* Target data, not authority: only a Nutrition Pro member can be assigned players. */}
                    {may.assignNutrition && m.role === "NUTRITION_PRO" && (
                      <Action onClick={() => p.assignPlayers(m.id)}>Assign players</Action>
                    )}
                    {/* A convenience only: the server decides who may be reset. */}
                    {may.reset && m.role !== "OWNER" && m.id !== d.actor.id && (
                      <Action onClick={() => p.resetPassword(m.id)}>Reset password</Action>
                    )}
                  </>
                )
              }
            />
          </Pane>
        </>
      )}
      {group === "Team" && current === "Invitations" && may.members && (
        <Pane title="Invitations to join this academy">
          <InvitationsPanel
            players={d.players.map((x) => ({ id: x.id, name: x.name }))}
            academy={{ name: d.academy.name, country: d.settings.data.country }}
          />
        </Pane>
      )}

      {group === "Sessions" && (
        <Pane title="Branches & batches">
          <div className="button-row">
            {d.permissions.ops && (
              <>
                <button className="primary" onClick={() => p.branch()}>
                  Create branch
                </button>
                <button className="secondary" onClick={() => p.batch()}>
                  Create batch
                </button>
              </>
            )}
          </div>
          <GridTable
            rows={d.branches}
            columns={[{ label: "Branch", render: (b) => b.name }]}
            actions={(b) => d.permissions.ops && <Action onClick={() => p.branch(b.id)}>Edit branch</Action>}
          />
          <GridTable
            rows={d.batches}
            columns={[
              { label: "Batch", render: (b) => b.name },
              { label: "Coach", render: (b) => d.members.find((m) => m.id === b.coachId)?.name },
            ]}
            actions={(b) => d.permissions.ops && <Action onClick={() => p.batch(b.id)}>Edit assignment</Action>}
          />
        </Pane>
      )}

      {group === "Privacy & policies" && current === "Policies" && (
        <Pane title="Academy policies">
          <fieldset disabled={!allowed || p.busy}>
            <label>
              Policy text
              <textarea value={policy} onChange={(e) => setPolicy(e.target.value)} maxLength={4000} rows={6} />
            </label>
            <label>
              Private media retention days
              <input
                type="number"
                min={30}
                max={3650}
                value={retentionDays}
                onChange={(e) => setRetention(Number(e.target.value))}
              />
            </label>
          </fieldset>
        </Pane>
      )}
      {group === "Privacy & policies" && current === "Consent documents" && may.consent && (
        <Pane title="Consent documents and renewals">
          <ConsentPoliciesPanel />
        </Pane>
      )}
      {group === "Privacy & policies" && current === "Privacy and erasure" && may.privacy && (
        <Pane title="Retention, erasure and legal holds">
          <PrivacyPanel
            players={d.players.map((x) => ({ id: x.id, name: x.name }))}
            me={d.actor.id}
            canSetRetention={can(d.actor, "privacy.retention")}
            canReleaseHold={can(d.actor, "privacy.releaseHold")}
          />
        </Pane>
      )}

      {group === "Security & audit" && current === "Two-factor policy" && may.mfa && (
        <Pane title="Two-factor authentication policy">
          <MfaPolicyPanel />
        </Pane>
      )}
      {group === "Security & audit" && current === "Security events" && may.securityLog && (
        <Pane title="Security events">
          <SecurityEventsPanel people={d.members.map((m) => ({ id: m.id, name: m.name }))} />
        </Pane>
      )}
      {group === "Security & audit" && current === "Access history" && may.accessLog && (
        <Pane title="Access history">
          <AccessLogPanel people={d.members.map((m) => ({ id: m.id, name: m.name }))} />
        </Pane>
      )}
      {group === "Security & audit" && current === "Audit history" && (
        <Pane title="Audit history">
          <GridTable
            rows={d.audits}
            columns={[
              { label: "Change", render: (a) => a.action },
              { label: "Record", render: (a) => a.entityId },
              { label: "Revision", render: (a) => a.version },
              { label: "Recorded", render: (a) => a.createdAt },
            ]}
          />
        </Pane>
      )}

      {group === "Integrations" && (
        <div className="set-grid">
          <div className="set-col">
            <Pane title="Integrations">
              {[
                ["Email", "Free. You send it from your own mail app with one button, or invite people by email link."],
                ["WhatsApp", "Free. You send it from your own WhatsApp with one button (wa.me link). No Meta business account is needed."],
              ].map(([channel, note]) => (
                <div className="wb-integration" key={channel}>
                  <h3>{channel}</h3>
                  <Status value="MANUAL" />
                  <p>{note}</p>
                </div>
              ))}
              <div className="wb-integration">
                <h3>Subscription checkout</h3>
                <Status value="NOT_CONFIGURED" />
                <p>No external checkout is connected.</p>
              </div>
            </Pane>
          </div>
          <div className="set-col">
            <Pane title="Sportozen subscription">
              <ContextNote>
                Sportozen billing is separate from academy fees. No subscription checkout is connected.
              </ContextNote>
              {Object.entries(d.entitlements).map(([key, on]) => (
                <div className="wb-setting-row" key={key}>
                  <strong>{PLAN_LABEL[key] ?? key}</strong>
                  <Status value={on ? "ENTITLED" : "LOCKED"} />
                </div>
              ))}
            </Pane>
          </div>
        </div>
      )}
    </div>
  );
}
