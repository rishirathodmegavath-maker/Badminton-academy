/**
 * The browser-test PROFILES: which specs run against which kind of disposable server.
 *
 * Why profiles exist: a few specs need a server that is configured differently from the standard production build. The
 * delivery test adapters and the test email provider refuse to run in production; Google sign-in needs (fake) credentials; the
 * multi-academy spec needs an owner who also belongs to a second academy, which would send every other spec's owner to the
 * academy chooser. Run together on one server, those specs either failed or silently skipped. Each profile below declares what
 * its server is, which fixtures it needs and which specs run, and `scripts/e2e-ci.ts` builds exactly that, for each profile
 * separately, on its own freshly created database.
 *
 * Rules the tests in tests/e2e-profiles.test.ts enforce: every spec file belongs to exactly one profile (a new spec that is not
 * listed here fails the build instead of being left out), and no profile can turn on a test-only capability in production mode.
 *
 * This file is pure data and checks. It reads no environment and touches no file or database.
 */
export type ProfileName = "standard" | "dispatch" | "multi-academy" | "google" | "email";
export type FixtureName = "owner-at-bluebird";

export type BrowserProfile = {
  name: ProfileName;
  description: string;
  /** "production": `next start` on the built app. "development": `next dev`, for what refuses production. */
  mode: "production" | "development";
  /** Google off ("plain") or on with obviously fake credentials ("fake-google"). */
  google: "plain" | "fake-google";
  /** The dispatch test adapters (reports to families are recorded in a file instead of sent). Development only. */
  deliveryTest: boolean;
  /** The test authentication-email provider (messages captured to a file instead of sent). Development only. */
  emailTest: boolean;
  /** Data this profile's specs need beyond the seeds. Applied before the specs and removed after, whatever happens. */
  fixtures: FixtureName[];
  /** Environment the specs themselves must be given (the runner provides it; a spec never silently skips when it is missing). */
  specEnvironment: string[];
  /** The port of this profile's server. Never 3100 (development), 3200 or 3300 (the owner's running servers). */
  port: number;
  /** Spec files, relative to the project root. */
  specs: string[];
};

const spec = (name: string) => `tests/e2e/${name}.spec.ts`;

export const FORBIDDEN_PORTS = [3100, 3200, 3300] as const;

export const PROFILES: readonly BrowserProfile[] = [
  {
    name: "standard",
    description: "Production build, plain configuration (no Google, no mail provider, no delivery adapters).",
    mode: "production",
    google: "plain",
    deliveryTest: false,
    emailTest: false,
    fixtures: [],
    specEnvironment: ["E2E_BASE_URL", "BETTER_AUTH_URL", "DEV_SEED_PASSWORD", "E2E_SEED_PASSWORD", "E2E_DISPOSABLE"],
    port: 3410,
    specs: [
      "access-history",
      "auth-no-email",
      "auth-ui",
      "batch-reports",
      "calendar-series",
      "coach-handover",
      "invitations",
      "monthly-report",
      "owner-step-up",
      "payment-attempts",
      "phase9-a11y",
      "phase9-auth",
      "phase9-family",
      "phase9-navigation",
      "phase9-responsive",
      "privacy",
      "redesign",
      "training-draft",
      "training",
      "ux-wave1",
      "ux-wave24",
    ].map(spec),
  },
  {
    name: "dispatch",
    description: "Development-mode server with the delivery test adapters: reports to families are recorded, nothing is sent.",
    mode: "development",
    google: "plain",
    deliveryTest: true,
    emailTest: false,
    fixtures: [],
    specEnvironment: ["E2E_BASE_URL", "BETTER_AUTH_URL", "DEV_SEED_PASSWORD", "E2E_DISPOSABLE", "DISPATCH_TEST_OUTBOX_FILE"],
    port: 3411,
    specs: [spec("dispatch-reports")],
  },
  {
    name: "multi-academy",
    description: "Production build; the seeded owner of Greenfield also holds a head-coach membership at Bluebird.",
    mode: "production",
    google: "plain",
    deliveryTest: false,
    emailTest: false,
    fixtures: ["owner-at-bluebird"],
    specEnvironment: ["E2E_BASE_URL", "BETTER_AUTH_URL", "E2E_SEED_PASSWORD", "E2E_DISPOSABLE"],
    port: 3412,
    specs: [spec("multi-academy")],
  },
  {
    name: "google",
    description: "Production build with obviously fake Google credentials; nothing talks to Google (the redirect is intercepted).",
    mode: "production",
    google: "fake-google",
    deliveryTest: false,
    emailTest: false,
    fixtures: [],
    specEnvironment: ["E2E_BASE_URL", "BETTER_AUTH_URL", "E2E_DISPOSABLE"],
    port: 3413,
    specs: [spec("auth-google-initiation")],
  },
  {
    name: "email",
    description: "Development-mode server with the test authentication-email provider: codes and reset links are captured, nothing is sent.",
    mode: "development",
    google: "plain",
    deliveryTest: false,
    emailTest: true,
    fixtures: [],
    specEnvironment: ["E2E_BASE_URL", "BETTER_AUTH_URL", "DEV_SEED_PASSWORD", "E2E_DISPOSABLE", "AUTH_EMAIL_CAPTURE_FILE", "E2E_DATABASE_URL"],
    port: 3414,
    specs: [spec("auth-email-flows")],
  },
];

