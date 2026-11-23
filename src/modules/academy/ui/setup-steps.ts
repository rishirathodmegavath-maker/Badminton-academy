import type { AcademyPayload } from "../application/bootstrap";
import { can } from "../../identity/authority";

/**
 * The first-run checklist on the Overview (UX W5). Derived only from what the academy payload already holds, so it adds
 * no request and no field. A step is offered only to a person who may do it (the same capabilities the server checks
 * when they try); once every offered step is done the checklist disappears by itself.
 */
export type SetupStep = {
  key: "batch" | "team" | "players" | "session";
  label: string;
  hint: string;
  done: boolean;
  action: string;
  /** The module to open and the optional hint the module reads (see `nav` in the studio). */
  module: string;
  focus?: string;
};

export function setupSteps(d: AcademyPayload): SetupStep[] {
  const steps: (SetupStep & { allowed: boolean })[] = [
    {
      key: "batch",
      label: "Create a batch",
      hint: "A batch groups players by level or age, so every session has a roster.",
      done: d.batches.length > 0,
      action: "Open Settings",
      module: "Settings",
      focus: "group:Sessions",
      allowed: d.permissions.ops,
    },
    {
      key: "team",
      label: "Invite your coaches",
      hint: "Each coach signs in with their own invitation.",
      done: d.members.filter((m) => m.active).length > 1,
      action: "Open invitations",
      module: "Settings",
      focus: "group:Team",
      allowed: can(d.actor, "members.manage"),
    },
    {
      key: "players",
      label: "Add your first players",
      hint: "Add players under 18 with a date of birth, then link their parents.",
      done: d.players.length > 0,
      action: "Open Players",
      module: "Players",
      allowed: d.permissions.ops,
    },
    {
      key: "session",
      label: "Create your first session",
      hint: "Plan a training session from the drill library.",
      done: d.sessions.length > 0 || d.events.length > 0,
      action: "Create session",
      module: "Training",
      focus: "new-session",
      allowed: d.permissions.coaching,
    },
  ];
  const offered: SetupStep[] = steps
    .filter((s) => s.allowed)
    .map((s) => ({ key: s.key, label: s.label, hint: s.hint, done: s.done, action: s.action, module: s.module, focus: s.focus }));
  return offered.every((s) => s.done) ? [] : offered;
}
