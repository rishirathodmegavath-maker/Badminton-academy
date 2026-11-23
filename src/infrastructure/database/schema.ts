import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  boolean,
  timestamp,
  integer,
  bigint,
  jsonb,
  primaryKey,
  unique,
  foreignKey,
  index,
  uniqueIndex,
  check,
  date,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  Drill,
  Goal,
  SessionData,
} from "../../modules/training/domain/types";
import type {
  ProfileData,
  EnquiryData,
  CalendarData,
  CalendarSeriesData,
  AcademySettings,
  InvoiceData,
  PaymentData,
  ReportData,
  NutritionData,
  TimestampNote,
  MessageData,
} from "../../modules/academy/domain/types";

export const user = pgTable("app_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  // Public self-service email/password signups set this true; owner-provisioned and legacy accounts stay false.
  emailVerificationRequired: boolean("email_verification_required")
    .notNull()
    .default(false),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  termsVersion: text("terms_version"),
  image: text("image"),
  // Maintained by Better Auth's two-factor plugin: true once an authenticator is verified.
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  // The person's own registered mobile number for WhatsApp, E.164 ("+919876543210"), or null. One per account, never
  // per guardian link; it is not verified (no OTP) and it is not an authentication factor. The CHECK keeps any other
  // spelling out of the table, so the sender never has to guess.
  phone: text("phone"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  check("app_user_phone_e164_check", sql`${t.phone} is null or ${t.phone} ~ '^[+][1-9][0-9]{7,14}$'`),
]);
export const session = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("auth_session_user_idx").on(t.userId),
    // 0017: lets auth_session_academy tie a selection to a session AND that session's own user (id is already unique,
    // so this adds no restriction; it is only the target of a composite foreign key).
    unique("auth_session_id_user_unique").on(t.id, t.userId),
  ],
);
export const account = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.providerId, t.accountId),
    index("auth_account_user_provider_idx").on(t.userId, t.providerId),
  ],
);
export const verification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("auth_verification_identifier_idx").on(t.identifier)],
);
export const rateLimit = pgTable("auth_rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});
// Better Auth two-factor plugin storage. The secret and recovery codes are encrypted by the plugin
// with a key derived from BETTER_AUTH_SECRET; plaintext is never stored.
export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // false while enrolment is pending (secret issued, first code not yet confirmed).
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count")
      .notNull()
      .default(0),
    lockedUntil: timestamp("locked_until"),
  },
  (t) => [unique("two_factor_user_unique").on(t.userId)],
);
// One row exists only while an account holds a temporary password that must be replaced. No row
// means a normal credential, so existing accounts are unaffected. Only metadata lives here: the
// password hash stays in auth_account.
export const temporaryCredential = pgTable(
  "temporary_credential",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    // Who issued it; null when issued by the operator recovery command.
    issuedBy: text("issued_by").references(() => user.id, {
      onDelete: "set null",
    }),
    source: text("source").notNull(),
    issuedAt: timestamp("issued_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [
    check("temporary_credential_expiry", sql`${t.expiresAt} > ${t.issuedAt}`),
    check(
      "temporary_credential_source",
      sql`${t.source} in ('OWNER_RESET', 'MEMBER_CREATED', 'OPERATOR_RECOVERY')`,
    ),
  ],
);
// Append-only record of security-relevant account events. It never holds passwords, tokens, TOTP
// secrets or recovery codes.
export const securityEvent = pgTable(
  "security_event",
  {
    id: text("id").primaryKey(),
    event: text("event").notNull(),
    academyId: text("academy_id").references(() => academies.id),
    actorId: text("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    targetUserId: text("target_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("security_event_academy_created").on(t.academyId, t.createdAt),
    index("security_event_target_created").on(t.targetUserId, t.createdAt),
  ],
);
// Per-account failed sign-in counter, keyed by a keyed hash of the normalised email (so unknown
// and known addresses behave identically and no address is stored).
export const signInThrottle = pgTable("sign_in_throttle", {
  key: text("key").primaryKey(),
  failures: integer("failures").notNull(),
  windowStartedAt: timestamp("window_started_at").notNull(),
  lockedUntil: timestamp("locked_until"),
});
// One-time-use marker for accepted authenticator codes (RFC 6238 section 5.2: a verifier must not
// accept the same code twice). Rows expire with the verification window.
export const totpUsed = pgTable(
  "totp_used_code",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.codeHash] })],
);
export const academies = pgTable("academy", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
});
export const memberships = pgTable(
  "membership",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    role: text("role").notNull(),
    active: boolean("active").notNull().default(true),
    // 0017: how this academy shows the person. Null means "use the person's own name" (app_user.name). An academy
    // owner edits only this; the global identity name is never rewritten by an academy.
    displayName: text("display_name"),
  },
  (t) => [
    primaryKey({ columns: [t.academyId, t.userId] }),
    check(
      "membership_display_name_length",
      sql`${t.displayName} IS NULL OR char_length(${t.displayName}) BETWEEN 1 AND 120`,
    ),
    // RC-3 (0013): only the eight stored roles of the authority module (STORED_ROLES; kept equal by
    // tests/migrations-0013.test.ts). The last-active-owner invariant is the deferred constraint trigger
    // membership_owner_presence in migrations/0013_role_validation_owner_presence.sql (Drizzle does not model triggers).
    check(
      "membership_role_known",
      sql`${t.role} IN ('OWNER','ADMIN','HEAD_COACH','COACH','FINANCE','NUTRITION_PRO','GUARDIAN','ADULT_PLAYER')`,
    ),
  ],
);
// 0017: which academy a SESSION is currently working in, for a person with more than one active membership. One row
// per session at most; it disappears with the session (sign-out, expiry, password change). It records a CHOICE, never
// authority: every request re-reads the membership, and the composite keys only guarantee the choice names a
// membership of the session's own user.
export const sessionAcademy = pgTable(
  "auth_session_academy",
  {
    sessionId: text("session_id").primaryKey(),
    userId: text("user_id").notNull(),
    academyId: text("academy_id").notNull(),
    selectedAt: timestamp("selected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "auth_session_academy_session_fk",
      columns: [t.sessionId, t.userId],
      foreignColumns: [session.id, session.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "auth_session_academy_membership_fk",
      columns: [t.academyId, t.userId],
      foreignColumns: [memberships.academyId, memberships.userId],
    }),
    index("auth_session_academy_membership_idx").on(t.academyId, t.userId),
  ],
);
// 0018: an academy's invitation for a person to JOIN it. Joining is never implied by an email address: an invitation is a
// secret link (only a keyed hash of its token is stored), addressed to one email, for one role, issued by an authorised
// member of THIS academy, and it creates a membership only when the addressed person is signed in and explicitly accepts
// it (invitations/application/service.ts). A GUARDIAN invitation also names the player and relationship the guardian link
// is made for on acceptance; an ADULT_PLAYER invitation creates a membership only. A trigger (0018) makes the identity
// columns immutable and ACCEPTED/REVOKED/EXPIRED final, so a used or withdrawn invitation can never come back.
export const academyInvitations = pgTable(
  "academy_invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    // Lower-cased, trimmed: the address this invitation is for. The accepting account's email must equal it.
    inviteeEmail: text("invitee_email").notNull(),
    kind: text("kind").notNull(),
    role: text("role").notNull(),
    playerId: text("player_id"),
    relationship: text("relationship"),
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: text("invited_by_user_id").notNull(),
    status: text("status").notNull().default("PENDING"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: text("accepted_by_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
  },
  (t) => [
    unique("academy_invitation_token_hash_unique").on(t.tokenHash),
    // The inviter is a member of THIS academy (the history of who invited survives a later change of their role).
    foreignKey({
      name: "academy_invitation_inviter_fk",
      columns: [t.academyId, t.invitedByUserId],
      foreignColumns: [memberships.academyId, memberships.userId],
    }),
    // A guardian invitation's player belongs to the same academy.
    foreignKey({
      name: "academy_invitation_player_fk",
      columns: [t.academyId, t.playerId],
      foreignColumns: [players.academyId, players.id],
    }),
    // One open invitation per address (and per player, for guardians) in an academy; other academies are independent.
    uniqueIndex("academy_invitation_one_pending_person")
      .on(t.academyId, t.inviteeEmail)
      .where(sql`${t.status} = 'PENDING' AND ${t.playerId} IS NULL`),
    uniqueIndex("academy_invitation_one_pending_player")
      .on(t.academyId, t.inviteeEmail, t.playerId)
      .where(sql`${t.status} = 'PENDING' AND ${t.playerId} IS NOT NULL`),
    index("academy_invitation_academy_idx").on(t.academyId, t.status, t.createdAt.desc()),
    check(
      "academy_invitation_email_form",
      sql`${t.inviteeEmail} = lower(btrim(${t.inviteeEmail})) AND char_length(${t.inviteeEmail}) BETWEEN 3 AND 254`,
    ),
    check("academy_invitation_kind", sql`${t.kind} IN ('STAFF', 'GUARDIAN', 'ADULT_PLAYER')`),
    check(
      "academy_invitation_shape",
      sql`(${t.kind} = 'STAFF' AND ${t.role} IN ('OWNER','ADMIN','HEAD_COACH','COACH','FINANCE','NUTRITION_PRO') AND ${t.playerId} IS NULL AND ${t.relationship} IS NULL)
       OR (${t.kind} = 'GUARDIAN' AND ${t.role} = 'GUARDIAN' AND ${t.playerId} IS NOT NULL AND ${t.relationship} IS NOT NULL)
       OR (${t.kind} = 'ADULT_PLAYER' AND ${t.role} = 'ADULT_PLAYER' AND ${t.playerId} IS NULL AND ${t.relationship} IS NULL)`,
    ),
    check("academy_invitation_status", sql`${t.status} IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')`),
    check(
      "academy_invitation_state",
      sql`((${t.status} = 'ACCEPTED') = (${t.acceptedAt} IS NOT NULL))
       AND ((${t.acceptedAt} IS NULL) = (${t.acceptedByUserId} IS NULL))
       AND ((${t.status} = 'REVOKED') = (${t.revokedAt} IS NOT NULL))
       AND ((${t.revokedAt} IS NULL) = (${t.revokedByUserId} IS NULL))`,
    ),
    check("academy_invitation_expiry", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
export const branches = pgTable(
  "branch",
  {
    id: text("id").notNull(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    name: text("name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.academyId, t.id] })],
);
export const batches = pgTable(
  "batch",
  {
    id: text("id").notNull(),
    academyId: text("academy_id").notNull(),
    name: text("name").notNull(),
    branchId: text("branch_id").notNull(),
    coachId: text("coach_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.academyId, t.id] }),
    foreignKey({
      columns: [t.academyId, t.branchId],
      foreignColumns: [branches.academyId, branches.id],
    }),
    foreignKey({
      columns: [t.academyId, t.coachId],
      foreignColumns: [memberships.academyId, memberships.userId],
    }),
  ],
);
export const players = pgTable(
  "player",
  {
    id: text("id").notNull(),
    academyId: text("academy_id").notNull(),
    name: text("name").notNull(),
    batchId: text("batch_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.academyId, t.id] }),
    foreignKey({
      columns: [t.academyId, t.batchId],
      foreignColumns: [batches.academyId, batches.id],
    }),
  ],
);
export const drills = pgTable(
  "drill_version",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    academyId: text("academy_id").references(() => academies.id),
    data: jsonb("data").$type<Drill>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.id, t.version] })],
);
export const trainingSessions = pgTable(
  "training_session",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    coachId: text("coach_id").notNull(),
    batchId: text("batch_id"),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("DRAFT"),
    data: jsonb("data").$type<SessionData>().notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.academyId, t.id),
    foreignKey({
      columns: [t.academyId, t.coachId],
      foreignColumns: [memberships.academyId, memberships.userId],
    }),
    foreignKey({
      columns: [t.academyId, t.batchId],
      foreignColumns: [batches.academyId, batches.id],
    }),
  ],
);
export const favourites = pgTable(
  "favourite",
  {
    academyId: text("academy_id").notNull(),
    userId: text("user_id").notNull(),
    drillId: text("drill_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.academyId, t.userId, t.drillId] }),
    foreignKey({
      columns: [t.academyId, t.userId],
      foreignColumns: [memberships.academyId, memberships.userId],
    }),
  ],
);
export const goals = pgTable(
  "individual_goal",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    data: jsonb("data").$type<Goal>().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.academyId, t.playerId],
      foreignColumns: [players.academyId, players.id],
    }),
  ],
);
export const audit = pgTable("audit_event", {
  id: text("id").primaryKey(),
  academyId: text("academy_id")
    .notNull()
    .references(() => academies.id),
  actorId: text("actor_id")
    .notNull()
    .references(() => user.id),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  version: integer("version").notNull(),
  detail: jsonb("detail").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
// Every session revision retains plan versus actual, including corrections and attendance changes.
export const revisions = pgTable(
  "session_revision",
  {
    academyId: text("academy_id").notNull(),
    sessionId: text("session_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    data: jsonb("data").$type<SessionData>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.academyId, t.sessionId, t.version] }),
    foreignKey({
      columns: [t.academyId, t.sessionId],
      foreignColumns: [trainingSessions.academyId, trainingSessions.id],
    }),
  ],
);

export const academySettings = pgTable("academy_settings", {
  academyId: text("academy_id")
    .primaryKey()
    .references(() => academies.id),
  version: integer("version").notNull().default(1),
  data: jsonb("data").$type<AcademySettings>().notNull(),
});
// Platform-controlled subscription capabilities cannot be changed by academy settings.
export const entitlements = pgTable("feature_entitlement", {
  academyId: text("academy_id")
    .primaryKey()
    .references(() => academies.id),
  data: jsonb("data").$type<Record<string, boolean>>().notNull(),
});
export const profiles = pgTable(
  "player_profile",
  {
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    version: integer("version").notNull().default(1),
    data: jsonb("data").$type<ProfileData>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.academyId, t.playerId] }),
    foreignKey({
      columns: [t.academyId, t.playerId],
      foreignColumns: [players.academyId, players.id],
    }),
  ],
);
export const guardianLinks = pgTable(
  "guardian_link",
  {
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    userId: text("user_id").notNull(),
    active: boolean("active").notNull().default(true),
    relationship: text("relationship").notNull(),
    consent: jsonb("consent")
      .$type<{ portal: boolean; email: boolean; whatsapp: boolean }>()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.academyId, t.playerId, t.userId] }),
    foreignKey({
      columns: [t.academyId, t.playerId],
      foreignColumns: [players.academyId, players.id],
    }),
    foreignKey({
      columns: [t.academyId, t.userId],
      foreignColumns: [memberships.academyId, memberships.userId],
    }),
  ],
);
export const playerHistory = pgTable(
  "player_history",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    kind: text("kind").notNull(),
    detail: jsonb("detail").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.academyId, t.playerId],
      foreignColumns: [players.academyId, players.id],
    }),
  ],
);
export const enquiries = pgTable(
  "admission_enquiry",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("ENQUIRY"),
    data: jsonb("data").$type<EnquiryData>().notNull(),
  },
  (t) => [unique().on(t.academyId, t.id)],
);
// Stage 5E: one row per recurring series. Identity of the series, its optimistic version and, for a
// "this and following" change, the series it was split from. The occurrences stay materialised in
// calendar_event (migration 0012).
export const calendarSeries = pgTable(
  "calendar_series",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    version: integer("version").notNull().default(1),
    kind: text("kind").notNull(),
    splitFrom: text("split_from"),
    data: jsonb("data").$type<CalendarSeriesData>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.academyId, t.id),
    foreignKey({
      name: "calendar_series_split_from_fk",
      columns: [t.academyId, t.splitFrom],
      foreignColumns: [t.academyId, t.id],
    }),
  ],
);
export const calendarEvents = pgTable(
  "calendar_event",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    version: integer("version").notNull().default(1),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("SCHEDULED"),
    data: jsonb("data").$type<CalendarData>().notNull(),
    // Stage 5E: series membership and the date of this occurrence's slot in the series. Both are null for a
    // one-off event and never change afterwards (trigger calendar_event_series_stable), except that a
    // split moves an occurrence to the series split from its own.
    seriesId: text("series_id"),
    occurrenceDate: date("occurrence_date", { mode: "string" }),
  },
  (t) => [
    unique().on(t.academyId, t.id),
    foreignKey({
      name: "calendar_event_series_fk",
      columns: [t.academyId, t.seriesId],
      foreignColumns: [calendarSeries.academyId, calendarSeries.id],
    }),
    unique("calendar_event_occurrence_unique").on(t.academyId, t.seriesId, t.occurrenceDate),
    check("calendar_event_series_shape", sql`(${t.seriesId} IS NULL) = (${t.occurrenceDate} IS NULL)`),
    check("calendar_event_series_mirror", sql`${t.seriesId} IS NOT DISTINCT FROM (${t.data}->>'seriesId')`),
  ],
);
export const feePlans = pgTable(
  "fee_plan",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    name: text("name").notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    archived: boolean("archived").notNull().default(false),
  },
  (t) => [unique().on(t.academyId, t.id)],
);
export const invoices = pgTable(
  "invoice",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("ISSUED"),
    data: jsonb("data").$type<InvoiceData>().notNull(),
  },
  (t) => [unique().on(t.academyId, t.id)],
);
/**
 * Canonical payment reference (Stage 5C), deterministic on every PostgreSQL build and locale:
 *   1. Unicode NFKC (full-width letters and digits become ASCII; no-break and other Unicode spaces
 *      become a plain space),
 *   2. every run of space, tab, line feed, carriage return, form feed or vertical tab becomes one
 *      space, and spaces at either end are removed,
 *   3. ASCII letters A-Z become lower case (other letters are kept as they are, so the result does
 *      not depend on the server's locale).
 * The application mirror is referenceKey() in src/modules/fees/domain/reference.ts.
 */