export function profileByName(name: string): BrowserProfile {
  const found = PROFILES.find((p) => p.name === name);
  if (!found) throw new Error(`Unknown browser profile "${name}". Known: ${PROFILES.map((p) => p.name).join(", ")}.`);
  return found;
}

/** Problems with the manifest itself (empty when it is sound). Pure; tested. */
export function manifestProblems(profiles: readonly BrowserProfile[] = PROFILES): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const ports = new Set<number>();
  const specs = new Map<string, string>();
  for (const p of profiles) {
    if (names.has(p.name)) problems.push(`Profile ${p.name} is declared twice.`);
    names.add(p.name);
    if (!Number.isInteger(p.port) || p.port < 1024 || p.port > 65535) problems.push(`${p.name}: port ${p.port} is not an unprivileged port.`);
    if ((FORBIDDEN_PORTS as readonly number[]).includes(p.port)) problems.push(`${p.name}: port ${p.port} belongs to a server that must not be touched.`);
    if (ports.has(p.port)) problems.push(`${p.name}: port ${p.port} is used by another profile.`);
    ports.add(p.port);
    if ((p.deliveryTest || p.emailTest) && p.mode !== "development")
      problems.push(`${p.name}: the delivery test adapters and the test email provider are for development mode only.`);
    if ((p.deliveryTest || p.emailTest) && p.google !== "plain")
      problems.push(`${p.name}: a test-delivery profile does not also carry (fake) Google credentials.`);
    if (!p.specs.length) problems.push(`${p.name}: no specs.`);
    for (const s of p.specs) {
      const owner = specs.get(s);
      if (owner) problems.push(`${s} is listed in both ${owner} and ${p.name}.`);
      specs.set(s, p.name);
    }
    if (p.emailTest && !p.specEnvironment.includes("AUTH_EMAIL_CAPTURE_FILE")) problems.push(`${p.name}: the specs must be given the capture file.`);
    if (p.deliveryTest && !p.specEnvironment.includes("DISPATCH_TEST_OUTBOX_FILE")) problems.push(`${p.name}: the specs must be given the outbox file.`);
  }
  return problems;
}

/**
 * Which of the profile's required spec environment variables are missing from `env`. A missing one is an ERROR for the runner and
 * for the Playwright configuration, never a reason to skip.
 */
export function missingSpecEnvironment(profile: BrowserProfile, env: Readonly<Record<string, string | undefined>>): string[] {
  return profile.specEnvironment.filter((name) => !(env[name] ?? "").trim());
}
