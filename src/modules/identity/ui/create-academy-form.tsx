"use client";

import { useMemo, useState } from "react";
import { AlertCircle, ArrowRight, Loader2, Plus } from "lucide-react";
import { redirectIfGated } from "./gate";
import { rememberInvite } from "../../invitations/ui/pending-invite";

const COUNTRIES = {
  IN: { name: "India", currency: "INR", timezone: "Asia/Kolkata" },
  US: { name: "United States", currency: "USD", timezone: "America/New_York" },
} as const;
type Country = keyof typeof COUNTRIES;
const CURRENCIES = [
  { code: "INR", label: "INR · Indian rupee" },
  { code: "USD", label: "USD · US dollar" },
] as const;

/** Every time zone the browser knows (shown only under "More settings"). */
function zoneList() {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/**
 * Start an academy of one's own. The person becomes its owner and the academy opens straight away; owners then add
 * coaches, families and players with an invitation link or by hand. The server decides everything that matters (the
 * role is always OWNER, every value is checked again there); this form only collects what the academy needs to begin.
 */
export function CreateAcademyForm({ hydrated }: { hydrated: boolean }) {
  const [name, setName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [country, setCountry] = useState<Country>("IN");
  const [city, setCity] = useState("");
  const [currency, setCurrency] = useState<string>("INR");
  const [timezone, setTimezone] = useState(""); // "" = the country's usual time zone
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const zones = useMemo(zoneList, []);

  function pickCountry(next: Country) {
    setCountry(next);
    setCurrency(COUNTRIES[next].currency);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const cleanName = name.replace(/\s+/g, " ").trim();
    const cleanCity = city.replace(/\s+/g, " ").trim();
    const email = contactEmail.trim();
    if (cleanName.length < 2) return setError("Enter the academy name (at least 2 characters).");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError("Enter a valid contact email address for the academy.");
    if (cleanCity.length < 2) return setError("Enter the city the academy is in.");
    setBusy(true);
    try {
      const response = await fetch("/api/auth/account/create-academy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: cleanName,
          contactEmail: email,
          country,
          city: cleanCity,
          currency,
          ...(timezone ? { timezone } : {}),
        }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok) {
        // The academy exists and is chosen for this session. Opening the workspace for the first time can take a moment.
        setOpening(true);
        window.location.assign("/");
        return;
      }
      if (redirectIfGated(response.status, body)) return;
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      setError(body?.message ?? "The academy could not be created. Please try again.");
    } catch {
      setError("The server is unavailable. Please try again.");
    }
    setBusy(false);
  }

  return (
    <form className="auth-form" method="post" onSubmit={submit} noValidate aria-label="Create your academy">
      <div className="auth-field">
        <label className="auth-label" htmlFor="academy-name">
          Academy name
        </label>
        <input
          id="academy-name"
          name="name"
          className="auth-input"
          autoComplete="organization"
          placeholder="For example: Riverside Badminton Academy"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="auth-field">
        <label className="auth-label" htmlFor="academy-email">
          Academy contact email
        </label>
        <input
          id="academy-email"
          name="contactEmail"
          type="email"
          className="auth-input"
          autoComplete="email"
          placeholder="academy@example.com"
          maxLength={254}
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
        />
      </div>
      <div className="auth-field">
        <label className="auth-label" htmlFor="academy-country">
          Country
        </label>
        <select
          id="academy-country"
          name="country"
          className="auth-input"
          value={country}
          onChange={(e) => pickCountry(e.target.value as Country)}
        >
          {(Object.keys(COUNTRIES) as Country[]).map((code) => (
            <option key={code} value={code}>
              {COUNTRIES[code].name}
            </option>
          ))}
        </select>
      </div>
      <div className="auth-field">
        <label className="auth-label" htmlFor="academy-city">
          City
        </label>
        <input
          id="academy-city"
          name="city"
          className="auth-input"
          autoComplete="address-level2"
          maxLength={80}
          value={city}
          onChange={(e) => setCity(e.target.value)}
        />
      </div>
      <div className="auth-field">
        <label className="auth-label" htmlFor="academy-currency">
          Currency
        </label>
        <select
          id="academy-currency"
          name="currency"
          className="auth-input"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
        >
          {CURRENCIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
        <p className="auth-field-hint">
          The country sets the starting currency, time zone and date format. Fees and invoices are in the currency you choose.
        </p>
      </div>
      <details className="auth-more">
        <summary>More settings (optional)</summary>
        <div className="auth-field">
          <label className="auth-label" htmlFor="academy-timezone">
            Time zone
          </label>
          <select
            id="academy-timezone"
            name="timezone"
            className="auth-input"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            <option value="">{`Usual for ${COUNTRIES[country].name} (${COUNTRIES[country].timezone})`}</option>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
          <p className="auth-field-hint">Session times and the calendar use this time zone.</p>
        </div>
      </details>
      <p className="auth-field-hint">
        Your academy opens as soon as you create it. You can change these details later in Settings. New academies start empty.
      </p>
      {error && (
        <p role="alert" className="auth-banner auth-banner-error">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
      {opening && (
        <p role="status" className="auth-banner auth-banner-info">
          <Loader2 size={16} className="auth-spin" aria-hidden="true" />
          <span>Academy created. Opening your workspace…</span>
        </p>
      )}
      <button type="submit" className="primary auth-primary-btn" disabled={busy || !hydrated}>
        {busy ? <Loader2 size={16} className="auth-spin" aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
        <span>{opening ? "Opening…" : busy ? "Creating…" : "Create empty academy"}</span>
      </button>
    </form>
  );
}

/** The 43-character token an invitation link carries after the "#" (a pasted link, or the code on its own). */
export function inviteTokenFrom(text: string) {
  const match = text.trim().match(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/);
  return match ? match[0] : null;
}

/**
 * Accept an invitation by pasting the link (or just its code). The token is kept for this tab only and the invitation
 * page takes over: sign in with the invited account and accept there. Nothing is granted by pasting.
 */
export function AcceptInvitationForm({ hydrated }: { hydrated: boolean }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = inviteTokenFrom(value);
    if (!token) {
      setError("That does not look like an invitation link or code. Paste the whole link you were sent.");
      return;
    }
    rememberInvite(token);
    window.location.assign("/invite");
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate aria-label="Accept a private invitation">
      <h3 className="auth-subheading">Accept a private invitation</h3>
      <p className="auth-field-hint">
        Sign in with the invited account. Invitations do not automatically merge children or records between academies.
      </p>
      <div className="auth-field">
        <label className="auth-label" htmlFor="invite-link">
          Invitation link or code
        </label>
        <input
          id="invite-link"
          name="invite"
          className="auth-input"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError("");
          }}
        />
      </div>
      {error && (
        <p role="alert" className="auth-banner auth-banner-error">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
      <button type="submit" className="primary auth-primary-btn" disabled={!hydrated}>
        <ArrowRight size={16} aria-hidden="true" />
        <span>Accept academy invitation</span>
      </button>
    </form>
  );
}
