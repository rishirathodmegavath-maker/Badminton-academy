export type ProfileData = {
  adult: boolean;
  birthDate: string;
  email: string;
  phone: string;
  notes: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  selfUserId: string | null;
  /**
   * The player's OWN login (a player who joined by invitation link). Unlike `selfUserId` this does not make the record
   * adult-controlled: parents keep their normal access and this account sees only the sections in PLAYER_LOGIN_SCOPES.
   */
  loginUserId?: string | null;
  preferences: string;
  /** The owner's "keep for now" decision about a player who is 18 or older (set only by the age review). */
  ageDecision?: import("../../players/domain/age").AgeDecision | null;
};
export type EnquiryData = {
  name: string;
  email: string;
  phone: string;
  adult: boolean;
  source: string;
  followUpDate: string;
  notes: string;
  trialEventId: string | null;
  trialAttendance: "NOT_MARKED" | "PRESENT" | "ABSENT" | "EXCUSED";
  feedback: string;
  playerId: string | null;
};
export type CalendarData = {
  title: string;
  localDate: string;
  localTime: string;
  duration: number;
  startsAt: string;
  endsAt: string;
  timezone: string;
  branchId: string;
  coachId: string;
  batchId: string;
  playerIds: string[];
  enquiryId: string | null;
  seriesId: string | null;
  /** Stage 5E: fields of this occurrence changed individually (series changes leave them alone unless overwritten). */
  overrides?: CalendarField[];
  /** Stage 5E: why and how the occurrence was cancelled (removed on restore; kept in the revision history). */
  cancellation?: { reason: string; at: string; scope: "THIS" | "FOLLOWING" | "SERIES" };
};
/** Fields an occurrence can change individually; "status" marks an individual cancellation or restore. */
export type CalendarField =
  | "title"
  | "localDate"
  | "localTime"
  | "duration"
  | "branchId"
  | "coachId"
  | "batchId"
  | "playerIds"
  | "status";
/** Stage 5E: the rule a weekly series was created with (informational; occurrences are materialised). */
export type CalendarSeriesData = {
  origin: "CREATED" | "MIGRATED" | "SPLIT";
  firstDate: string;
  count: number;
  interval: 1;
  localTime?: string;
  duration?: number;
  timezone?: string;
  splitAt?: string;
};
export type AcademySettings = {
  country: "IN" | "US";
  currency: "INR" | "USD";
  colour: string;
  policy: string;
  retentionDays: number;
  features: {
    reports: boolean;
    nutrition: boolean;
    communications: boolean;
    manualVideo: boolean;
  };
  integrations: { email: "MANUAL"; whatsapp: "MANUAL" };
  /** Where the academy is and how to reach it. Given when the owner creates the academy; older academies have neither. */
  city?: string;
  contactEmail?: string;
  /** A short description shown on the academy profile (at most 250 characters). */
  about?: string;
  /** The academy logo as a PNG data URL. Stored here, never sent to the browser: see publicSettings in settings/domain/logo.ts. */
  logoData?: string;
  /** Set by the server when settings are read for the browser: whether a logo is stored. Never stored. */
  hasLogo?: boolean;
};
export const defaultSettings: AcademySettings = {
  country: "IN",
  currency: "INR",
  colour: "#17644e",
  policy: "",
  retentionDays: 365,
  features: {
    reports: true,
    nutrition: true,
    communications: true,
    manualVideo: true,
  },
  integrations: { email: "MANUAL", whatsapp: "MANUAL" },
};
export type InvoiceData = {
  number: string;
  playerIds: string[];
  familyUserId: string | null;
  planId: string | null;
  description: string;
  currency: "INR" | "USD";
  subtotal: number;
  discount: number;
  total: number;
  dueDate: string;
  issuedAt: string;
  voidReason: string;
};
export type PaymentData = {
  invoiceId: string;
  amount: number;
  currency: string;
  reference: string;
  method: string;
  submittedBy: string;
  verifiedBy: string | null;
  reason: string;
  receiptNumber: string | null;
  /** Stage 5C: a resubmission after a correctable rejection names the attempt it follows. */
  previousAttemptId?: string;
  attemptNo?: number;
  /** Copy of the decision on a rejected attempt (the column rejection_kind is authoritative). */
  rejectionKind?: "CORRECTABLE" | "INVALID";
};
export type ReportData = {
  playerId: string;
  periodStart: string;
  periodEnd: string;
  title: string;
  summary: string;
  evidence: {
    sessionId: string;
    title: string;
    date: string;
    activities: string[];
    observations: string[];
    /** The player's recorded attendance for the session, snapshotted when the draft was created (absent on older drafts). */
    attendance?: "PRESENT" | "ABSENT" | "EXCUSED" | "NOT_MARKED";
    /** The activities recorded as done by an attending player, with the drill's skill (absent on older drafts). */
    practised?: { title: string; skill: string | null; status: "COMPLETED" | "MODIFIED" }[];
    /** The reviewed observations about the player in this session with their category (absent on older drafts). */
    observationDetails?: { text: string; category: "TECHNICAL" | "TACTICAL" | "PHYSICAL" | "BEHAVIOUR" | null }[];
  }[];
  /** Attendance, practice time by area and reviewed-observation counts for this period and the one before (absent on older drafts). */
  analysis?: import("../../reports/domain/report-analysis").ReportAnalysis;
  /** Coach-entered, shown to the family once published. All optional: older reports have none of them. */
  strengths?: string;
  improvements?: string;
  priorities?: string[];
  closingNote?: string;
  /** The player's batch (age group / category) as it was when the draft was created. */
  group?: string;
  /** A counts-only sentence from the records, made when the draft was created. The coach may use it as the summary. */
  facts?: string;
  academyName: string;
  playerName: string;
  /** Name of the approver as it was when the report was approved (a snapshot, never rewritten). */
  reviewer: string | null;
  /** Account that approved it: set by the server from the signed-in session; absent on older records. */
  reviewerId?: string | null;
  approvedAt: string | null;
};
export type NutritionData = {
  playerId: string;
  title: string;
  guidance: string;
  /** Name of the approving professional as it was at approval (a snapshot, never rewritten). */
  professional: string | null;
  /** Account that approved it: set by the server from the signed-in session; absent on older records. */
  professionalId?: string | null;
  reviewNote: string;
  approvedAt: string | null;
  sections?: {
    beforeTraining: string;
    afterTraining: string;
    dailyMeals: string;
    hydration: string;
    trainingDay: string;
  };
};
export type TimestampNote = {
  id: string;
  seconds: number;
  text: string;
  authorId: string;
  authorName: string;
  at: string;
};
export type MessageData = {
  subject: string;
  body: string;
  playerIds: string[];
  batchIds: string[];
  allBatches: boolean;
  channels: ("PORTAL" | "EMAIL" | "WHATSAPP")[];
  recipients: {
    userId: string;
    name: string;
    email: string;
    playerIds: string[];
    channels: string[];
  }[];
  scheduledAt: string | null;
  approvedBy: string | null;
  approvalHash: string | null;
  templateId: string | null;
};
