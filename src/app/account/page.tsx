"use client";
import { useCallback, useEffect, useState } from "react";
import qrcode from "qrcode-generator";
import {
  GOOGLE_REFUSAL_MESSAGES,
  refusalFrom,
} from "@/modules/identity/google-messages";
import "./account.css";
/**
 * Account security: change password, set up or manage the authenticator app, review sessions.
 * Everything here calls Better Auth's endpoints (and the account-security plugin on top of them);
 * the browser never stores a secret, token or recovery code. Authorization is decided by the
 * server - this page only makes the available steps easy.
 */
type SecurityState = {
  gate: string | null;
  message: string | null;
  passwordChangeRequired: boolean;
  temporaryPasswordExpiresAt: string | null;
  twoFactorEnabled: boolean;
  mfa: {
    mode: string;
    level: "optional" | "warn" | "required";
    required: boolean;
    enrolmentRequired: boolean;
  };
};
type SessionRow = {
  id: string;
  createdAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
};
type Setup = { uri: string; secret: string; codes: string[] };
type Methods = {
  google: {
    enabled: boolean;
    linked: boolean | null;
    authenticator: boolean | null;
  };
};
async function call(path: string, body?: unknown) {
  const response = await fetch(`/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, json };
}
const failure = (json: { message?: string } | null, fallback: string) =>
  json?.message ?? fallback;
function qrSvg(uri: string) {
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}
export default function Account() {
  const [state, setState] = useState<SecurityState | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [methods, setMethods] = useState<Methods | null>(null);
  const load = useCallback(async () => {
    const current = await call("/account/security-state");
    if (current.status === 401) {
      window.location.assign("/login");
      return;
    }
    setState(current.json);
    const found = await call("/account/sign-in-methods");
    setMethods(found.ok ? found.json : null);
    // Sessions are not available while setup is pending; that is expected.
    const list = await call("/list-sessions");
    setSessions(list.ok ? list.json : []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    // Returning from Google: ?google=linked on success, ?error=<code> when it was refused.
    const params = new URLSearchParams(window.location.search);
    const code = params.get("error");
    if (code) setError(GOOGLE_REFUSAL_MESSAGES[refusalFrom(code)]);
    else if (params.get("google") === "linked")
      setMessage("Google is linked. You can now use Continue with Google on the sign-in page.");
    if (code || params.get("google"))
      window.history.replaceState(null, "", window.location.pathname);
  }, []);
  function linkGoogle() {
    void act(
      () =>
        call("/link-social", {
          provider: "google",
          callbackURL: "/account?google=linked",
          errorCallbackURL: "/account",
        }),
      "Opening Google…",
      (json: { url?: string }) => {
        if (json?.url) window.location.assign(json.url);
      },
    );
  }
  function unlinkGoogle() {
    void act(
      () => call("/account/unlink-google", {}),
      "Google is unlinked. Sign in with your email and password.",
    );
  }
  async function act(
    run: () => Promise<{ ok: boolean; json: { message?: string } | null }>,
    done: string,
    onOk?: (json: never) => void | Promise<void>,
  ) {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const result = await run();
      if (!result.ok) {
        setError(failure(result.json, "That was not accepted."));
        return false;
      }
      await onOk?.(result.json as never);
      setMessage(done);
      await load();
      return true;
    } catch {
      setError("The server is unavailable. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  function changePassword(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const v = new FormData(form);
    if (v.get("newPassword") !== v.get("confirm")) {
      setError("The new password and its confirmation do not match.");
      return;
    }
    void act(
      () =>
        call("/account/change-password", {
          currentPassword: v.get("currentPassword"),
          newPassword: v.get("newPassword"),
        }),
      "Password changed. Your other devices were signed out.",
      () => form.reset(),
    ).then((ok) => {
      if (
        ok &&
        state?.gate === "PASSWORD_CHANGE_REQUIRED" &&
        !state.mfa.enrolmentRequired
      )
        window.location.assign("/");
    });
  }
  function startSetup(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = new FormData(event.currentTarget);
    void act(
      () => call("/two-factor/enable", { password: v.get("password") }),
      "Scan the code with your authenticator app, then enter the 6-digit code to finish.",
      (json: { totpURI: string; backupCodes: string[] }) =>
        setSetup({
          uri: json.totpURI,
          secret: new URL(json.totpURI).searchParams.get("secret") ?? "",
          codes: json.backupCodes,
        }),
    );
  }
  function confirmSetup(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = new FormData(event.currentTarget);
    void act(
      () =>
        call("/two-factor/verify-totp", { code: String(v.get("code")).trim() }),
      "Two-factor authentication is on. Your other devices were signed out.",
      () => setSetup(null),
    ).then((ok) => {
      if (ok && state?.mfa.enrolmentRequired && !state.passwordChangeRequired)
        window.location.assign("/");
    });
  }
  function regenerate(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = new FormData(event.currentTarget);
    void act(
      () =>
        call("/two-factor/generate-backup-codes", {
          password: v.get("password"),
        }),
      "New recovery codes created. The old ones no longer work.",
      (json: { backupCodes: string[] }) => {
        setCodes(json.backupCodes);
        setSaved(false);
      },
    );
  }
  function turnOff(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = new FormData(event.currentTarget);
    void act(
      () => call("/two-factor/disable", { password: v.get("password") }),
      "Two-factor authentication is off. Your other devices were signed out.",
    );
  }
  async function signOut() {
    await call("/sign-out", {});
    window.location.assign("/login");
  }
  if (!state)
    return (
      <main className="account-page">
        <p role="status">Loading…</p>
      </main>
    );
  const locked = state.gate === "TEMPORARY_PASSWORD_EXPIRED";
  return (
    <main className="account-page">
      <header>
        <div>
          {!state.gate && (
            <a className="back-link" href="/">
              ← Back to workspace
            </a>
          )}
          <h1>Account security</h1>
        </div>
        <button className="secondary" onClick={signOut}>
          Sign out
        </button>
      </header>
      {state.gate && (
        <div className="notice" role="status">
          {state.message}
        </div>
      )}
      {state.mfa.level === "warn" && !state.twoFactorEnabled && (
        <div className="notice" role="status">
          Your role will soon require two-factor authentication. Set it up
          below; until then your access is unchanged.
        </div>
      )}
      {state.mfa.level === "required" && !state.twoFactorEnabled && (
        <div className="notice" role="status">
          Your role requires two-factor authentication. Set it up below to
          continue.
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!locked && (
        <section className="panel">
          <h3>Change password</h3>
          <form onSubmit={changePassword}>
            <label>
              Current password
              <input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <label>
              New password
              <input
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
              />
            </label>
            <label>
              Confirm new password
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
              />
            </label>
            <small>
              At least 12 characters. A few unrelated words make a strong
              passphrase. Changing it signs you out everywhere else.
            </small>
            <button className="primary" disabled={busy}>
              Change password
            </button>
          </form>
        </section>
      )}
      {!locked && state.gate !== "PASSWORD_CHANGE_REQUIRED" && (
        <section className="panel">
          <h3>Two-factor authentication</h3>
          {setup ? (
            <>
              <p>
                1. Scan this code with an authenticator app (any TOTP app).
                Nothing leaves this device.
              </p>
              <div
                className="qr"
                role="img"
                aria-label="Authenticator setup QR code"
                dangerouslySetInnerHTML={{ __html: qrSvg(setup.uri) }}
              />
              <p>
                Cannot scan? Enter this key by hand: <code>{setup.secret}</code>
              </p>
              <p>
                2. Save these recovery codes somewhere safe. Each works once if
                you lose your device. They are shown only now.
              </p>
              <ul className="codes">
                {setup.codes.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
              <label className="check">
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                />
                I have saved my recovery codes
              </label>
              <form onSubmit={confirmSetup}>
                <label>
                  3. Enter the 6-digit code from the app
                  <input
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    required
                  />
                </label>
                <button className="primary" disabled={busy || !saved}>
                  Turn on
                </button>
              </form>
            </>
          ) : state.twoFactorEnabled ? (
            <>
              <p>On. Signing in asks for a code from your authenticator app.</p>
              {codes && (
                <>
                  <p>Your new recovery codes (shown only now):</p>
                  <ul className="codes">
                    {codes.map((c) => (
                      <li key={c}>
                        <code>{c}</code>
                      </li>
                    ))}
                  </ul>
                  <button className="secondary" onClick={() => setCodes(null)}>
                    I have saved them
                  </button>
                </>
              )}
              <form onSubmit={regenerate}>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </label>
                <button className="secondary" disabled={busy}>
                  Create new recovery codes
                </button>
              </form>
              {state.mfa.level === "required" ? (
                <p>
                  Your role requires two-factor authentication, so it cannot be
                  turned off here. If you lose your device and recovery codes,
                  ask an academy owner to reset it.
                </p>
              ) : (
                <form onSubmit={turnOff}>
                  <label>
                    Password
                    <input
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                    />
                  </label>
                  <button className="secondary" disabled={busy}>
                    Turn off two-factor authentication
                  </button>
                  {state.mfa.level === "warn" && (
                    <small>
                      Your role will soon require it; you would be asked to set
                      it up again.
                    </small>
                  )}
                </form>
              )}
            </>
          ) : (
            <form onSubmit={startSetup}>
              <p>
                {state.mfa.level === "required"
                  ? "Your role requires an authenticator app."
                  : state.mfa.level === "warn"
                    ? "Your role will soon require an authenticator app."
                    : "Optional: add a second step to sign-in with an authenticator app."}
              </p>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              <button className="primary" disabled={busy}>
                Set up authenticator app
              </button>
            </form>
          )}
        </section>
      )}
      {!locked && methods?.google.enabled && (
        <section className="panel" aria-labelledby="google-title">
          <h3 id="google-title">Sign in with Google</h3>
          {methods.google.linked ? (
            <>
              <p>
                Google is linked. You can use <strong>Continue with Google</strong> on the sign-in page.
              </p>
              <button className="secondary" onClick={unlinkGoogle} disabled={busy}>
                Unlink Google
              </button>
            </>
          ) : methods.google.authenticator ? (
            <p>
              Not available while two-factor authentication is on. Accounts with an authenticator app sign in with
              their password and code.
            </p>
          ) : (
            <>
              <p>
                Link your own Google account to sign in without typing your password. It must use the same email
                address as this account. Linking never gives anyone else access, and Google never creates an
                account.
              </p>
              <button className="secondary" onClick={linkGoogle} disabled={busy}>
                Link Google
              </button>
            </>
          )}
        </section>
      )}
      {!state.gate && (
        <section className="panel">
          <h3>Signed-in devices</h3>
          <ul className="sessions">
            {sessions.map((s) => (
              <li key={s.id}>
                <span>
                  {s.current ? "This device" : "Other device"} ·{" "}
                  {s.ipAddress ?? "unknown address"}
                  <small>
                    {s.userAgent ?? "unknown browser"} · since{" "}
                    {new Date(s.createdAt).toLocaleString()}
                  </small>
                </span>
                {!s.current && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      act(
                        () => call("/account/revoke-session", { id: s.id }),
                        "Device signed out.",
                      )
                    }
                  >
                    Sign out
                  </button>
                )}
              </li>
            ))}
          </ul>
          {sessions.length > 1 && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                act(
                  () => call("/revoke-other-sessions", {}),
                  "All other devices signed out.",
                )
              }
            >
              Sign out all other devices
            </button>
          )}
        </section>
      )}
    </main>
  );
}
