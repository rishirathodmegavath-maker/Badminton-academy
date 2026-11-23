export type Drill = {
  id: string;
  version: number;
  academyId: string | null;
  title: string;
  skill: string;
  level: string;
  format: string;
  minutes: number;
  players: number;
  equipment: string[];
  objective: string;
  setup: string;
  steps: string[];
  cues: string[];
  mistakes: string[];
  easier: string;
  harder: string;
  review: string;
  /** The library's own numbering and grouping (catalogue drills only). */
  number?: number;
  category?: string;
  /** Safety statements the coach reads before the drill; never medical advice. */
  safety?: string[];
  /** Youngest age the drill is suggested for. A coach's judgement still applies. */
  minimumAge?: number;
  /** Where the idea comes from and how the wording was written. */
  source?: string;
};
export type Activity = {
  id: string;
  drillId: string | null;
  drillVersion: number | null;
  title: string;
  minutes: number;
  cues: string;
  snapshot: Drill | null;
};
export type AttendanceStatus = "NOT_MARKED" | "PRESENT" | "ABSENT" | "EXCUSED";
export type RosterPlayer = { id: string; name: string };
export type Observation = {
  id: string;
  playerId: string;
  activityId: string | null;
  text: string;
  author: string;
  at: string;
  visibility: "PRIVATE_DRAFT";
};
export type Goal = {
  id: string;
  playerId: string;
  title: string;
  method: string;
  status: "ACTIVE" | "REVIEWED";
  createdAt: string;
  author: string;
};
export type Progress = {
  index: number;
  elapsed: number;
  runningSince: string | null;
};
export type SessionData = {
  title: string;
  batchId: string;
  branchId: string;
  coachId: string;
  localDate: string;
  localTime: string;
  startsAt: string | null;
  timezone: string;
  duration: number;
  objective: string;
  activities: Activity[];
  roster: RosterPlayer[];
  attendance: Record<string, AttendanceStatus>;
  observations: Observation[];
  adjustments: { playerId: string; focus: string; goalId?: string }[];
  progress: Progress;
  actuals: Record<string, "COMPLETED" | "MODIFIED" | "NOT_COMPLETED">;
  recap: string;
};
export type TrainingSession = {
  id: string;
  academyId: string;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  data: SessionData;
  updatedAt: string;
};
export type Batch = {
  id: string;
  name: string;
  branchId: string;
  coachId: string;
};
export type Bootstrap = {
  academy: { id: string; name: string; timezone: string };
  actor: { id: string; name: string; role: string };
  branches: { id: string; name: string }[];
  coaches: { id: string; name: string }[];
  batches: Batch[];
  players: (RosterPlayer & { batchId: string })[];
  drills: Drill[];
  sessions: TrainingSession[];
  favourites: string[];
  goals: Goal[];
  development: boolean;
};