export const PAYMENT_REFERENCE_KEY_SQL = String.raw`translate(btrim(regexp_replace(normalize("reference", NFKC), '[ \t\n\r\f\v]+', ' ', 'g'), ' '), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
export const payments = pgTable(
  "payment_reference",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id").notNull(),
    invoiceId: text("invoice_id").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("SUBMITTED"),
    idempotencyKey: text("idempotency_key").notNull(),
    reference: text("reference").notNull(),
    // Stage 5C: the canonical form used for duplicate detection, computed by the database from
    // `reference` (which keeps exactly what was submitted). Mirrored by referenceKey() in
    // fees/domain/reference.ts; see PAYMENT_REFERENCE_KEY_SQL for the rule.
    referenceKey: text("reference_key")
      .notNull()
      .generatedAlwaysAs(sql.raw(PAYMENT_REFERENCE_KEY_SQL)),
    // Set once, when staff reject an attempt: CORRECTABLE (the same reference may come back as a
    // new attempt on the same invoice) or INVALID (the reference stays blocked). NULL otherwise,
    // and for rejections recorded before Stage 5C (treated as blocking, like INVALID).
    rejectionKind: text("rejection_kind"),
    data: jsonb("data").$type<PaymentData>().notNull(),
  },
  (t) => [
    unique().on(t.academyId, t.id),
    unique().on(t.academyId, t.idempotencyKey),
    // A reference may be live (awaiting a decision, or verified) only once per academy, and a
    // reference rejected as INVALID stays taken. Correctable rejections leave the index.
    uniqueIndex("payment_reference_live_key")
      .on(t.academyId, t.referenceKey)
      .where(
        sql`${t.status} in ('SUBMITTED', 'VERIFIED') or ${t.rejectionKind} = 'INVALID'`,
      ),
    // Pending attempts of an invoice (the three-pending limit and the invoice ledger).
    index("payment_reference_invoice_status").on(
      t.academyId,
      t.invoiceId,
      t.status,
    ),
    check(
      "payment_reference_status_check",
      sql`${t.status} in ('SUBMITTED', 'VERIFIED', 'REJECTED')`,
    ),
    check(
      "payment_reference_rejection_kind_check",
      sql`${t.rejectionKind} is null or (${t.status} = 'REJECTED' and ${t.rejectionKind} in ('CORRECTABLE', 'INVALID'))`,
    ),
    foreignKey({
      columns: [t.academyId, t.invoiceId],
      foreignColumns: [invoices.academyId, invoices.id],
    }),
  ],
);
export const refunds = pgTable(
  "payment_refund",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id").notNull(),
    paymentId: text("payment_id").notNull(),
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.academyId, t.idempotencyKey),
    foreignKey({
      columns: [t.academyId, t.paymentId],
      foreignColumns: [payments.academyId, payments.id],
    }),
  ],
);
export const lessonCredits = pgTable(
  "lesson_credit",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    units: integer("units").notNull(),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.academyId, t.idempotencyKey),
    foreignKey({
      columns: [t.academyId, t.playerId],
      foreignColumns: [players.academyId, players.id],
    }),
  ],
);
export const observationReviews = pgTable(
  "observation_review",
  {
    academyId: text("academy_id").notNull(),
    sessionId: text("session_id").notNull(),
    observationId: text("observation_id").notNull(),
    version: integer("version").notNull().default(1),
    approvedText: text("approved_text").notNull(),
    /** Optional tag given when the wording was reviewed (migration 0019): TECHNICAL, TACTICAL, PHYSICAL or BEHAVIOUR. */
    category: text("category"),
    reviewerId: text("reviewer_id")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.academyId, t.sessionId, t.observationId] }),
    foreignKey({
      columns: [t.academyId, t.sessionId],
      foreignColumns: [trainingSessions.academyId, trainingSessions.id],
    }),
  ],
);
export const reports = pgTable(
  "player_report",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("DRAFT"),
    data: jsonb("data").$type<ReportData>().notNull(),
  },
  (t) => [
    unique().on(t.academyId, t.id),
    foreignKey({
      columns: [t.academyId, t.playerId],
      foreignColumns: [players.academyId, players.id],
    }),
  ],
);
export const restrictedNutrition = pgTable(
  "restricted_nutrition",
  {
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    version: integer("version").notNull().default(1),
    allergies: text("allergies").notNull(),
    restrictions: text("restrictions").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.academyId, t.playerId] }),
    foreignKey({
      columns: [t.academyId, t.playerId],
      foreignColumns: [players.academyId, players.id],
    }),
  ],
);
export const nutritionPlans = pgTable(
  "nutrition_plan",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("DRAFT"),
    data: jsonb("data").$type<NutritionData>().notNull(),
  },
  (t) => [
    unique().on(t.academyId, t.id),
    foreignKey({
      columns: [t.academyId, t.playerId],
      foreignColumns: [players.academyId, players.id],
    }),
  ],
);
export const nutritionQuestions = pgTable(
  "nutrition_question",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id),
    question: text("question").notNull(),
    answer: text("answer").notNull().default(""),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    foreignKey({
      columns: [t.academyId, t.playerId],
      foreignColumns: [players.academyId, players.id],
    }),
  ],
);
// Which players a Nutrition Pro may see and advise. There is no implicit access: a professional with
// no active row here sees no players. The composite keys tie each row to a real player and to a real
// membership of the SAME academy, so an assignment can never cross academies.
export const nutritionAssignments = pgTable(
  "nutrition_assignment",
  {
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    professionalId: text("professional_id").notNull(),
    active: boolean("active").notNull().default(true),
    assignedBy: text("assigned_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.academyId, t.playerId, t.professionalId] }),
    foreignKey({
      columns: [t.academyId, t.playerId],
      foreignColumns: [players.academyId, players.id],
    }),
    foreignKey({
      columns: [t.academyId, t.professionalId],
      foreignColumns: [memberships.academyId, memberships.userId],
    }),
    index("nutrition_assignment_professional").on(
      t.academyId,
      t.professionalId,
      t.active,
    ),
  ],
);
// Two-factor policy chosen by an academy's owner (Phase 4). One optional row per academy; no row means
// "off". It can only RAISE the requirement set by the deployment (MFA_ENFORCEMENT): the effective
// level for a role is the stricter of the two (see modules/identity/mfa-policy.ts).
export const academyMfaPolicy = pgTable(
  "academy_mfa_policy",
  {
    academyId: text("academy_id")
      .primaryKey()
      .references(() => academies.id),
    mode: text("mode").notNull().default("off"),
    roles: jsonb("roles").$type<string[]>().notNull().default([]),
    // When the current warn stage began (null when not in warn); readiness uses it to advise on how
    // long people have had notice before enforcement.
    warnSince: timestamp("warn_since"),
    updatedBy: text("updated_by").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "academy_mfa_policy_mode_check",
      sql`${t.mode} in ('off', 'warn', 'enforce')`,
    ),
  ],
);
// ---- Consent management (Phase 5) ---------------------------------------------------------------
// Versioned consent documents. A version is a DRAFT until an owner/admin publishes it; from then on
// it can never change or be deleted (trigger in migration 0007), so a decision can always be traced to
// the exact text that was presented. One open draft per category.
export const consentPolicyVersions = pgTable(
  "consent_policy_version",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    category: text("category").notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("DRAFT"),
    // Decided at publication: when true, consent given on an earlier version lapses (explicit LAPSED
    // events) until the person accepts this one; when false it stays in force and renewal is requested.
    requireRenewal: boolean("require_renewal").notNull().default(false),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    publishedBy: text("published_by").references(() => user.id),
    publishedAt: timestamp("published_at"),
    effectiveAt: timestamp("effective_at"),
  },
  (t) => [
    unique("consent_policy_version_number").on(
      t.academyId,
      t.category,
      t.version,
    ),
    unique("consent_policy_version_ref").on(t.academyId, t.id, t.category),
    uniqueIndex("consent_policy_version_one_draft")
      .on(t.academyId, t.category)
      .where(sql`${t.status} = 'DRAFT'`),
    check(
      "consent_policy_version_status_check",
      sql`${t.status} in ('DRAFT', 'PUBLISHED')`,
    ),
    check(
      "consent_policy_version_category_check",
      sql`${t.category} in ('PORTAL', 'EMAIL', 'WHATSAPP')`,
    ),
    check(
      "consent_policy_version_published_check",
      sql`(${t.status} = 'DRAFT' and ${t.publishedAt} is null) or (${t.status} = 'PUBLISHED' and ${t.publishedAt} is not null and ${t.effectiveAt} is not null)`,
    ),
  ],
);
// Append-only history of consent decisions (no UPDATE/DELETE: trigger in migration 0007). The
// guardian_link.consent flags remain the derived CURRENT state used to gate messages; both change in
// the same transaction. (academy, player, subject, category, sequence) is unique, so two writers
// cannot both append "the next" decision. Legacy rows imported from the pre-history flags carry no
// actor, no document version and no effective date: those facts were never recorded.
export const consentEvents = pgTable(
  "consent_event",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    // The person whose consent this is (a linked guardian, or the adult player themself).
    subjectUserId: text("subject_user_id").notNull(),
    category: text("category").notNull(),
    sequence: integer("sequence").notNull(),
    decision: text("decision").notNull(),
    policyVersionId: text("policy_version_id"),
    actorId: text("actor_id").references(() => user.id),
    actorRole: text("actor_role"),
    // Relationship on the link when recorded (self-declared; legal authority is NOT verified).
    authority: text("authority"),
    method: text("method").notNull(),
    evidenceRef: text("evidence_ref"),
    reason: text("reason"),
    effectiveAt: timestamp("effective_at"),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
    previousEventId: text("previous_event_id"),
    previousDecision: text("previous_decision"),
  },
  (t) => [
    unique("consent_event_sequence").on(
      t.academyId,
      t.playerId,
      t.subjectUserId,
      t.category,
      t.sequence,
    ),
    foreignKey({
      columns: [t.academyId, t.playerId],
      foreignColumns: [players.academyId, players.id],
    }),
    foreignKey({
      columns: [t.academyId, t.playerId, t.subjectUserId],
      foreignColumns: [
        guardianLinks.academyId,
        guardianLinks.playerId,
        guardianLinks.userId,
      ],
    }),
    foreignKey({
      columns: [t.academyId, t.policyVersionId, t.category],
      foreignColumns: [
        consentPolicyVersions.academyId,
        consentPolicyVersions.id,
        consentPolicyVersions.category,
      ],
    }),
    index("consent_event_player_recorded").on(
      t.academyId,
      t.playerId,
      t.recordedAt,
    ),
    check(
      "consent_event_category_check",
      sql`${t.category} in ('PORTAL', 'EMAIL', 'WHATSAPP')`,
    ),
    check(
      "consent_event_decision_check",
      sql`${t.decision} in ('GRANTED', 'RENEWED', 'WITHDRAWN', 'LAPSED')`,
    ),
    check(
      "consent_event_method_check",
      sql`${t.method} in ('PORTAL_SELF', 'STAFF_WRITTEN', 'STAFF_VERBAL', 'IMPORT_LEGACY', 'SYSTEM_POLICY')`,
    ),
    check("consent_event_sequence_check", sql`${t.sequence} >= 1`),
    // Staff may not record a grant on someone's behalf without saying what it rests on.
    check(
      "consent_event_evidence_check",
      sql`${t.method} not in ('STAFF_WRITTEN', 'STAFF_VERBAL') or ${t.decision} not in ('GRANTED', 'RENEWED') or length(trim(coalesce(${t.evidenceRef}, ''))) > 0`,
    ),
    // A legacy import states only what the old flags said: no actor, no version.
    check(
      "consent_event_legacy_check",
      sql`${t.method} <> 'IMPORT_LEGACY' or (${t.actorId} is null and ${t.policyVersionId} is null and ${t.decision} = 'GRANTED')`,
    ),
    check(
      "consent_event_system_check",
      sql`(${t.method} = 'SYSTEM_POLICY') = (${t.decision} = 'LAPSED')`,
    ),
  ],
);
export const messageTemplates = pgTable("message_template", {
  id: text("id").primaryKey(),
  academyId: text("academy_id")
    .notNull()
    .references(() => academies.id),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
});
export const messages = pgTable(
  "message_draft",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("DRAFT"),
    data: jsonb("data").$type<MessageData>().notNull(),
  },
  (t) => [unique().on(t.academyId, t.id)],
);
export const deliveries = pgTable(
  "outbox_delivery",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id").notNull(),
    messageId: text("message_id").notNull(),
    userId: text("user_id").notNull(),
    channel: text("channel").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    detail: text("detail").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.academyId, t.messageId, t.userId, t.channel),
    foreignKey({
      columns: [t.academyId, t.messageId],
      foreignColumns: [messages.academyId, messages.id],
    }),
  ],
);
export const conversations = pgTable("private_conversation", {
  id: text("id").primaryKey(),
  playerId: text("player_id").notNull(),
  academyId: text("academy_id")
    .notNull()
    .references(() => academies.id),
  guardianId: text("guardian_id")
    .notNull()
    .references(() => user.id),
  subject: text("subject").notNull(),
  version: integer("version").notNull().default(1),
  entries: jsonb("entries")
    .$type<
      { id: string; authorId: string; name: string; text: string; at: string }[]
    >()
    .notNull(),
});
export const mediaAssets = pgTable(
  "private_media_asset",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    storageKey: text("storage_key").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("PRIVATE"),
    feedback: text("feedback").notNull().default(""),
    reviewerId: text("reviewer_id"),
    sessionId: text("session_id"),
    timestampNotes: jsonb("timestamp_notes")
      .$type<TimestampNote[]>()
      .notNull()
      .default([]),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.academyId, t.playerId],
      foreignColumns: [players.academyId, players.id],
    }),
  ],
);
export const recordRevisions = pgTable(
  "record_revision",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    entityId: text("entity_id").notNull(),
    kind: text("kind").notNull(),
    version: integer("version").notNull(),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.academyId, t.entityId, t.kind, t.version)],
);
// Phase 7: who looked at sensitive information, when, through what, and whether it was allowed. One row per
// logical access (a request that reads a category of sensitive data), never a copy of the data: it holds
// identifiers, an allow-listed category/operation/outcome and a few counts. Append-only (database trigger).
// actor_id and player_id are deliberately plain text without foreign keys: the history of who looked must
// survive a later removal of an account or a player (Phase 8 decides erasure deliberately).
export const accessEvents = pgTable(
  "access_event",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    actorId: text("actor_id").notNull(),
    actorRole: text("actor_role").notNull(),
    category: text("category").notNull(),
    operation: text("operation").notNull(),
    outcome: text("outcome").notNull(),
    resourceId: text("resource_id"),
    playerId: text("player_id"),
    // The application operation, e.g. "GET reports/:id/pdf", or "service" when called directly.
    channel: text("channel").notNull(),
    requestId: text("request_id"),
    context: jsonb("context").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("access_event_academy_created").on(t.academyId, t.createdAt, t.id),
    index("access_event_actor_created").on(t.academyId, t.actorId, t.createdAt),
    index("access_event_player_created").on(t.academyId, t.playerId, t.createdAt),
    index("access_event_category_created").on(
      t.academyId,
      t.category,
      t.createdAt,
    ),
    check(
      "access_event_outcome_check",
      sql`${t.outcome} in ('SUCCESS', 'DENIED')`,
    ),
    check(
      "access_event_operation_check",
      sql`${t.operation} in ('VIEW', 'LIST', 'BULK', 'DOWNLOAD', 'PDF', 'HISTORICAL', 'THROTTLED')`,
    ),
    check(
      "access_event_category_check",
      sql`${t.category} in ('WORKSPACE', 'CONSENT', 'REPORT', 'NUTRITION', 'MEDIA', 'FINANCE', 'ACCOUNT_SECURITY', 'AUDIT_LOG', 'TRAINING', 'PRIVACY')`,
    ),
  ],
);
// Phase 8: retention, controlled erasure and legal holds.
// An academy's approved retention rule for one category of data. NO ROW = "REQUIRES POLICY APPROVAL":
// nothing is erased for a category until its owner approves a rule (and fixed-retention categories
// such as finance, consent evidence and audit records cannot be given an erase rule at all).
export const retentionPolicies = pgTable(
  "retention_policy",
  {
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    category: text("category").notNull(),
    status: text("status").notNull().default("APPROVED"),
    action: text("action").notNull(),
    // null = on request (no waiting period); otherwise whole days after the subject left.
    retentionDays: integer("retention_days"),
    basis: text("basis").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: timestamp("approved_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.academyId, t.category] }),
    check("retention_policy_status_check", sql`${t.status} in ('APPROVED', 'SUSPENDED')`),
    check("retention_policy_action_check", sql`${t.action} in ('ERASE', 'ANONYMIZE')`),
    check("retention_policy_days_check", sql`${t.retentionDays} is null or ${t.retentionDays} >= 0`),
  ],
);
// A legal hold stops erasure of one player (or, with scope ACADEMY, of everyone). Never deleted:
// releasing it records who and why.
export const legalHolds = pgTable(
  "legal_hold",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    scope: text("scope").notNull(),
    playerId: text("player_id"),
    reason: text("reason").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    releasedBy: text("released_by"),
    releasedAt: timestamp("released_at"),
    releaseReason: text("release_reason"),
  },
  (t) => [
    index("legal_hold_academy_open").on(t.academyId, t.releasedAt),
    check("legal_hold_scope_check", sql`(${t.scope} = 'ACADEMY' and ${t.playerId} is null) or (${t.scope} = 'PLAYER' and ${t.playerId} is not null)`),
  ],
);
// One erasure request per subject at a time. The row is also the durable job: processing claims it,
// records each step, retries with backoff, and ends in COMPLETED or an explicit FAILED.
export const erasureRequests = pgTable(
  "erasure_request",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    subjectType: text("subject_type").notNull().default("PLAYER"),
    playerId: text("player_id").notNull(),
    source: text("source").notNull(),
    reason: text("reason").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at").notNull().defaultNow(),
    status: text("status").notNull(),
    version: integer("version").notNull().default(1),
    // Counts only, never record contents.
    preview: jsonb("preview").notNull().default({}),
    previewAt: timestamp("preview_at"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at"),
    reviewReason: text("review_reason"),
    executeAfter: timestamp("execute_after"),
    // What approval authorised: [{category, action}], frozen at approval.
    plan: jsonb("plan").notNull().default([]),
    steps: jsonb("steps").notNull().default([]),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at"),
    lockedUntil: timestamp("locked_until"),
    lockedBy: text("locked_by"),
    blockedReason: text("blocked_reason"),
    failureCode: text("failure_code"),
    completedAt: timestamp("completed_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("erasure_request_academy_status").on(t.academyId, t.status),
    index("erasure_request_due").on(t.status, t.executeAfter),
    uniqueIndex("erasure_request_one_open")
      .on(t.academyId, t.playerId)
      .where(sql`${t.status} in ('PREVIEW_READY', 'GRACE_PERIOD', 'PROCESSING', 'BLOCKED')`),
    check(
      "erasure_request_status_check",
      sql`${t.status} in ('PREVIEW_READY', 'GRACE_PERIOD', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELLED', 'BLOCKED', 'FAILED')`,
    ),
    check("erasure_request_subject_check", sql`${t.subjectType} = 'PLAYER'`),
  ],
);
// The request's own history: who did what, when and why. Append-only (database trigger).
export const erasureEvents = pgTable(
  "erasure_event",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    requestId: text("request_id")
      .notNull()
      .references(() => erasureRequests.id),
    at: timestamp("at").notNull().defaultNow(),
    event: text("event").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    actorId: text("actor_id"),
    actorRole: text("actor_role"),
    reason: text("reason"),
    detail: jsonb("detail").notNull().default({}),
  },
  (t) => [index("erasure_event_request_at").on(t.requestId, t.at)],
);
// Outbox for private files: the database transaction records which files must go, the file removal
// happens after commit and is retried until it is done or explicitly failed. Opaque keys only.
export const storageDeletions = pgTable(
  "storage_deletion",
  {
    id: text("id").primaryKey(),
    academyId: text("academy_id")
      .notNull()
      .references(() => academies.id),
    requestId: text("request_id")
      .notNull()
      .references(() => erasureRequests.id),
    storageKey: text("storage_key").notNull(),
    status: text("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    doneAt: timestamp("done_at"),
  },
  (t) => [
    uniqueIndex("storage_deletion_key").on(t.academyId, t.storageKey),
    index("storage_deletion_pending").on(t.status, t.nextAttemptAt),
    check("storage_deletion_status_check", sql`${t.status} in ('PENDING', 'DONE', 'FAILED')`),
  ],
);
// RC-4 (migration 0014): what an ADULT player has opened to one guardian. One row per (player, guardian); the row is
// the CURRENT state and guardian_access_event below is its append-only history. A guardian reads an adult's record
// only through a row here that is not revoked, was granted by the account the profile names as the adult
// (granted_by), and whose guardian_link is still active; no row means no access. Written only by the adult
// (academy/application/guardian-access.ts) and, to END access, by the transition code in the players service.
// scopes: a JSON array of names from GUARDIAN_ACCESS_SCOPES (academy/domain/guardian-access.ts).
export const guardianAccessGrants = pgTable(
  "guardian_access_grant",
  {
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    guardianUserId: text("guardian_user_id").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    grantedBy: text("granted_by").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.academyId, t.playerId, t.guardianUserId] }),
    foreignKey({
      name: "guardian_access_grant_link_fkey",
      columns: [t.academyId, t.playerId, t.guardianUserId],
      foreignColumns: [guardianLinks.academyId, guardianLinks.playerId, guardianLinks.userId],
    }).onDelete("cascade"),
    index("guardian_access_grant_lookup_idx")
      .on(t.academyId, t.guardianUserId)
      .where(sql`${t.revokedAt} is null`),
    check("guardian_access_grant_scopes_check", sql`jsonb_typeof(${t.scopes}) = 'array'`),
  ],
);
// Append-only (UPDATE, DELETE and TRUNCATE are refused by triggers in migration 0014): every grant, change,
// revocation and automatic end of a guardian's access to an adult's record, with who did it and in which role.
export const guardianAccessEvents = pgTable(
  "guardian_access_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    academyId: text("academy_id").notNull(),
    playerId: text("player_id").notNull(),
    guardianUserId: text("guardian_user_id").notNull(),
    event: text("event").notNull(),
    scopes: jsonb("scopes").$type<string[]>(),
    actorId: text("actor_id").notNull(),
    actorRole: text("actor_role").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason"),
  },
  (t) => [
    index("guardian_access_event_player_idx").on(t.academyId, t.playerId, t.at.desc()),
    check(
      "guardian_access_event_type_check",
      sql`${t.event} in ('ACCESS_ENDED_ADULTHOOD', 'GRANTED', 'SCOPES_CHANGED', 'REVOKED', 'ENDED_LINK_INACTIVE', 'ENDED_ADULT_FLAG_CLEARED')`,
    ),
  ],
);

// Transactional authentication email outbox: seals recipient and secrets with AES-256-GCM at rest
// and wipes sealed_payload immediately on terminal states (SENT or FAILED_PERMANENT).
export const authEmailOutbox = pgTable(
  "auth_email_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    recipientHash: text("recipient_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sealedPayload: text("sealed_payload"),
    status: text("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    providerMessageId: text("provider_message_id"),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_email_outbox_idempotency_key_idx").on(t.idempotencyKey),
    index("auth_email_outbox_dispatch_idx")
      .on(t.nextAttemptAt, t.createdAt)
      .where(sql`${t.status} in ('PENDING', 'FAILED_RETRYABLE')`),
    index("auth_email_outbox_user_idx").on(t.userId, t.createdAt.desc()),
    check(
      "auth_email_outbox_kind_check",
      sql`${t.kind} in ('EMAIL_VERIFICATION_OTP', 'PASSWORD_RESET_LINK')`,
    ),
    check(
      "auth_email_outbox_status_check",
      sql`${t.status} in ('PENDING', 'SENDING', 'SENT', 'FAILED_RETRYABLE', 'FAILED_PERMANENT')`,
    ),
    check("auth_email_outbox_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

// ---------------------------------------------------------------------------------------------------------------------
// Migration 0019: contacts, report policy, the delivery queue and report links.
// ---------------------------------------------------------------------------------------------------------------------
/**
 * A place a message may be sent: a player's or an account's extra e-mail or WhatsApp number, with the channel-specific facts
 * about it (WhatsApp opt-in with source, time and revocation; suppression after a bounce or a "stop"). Addresses are NEVER
 * unique across subjects and are never used to match or merge people: a parent and a player may share any value.
 */
export const contactPoints = pgTable("contact_point", {
  id: uuid("id").primaryKey().defaultRandom(),
  academyId: text("academy_id").notNull().references(() => academies.id),
  playerId: text("player_id"),
  userId: text("user_id"),
  channel: text("channel").notNull(),
  address: text("address").notNull(),
  label: text("label"),
  optedInAt: timestamp("opted_in_at", { withTimezone: true }),
  optInSource: text("opt_in_source"),
  optInRecordedBy: text("opt_in_recorded_by"),
  optInRevokedAt: timestamp("opt_in_revoked_at", { withTimezone: true }),
  suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
  suppressionReason: text("suppression_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const reportPolicies = pgTable("report_policy", {
  academyId: text("academy_id").primaryKey().references(() => academies.id),
  monthlyEnabled: boolean("monthly_enabled").notNull().default(false),
  sessionsEnabled: boolean("sessions_enabled").notNull().default(false),
  sessionsN: integer("sessions_n").notNull().default(8),
  requiredCategories: jsonb("required_categories").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  enabledBy: text("enabled_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const dispatchBatches = pgTable(
  "dispatch_batch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    academyId: text("academy_id").notNull().references(() => academies.id),
    kind: text("kind").notNull().default("REPORT"),
    title: text("title").notNull(),
    recipientMode: text("recipient_mode").notNull(),
    consolidation: text("consolidation").notNull().default("PER_PARENT"),
    channels: jsonb("channels").$type<string[]>().notNull(),
    reportIds: jsonb("report_ids").$type<string[]>().notNull(),
    status: text("status").notNull().default("DRAFT"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [unique("dispatch_batch_academy_id_unique").on(t.academyId, t.id)],
);
export const dispatchItems = pgTable(
  "dispatch_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    academyId: text("academy_id").notNull(),
    batchId: uuid("batch_id").notNull(),
    channel: text("channel").notNull(),
    address: text("address").notNull(),
    addressHash: text("address_hash").notNull(),
    recipientNames: jsonb("recipient_names").$type<string[]>().notNull(),
    /** Who this message is for (an account or a player), so a bounce or a "stop" can be recorded against them. */
    subjectRefs: jsonb("subject_refs").$type<{ kind: "ACCOUNT" | "PLAYER"; id: string }[]>().notNull().default(sql`'[]'::jsonb`),
    reportIds: jsonb("report_ids").$type<string[]>().notNull(),
    status: text("status").notNull().default("QUEUED"),
    skipReason: text("skip_reason"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leasedBy: text("leased_by"),
    providerMessageId: text("provider_message_id"),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    unique("dispatch_item_academy_id_unique").on(t.academyId, t.id),
    foreignKey({ name: "dispatch_item_batch_fk", columns: [t.academyId, t.batchId], foreignColumns: [dispatchBatches.academyId, dispatchBatches.id] }),
    uniqueIndex("dispatch_item_one_per_address").on(t.batchId, t.channel, t.addressHash),
  ],
);
export const dispatchEvents = pgTable(
  "dispatch_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    academyId: text("academy_id").notNull(),
    itemId: uuid("item_id").notNull(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "dispatch_event_item_fk", columns: [t.academyId, t.itemId], foreignColumns: [dispatchItems.academyId, dispatchItems.id] }),
    uniqueIndex("dispatch_event_once").on(t.provider, t.providerEventId),
  ],
);
export const reportLinks = pgTable(
  "report_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    academyId: text("academy_id").notNull(),
    itemId: uuid("item_id").notNull(),
    reportId: text("report_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }),
    openCount: integer("open_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "report_link_item_fk", columns: [t.academyId, t.itemId], foreignColumns: [dispatchItems.academyId, dispatchItems.id] }),
    foreignKey({ name: "report_link_report_fk", columns: [t.academyId, t.reportId], foreignColumns: [reports.academyId, reports.id] }),
    uniqueIndex("report_link_one_per_item_report").on(t.itemId, t.reportId),
  ],
);
