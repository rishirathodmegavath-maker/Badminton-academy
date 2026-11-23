"use client";
import { useEffect, useRef, useState } from "react";
import {
  Home,
  UserPlus,
  Users,
  CalendarDays,
  Activity,
  ChartNoAxesColumn,
  Apple,
  Video,
  Wallet,
  MessagesSquare,
  Settings,
  ArrowUpRight,
  Plus,
  ChevronRight,
  LogOut,
  Menu,
  BookOpen,
  Layers,
  GitBranch,
  List,
  Check,
  RefreshCw,
  MapPin,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  Bootstrap,
  Drill,
  TrainingSession,
  SessionData,
  Goal,
} from "../domain/types";
import { request, Badge, Modal, ErrorContext } from "./common";
import Library from "./library";
import Builder from "./builder";
import SessionView from "./session";
import CustomDrill from "./custom-drill";
import DrillPreview from "./drill-preview";
import AcademyWorkspace from "../../academy/ui/academy-workspace";
import { academyRequest } from "../../academy/ui/shared";
import { MfaNotice } from "../../identity/ui/mfa-notice";
import { isMembershipCode } from "../../identity/membership-messages";
import {
  classifyDraft,
  clearDraft,
  collectGarbage,
  draftKey,
  listDrafts,
  purgeScope,
  readDraft,
  restoreData,
  writeDraft,
  type DraftScope,
} from "../domain/draft-recovery";
import { OtherDrafts, RecoveryNotice, type OtherDraft, type Recovery } from "./draft-notice";
import { setTraversalHandler, type GuardWindow } from "../../../shell/traversal-guard";
import { usePathname, useRouter } from "next/navigation";
import { AppShell } from "../../../shell/app-shell";
import { AccessDenied, ShellSkeleton } from "../../../shell/states";
import { Toast } from "../../../shell/toast";
import { PHONE_QUERY } from "../../../shell/breakpoints";
import { ENVIRONMENT_NOTICE, formatDate, label as displayLabel } from "../../academy/ui/labels";
import {
  canOpen,
  defaultModule,
  hrefOf,
  isFamilyAccount,
  isStaffAccount,
  labelOfSlug,
  menuModulesForRole,
  MODULE_SUBTITLES,
  slugOfLabel,
  slugOfPath,
  type ModuleSlug,
} from "../../academy/ui/navigation";
import type { AcademyPayload } from "../../academy/application/bootstrap";
import { can } from "../../identity/authority";
const ICONS: Record<ModuleSlug, LucideIcon> = {
  overview: Home,
  admissions: UserPlus,
  players: Users,
  calendar: CalendarDays,
  training: Activity,
  reports: ChartNoAxesColumn,
  nutrition: Apple,
  video: Video,
  fees: Wallet,
  communications: MessagesSquare,
  settings: Settings,
};
type Identity = {
  role: string;
  name: string;
  userId: string;
  academy: { name: string; accent: string | null; logo?: string | null };
};
export default function Studio() {
  const [context, setContext] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const router = useRouter();
  const pathname = usePathname();
  const slug = slugOfPath(pathname);
  const nav = slug ? (labelOfSlug(slug) ?? "") : "";
  const [who, setWho] = useState<Identity | null>(null);
  const go = (label: string) => {
    const next = slugOfLabel(label);
    if (next) router.push(hrefOf(next));
  };
  const [tab, setTab] = useState("Drill library");
  const [selected, setSelected] = useState<TrainingSession | null>(null);
  const [dirty, setDirty] = useState(false);
  const [custom, setCustom] = useState(false);
  const [duplicate, setDuplicate] = useState<Drill | null>(null);
  const [menu, setMenu] = useState(false);
  const [previewDrillId, setPreviewDrillId] = useState("");
  const [trainingPanel, setTrainingPanel] = useState("Library");
  const [focusId, setFocusId] = useState<string | undefined>();
  // A request from the "Batches" group in the menu is used once: leaving Settings forgets it, so coming back later through the
  // ordinary Settings link does not open a form again.
  useEffect(() => {
    if (slug !== "settings") setFocusId((now) => (now?.startsWith("group:Sessions|") ? undefined : now));
  }, [slug]);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [otherDrafts, setOtherDrafts] = useState<OtherDraft[]>([]);
  const [conflict, setConflict] = useState(false);
  // The latest values, for listeners and timers that are registered once and must never read stale state.
  const dirtyRef = useRef(false);
  const selectedRef = useRef<TrainingSession | null>(null);
  const scopeRef = useRef<DraftScope | null>(null);
  /** The person already agreed to leave the page with unsaved edits; do not ask again until they are back on it. */
  const leftRef = useRef(false);
  /** Signing out: no second browser prompt and no recovery copy written on the way out. */
  const exitingRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  /** Identifies this open tab on the recovery copies it writes (see clearDraft). */
  const writerRef = useRef("");
  const writer = () => (writerRef.current ||= crypto.randomUUID());
  dirtyRef.current = dirty;
  selectedRef.current = selected;
  scopeRef.current =
    context && who
      ? { academyId: context.academy.id, userId: who.userId }
      : null;
  const store = () => {
    try {
      return window.localStorage;
    } catch {
      return null; // storage blocked: the guards still work, only the recovery copy is unavailable
    }
  };
  /** Writes the recovery copy of the unsaved edits right now (also called by the page-hide listeners). */
  function flushDraft() {
    clearTimeout(saveTimer.current);
    const s = selectedRef.current;
    const sc = scopeRef.current;
    if (s && sc && dirtyRef.current && !exitingRef.current && s.status === "DRAFT")
      writeDraft(store(), sc, s, Date.now(), writer());
  }
  /** One question for every way of leaving (links, Back/Forward, sign-out); asked at most once per departure. */
  function confirmLeave(intent: "navigate" | "sign-out" = "navigate") {
    const sc = scopeRef.current;
    if (intent === "sign-out") {
      const kept = sc ? listDrafts(store(), sc, Date.now()).length : 0;
      if (!dirtyRef.current && !kept) return true;
      if (
        !window.confirm(
          "Sign out? Unsaved training edits kept on this device will be removed.",
        )
      )
        return false;
      exitingRef.current = true;
      clearTimeout(saveTimer.current);
      if (sc) purgeScope(store(), sc);
      return true;
    }
    if (!dirtyRef.current || leftRef.current) return true;
    flushDraft();
    if (
      !window.confirm(
        "You have unsaved changes to this training session. Leave this page? Your edits stay on this device and can be restored when you come back.",
      )
    )
      return false;
    leftRef.current = true;
    return true;
  }
  async function load() {
    setError("");
    setLoading(true);
    try {
      const identity = await academyRequest<Identity>("/identity");
      if (isFamilyAccount(identity)) {
        window.location.replace("/family");
        return;
      }
      // RC-5: only an account holding `portal.staff` opens the staff workspace (fail closed on anything else; the
      // server refuses such a role too).
      if (!isStaffAccount(identity))
        throw new Error("This role has no workspace access.");
      setWho(identity);
      if (!slugOfPath(window.location.pathname))
        router.replace(hrefOf(defaultModule(identity.role)));
      let result: Bootstrap;
      if (!can(identity, "training.studio")) {
        const academy = await academyRequest<AcademyPayload>();
        result = {
          academy: academy.academy,
          actor: {
            id: academy.actor.id,
            name: academy.actor.name,
            role: academy.actor.role,
          },
          branches: academy.branches,
          batches: academy.batches,
          coaches: [],
          players: [],
          drills: [],
          sessions: [],
          favourites: [],
          goals: [],
          development: academy.development,
        };
      } else result = await request<Bootstrap>();
      setContext(result);
      const id = window.location.hash.slice(1);
      if (id) {
        const session = result.sessions.find((s) => s.id === id);
        if (session) {
          setSelected(session);
          setTab(session.status === "DRAFT" ? "Drill library" : "Session");
          if (session.status === "DRAFT") setTrainingPanel("Builder");
        }
      }
    } catch (e) {
      setError((e as Error).message);
      setErrorCode((e as { code?: string }).code ?? "");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  // Moving to another step starts at the top of the box, so the coach never lands halfway down the next panel.
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    document.querySelector(".training-box")?.scrollIntoView({ block: "start" });
    // The button that was used sits in a panel that is now hidden, so focus moves to the active step.
    document.querySelector<HTMLElement>(".training-steps button.active")?.focus({ preventScroll: true });
  }, [trainingPanel]);
  // A saved session can be reopened by URL: `/training#<session id>`.
  useEffect(() => {
    if (slug === "training" && selected)
      window.history.replaceState(null, "", `/training#${selected.id}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, selected?.id]);
  // Refresh, tab close and leaving the site: the browser asks (it decides the wording), and the edits are kept first.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current || exitingRef.current) return;
      flushDraft();
      e.preventDefault();
      e.returnValue = "";
    };
    const onHide = () => flushDraft();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    // Another tab removed the copy this tab still depends on (for example after saving the same session there): keep it.
    const onStorage = (e: StorageEvent) => {
      const s = selectedRef.current;
      const sc = scopeRef.current;
      if (
        e.newValue === null &&
        s &&
        sc &&
        dirtyRef.current &&
        e.key === draftKey(sc, s.id)
      )
        flushDraft();
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Browser Back / Forward inside the app (links and sign-out are guarded by the shell, see `guard` below).
  useEffect(() => {
    return setTraversalHandler(window as unknown as GuardWindow, {
      shouldBlock: (from, to) =>
        dirtyRef.current && !leftRef.current && from !== to,
      confirmLeave: () => confirmLeave("navigate"),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Back on the page (or nothing left to lose): the next departure is a new question.
  useEffect(() => {
    if (slug === "training" || !dirty) leftRef.current = false;
  }, [slug, dirty]);
  // While there are unsaved edits, keep a recovery copy on this device a moment after each change.
  useEffect(() => {
    if (!dirty || !selected) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushDraft, 250);
    return () => clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, dirty]);
  // Offer kept edits back to the same person, in the same academy, for sessions they can still see.
  useEffect(() => {
    const sc = scopeRef.current;
    if (!context || !sc || dirty) return;
    const storage = store();
    const now = Date.now();
    collectGarbage(storage, now);
    const visible = new Map(context.sessions.map((s) => [s.id, s]));
    const others: OtherDraft[] = [];
    let current: Recovery | null = null;
    for (const record of listDrafts(storage, sc, now)) {
      const server = visible.get(record.sessionId);
      if (!server) {
        clearDraft(storage, sc, record.sessionId); // not (or no longer) this person's session: never offered
        continue;
      }
      const verdict = classifyDraft(record, server);
      if (verdict === "identical") {
        clearDraft(storage, sc, record.sessionId); // nothing differs from what is saved: nothing to lose
        continue;
      }
      if (record.sessionId === selected?.id)
        current = {
          record,
          verdict,
          title: record.draft.title || server.data.title,
          serverVersion: server.version,
        };
      else
        others.push({
          sessionId: record.sessionId,
          title: record.draft.title,
          savedAt: record.savedAt,
        });
    }
    setRecovery(current);
    setOtherDrafts(others);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context?.sessions, context?.academy.id, who?.userId, selected?.id, dirty]);
  function restoreRecovery() {
    if (!recovery || !context) return;
    const server = context.sessions.find(
      (s) => s.id === recovery.record.sessionId,
    );
    if (!server || server.status !== "DRAFT") return;
    if (
      recovery.verdict === "stale" &&
      !window.confirm(
        "Your edits were made on an older saved version. Saving them will replace the newer saved changes. Restore them anyway?",
      )
    )
      return;
    const restored = {
      ...server,
      data: restoreData(server, recovery.record, context.drills),
    };
    setSelected(restored);
    setDirty(true);
    // From now on this tab owns the copy (and it is based on the version being edited, so it is no longer "stale").
    const sc = scopeRef.current;
    if (sc) writeDraft(store(), sc, restored, Date.now(), writer());
    setTab("Drill library");
    setTrainingPanel("Builder");
    setRecovery(null);
    setNotice("Your unsaved edits were restored. Save the draft to keep them.");
  }
  function discardRecovery() {
    const sc = scopeRef.current;
    if (!recovery || !sc) return;
    if (
      !window.confirm(
        "Discard these unsaved edits from this device? This cannot be undone.",
      )
    )
      return;
    clearDraft(store(), sc, recovery.record.sessionId);
    setRecovery(null);
  }
  function discardEdits() {
    const s = selectedRef.current;
    const sc = scopeRef.current;
    if (!s || !sc || !context) return;
    if (
      !window.confirm(
        "Discard your unsaved edits and return to the last saved version?",
      )
    )
      return;
    clearDraft(store(), sc, s.id);
    const saved = context.sessions.find((x) => x.id === s.id);
    if (saved) setSelected(saved);
    setDirty(false);
    setConflict(false);
    setError("");
    setNotice("Unsaved edits discarded.");
  }
  /** After a conflict: keep the person's edits but base them on the latest saved version (an explicit overwrite). */
  function keepEditsOnLatest() {
    const s = selectedRef.current;
    const latest = context?.sessions.find((x) => x.id === s?.id);
    if (!s || !latest || latest.status !== "DRAFT") return;
    if (
      !window.confirm(
        "Put your edits on top of the latest saved version? Saving will replace the newer saved changes.",
      )
    )
      return;
    setSelected({
      ...latest,
      data: {
        ...latest.data,
        ...s.data,
        timezone: latest.data.timezone,
        roster: latest.data.roster,
        attendance: latest.data.attendance,
        observations: latest.data.observations,
        progress: latest.data.progress,
        actuals: latest.data.actuals,
        recap: latest.data.recap,
        startsAt: latest.data.startsAt,
      },
    });
    setDirty(true);
    setConflict(false);
    setError("");
  }
  async function execute<T>(
    path: string,
    body: unknown,
  ): Promise<T | undefined> {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      return await request<T>(path, body);
    } catch (e) {
      setError((e as Error).message);
      if ((e as { status?: number }).status === 409) {
        // Another tab or person saved first: keep the edits on screen and learn what is saved now.
        setConflict(true);
        flushDraft(); // whatever happened to the copy meanwhile, the refused edits are kept
        void request<Bootstrap>()
          .then(setContext)
          .catch(() => {});
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  function replace(saved: TrainingSession) {
    setContext((c) =>
      c
        ? {
            ...c,
            sessions: [saved, ...c.sessions.filter((s) => s.id !== saved.id)],
          }
        : c,
    );
    setSelected(saved);
    setDirty(false);
  }
  async function mutate(
    id: string,
    version: number,
    action: string,
    payload?: unknown,
  ) {
    const saved = await execute<TrainingSession>(`/sessions/${id}`, {
      version,
      action,
      payload,
    });
    if (saved) {
      // Confirmed by the server: the recovery copy of this session has done its job.
      const sc = scopeRef.current;
      if (sc && saved.id === id) clearDraft(store(), sc, id, writer());
      setConflict(false);
      replace(saved);
      setNotice(
        action === "save"
          ? "Draft saved."
          : action === "attendance"
            ? "Attendance saved."
            : action === "note"
              ? "Private observation saved."
              : action === "publish"
                ? "Session published. Ready to coach."
                : action === "complete"
                  ? "Session completed. Plan and actuals preserved."
                  : action === "duplicate"
                    ? "Plan copied to a new draft."
                    : action === "start"
                      ? "Session started. Attendance is still unmarked."
                      : "Session updated.",
      );
      if (action === "publish" || action === "start" || action === "complete")
        setTab("Session");
      if (action === "duplicate") {
        setTab("Drill library");
        setTrainingPanel("Builder");
      }
    }
    return saved;
  }
  /** `stay`: the new draft was started by adding a drill, so the coach keeps exploring (phones still go to the session). */
  async function newSession(opts?: { stay?: boolean }) {
    if (dirty) {
      flushDraft();
      if (
        !window.confirm(
          "Leave this draft and create a new one? Your unsaved edits stay on this device and can be restored when you reopen it.",
        )
      )
        return;
    }
    const created = await execute<TrainingSession>("/sessions", {});
    if (created) {
      replace(created);
      go("Training");
      setTab("Drill library");
      if (opts?.stay !== true) setTrainingPanel("Builder");
      return created;
    }
  }
  function choose(session: TrainingSession) {
    if (dirty) {
      flushDraft();
      if (
        !window.confirm(
          "Leave this draft and open another session? Your unsaved edits stay on this device and can be restored when you reopen it.",
        )
      )
        return;
    }
    replace(session);
    setTab(session.status === "DRAFT" ? "Drill library" : "Session");
    if (session.status === "DRAFT") setTrainingPanel("Builder");
    go("Training");
  }
  function updateData(data: SessionData) {
    if (!selected) return;
    setSelected({ ...selected, data });
    setDirty(true);
  }
  async function refreshTraining() {
    if (context && can(context.actor, "training.studio")) {
      try {
        const fresh = await request<Bootstrap>();
        setContext(fresh);
        if (selected && !dirty) {
          const saved = fresh.sessions.find((s) => s.id === selected.id);
          if (saved) setSelected(saved);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    }
  }
  async function openTrainingSession(id: string) {
    try {
      const fresh = await request<Bootstrap>();
      setContext(fresh);
      const saved = fresh.sessions.find((s) => s.id === id);
      if (saved) choose(saved);
      else setError("This training session is unavailable to your role.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function add(drill: Drill, intentional = false) {
    if (recovery && recovery.verdict !== "obsolete") {
      setNotice("Restore or discard your recovered edits before changing this draft.");
      return;
    }
    if (
      selected?.status === "DRAFT" &&
      selected.data.activities.some((a) => a.drillId === drill.id) &&
      !intentional
    ) {
      setDuplicate(drill);
      return;
    }
    const session =
      selected?.status === "DRAFT" ? selected : await newSession({ stay: true });
    if (!session) return;
    setSelected({
      ...session,
      data: {
        ...session.data,
        activities: [
          ...session.data.activities,
          {
            id: crypto.randomUUID(),
            drillId: drill.id,
            drillVersion: drill.version,
            title: drill.title,
            minutes: drill.minutes,
            cues: drill.cues[0] ?? "",
            snapshot: drill,
          },
        ],
      },
    });
    setDirty(true);
    setNotice(`${drill.title} added to your draft.`);
    setDuplicate(null);
    // On a phone one panel shows at a time, so the session opens (as before); on larger screens the coach keeps exploring
    // and the "Your session" bar shows what has been added.
    if (window.matchMedia(PHONE_QUERY).matches) setTrainingPanel("Builder");
  }
  async function favourite(drillId: string, value: boolean) {
    const saved = await execute("/favourites", { drillId, selected: value });
    if (saved)
      setContext((c) =>
        c
          ? {
              ...c,
              favourites: value
                ? [...c.favourites, drillId]
                : c.favourites.filter((id) => id !== drillId),
            }
          : c,
      );
  }
  if (loading)
    return (
      <main className="loading" role="status">
        <span className="loader" />
        Opening your coaching workspace…
      </main>
    );
  if (!context || !who)
    return (
      <main className="loading">
        <h1>Workspace unavailable</h1>
        <p className="error" role="alert">
          {error}
        </p>
        {/* A membership problem is already explained by the server's own sentence; the database hint is only for other failures. */}
        {!isMembershipCode(errorCode) && (
          <p>Check the database setup and your academy membership.</p>
        )}
        <div className="button-row">
          <button className="primary" onClick={load}>
            Try again
          </button>
          <a className="secondary" href="/login">
            Sign in
          </a>
        </div>
      </main>
    );
  const editing = selected?.status === "DRAFT";
  const previewDrill =
    context.drills.find((d) => d.id === previewDrillId) ?? context.drills[0];
  const cycleDrill = (delta: number) => {
    const current = context.drills.findIndex((d) => d.id === previewDrill?.id);
    setPreviewDrillId(
      context.drills[
        (current + delta + context.drills.length) % context.drills.length
      ]?.id ?? "",
    );
  };
  return (
    <ErrorContext.Provider value={error}>
      <AppShell
        product="Academy workspace"
        homeHref={hrefOf(defaultModule(who.role))}
        academy={{
          name: who.academy.name,
          accent: who.academy.accent,
          logo: who.academy.logo,
          subtitle: "Academy workspace",
        }}
        user={{ name: who.name, role: who.role }}
        items={menuModulesForRole(who.role).flatMap((s) => {
          const item = { key: s, label: labelOfSlug(s) ?? s, icon: ICONS[s], href: hrefOf(s) };
          // Right after Calendar: a collapsible "Batches" group for the branch and batch steps that used to be found only
          // inside Settings. The buttons open the same Settings pane and the same forms; what a person may do there is
          // still decided by the server, and the group is offered only to those who may manage branches and batches.
          if (s === "calendar" && canOpen(who.role, "settings") && context && can(context.actor, "academy.structure"))
            return [
              item,
              {
                key: "batches",
                label: "Batches",
                icon: Layers,
                children: [
                  { key: "batches:list", label: "Branches & batches", icon: List },
                  { key: "batches:branch", label: "Create branch", icon: GitBranch },
                  { key: "batches:batch", label: "Create batch", icon: Plus },
                ],
              },
            ];
          return [item];
        })}
        onSelect={(key) => {
          const step = key.startsWith("batches:") ? key.slice(8) : "";
          if (!step) return;
          setFocusId(`group:Sessions|${step}|${Date.now()}`);
          go("Settings");
        }}
        activeKey={slug ?? ""}
        guard={(intent) => confirmLeave(intent)}
        breadcrumb={["Workspace", nav || "Opening"]}
        mainClassName={nav === "Overview" ? "ax-main-overview" : ""}
        headerExtras={
          <>
            {/* The Players page has its own search, so the header one is shown everywhere else. It only opens that
                page with the text typed; which players are listed is still decided by the server. */}
            {canOpen(who.role, "players") && slug !== "players" && (
              <form
                className="ax-search"
                role="search"
                onSubmit={(e) => {
                  e.preventDefault();
                  const typed = String(new FormData(e.currentTarget).get("q") ?? "")
                    .replaceAll("|", " ")
                    .trim();
                  if (!typed || !confirmLeave()) return;
                  setFocusId(`search:${typed}`);
                  go("Players");
                }}
              >
                <label className="sr-only" htmlFor="ax-player-search">
                  Find a player
                </label>
                <input id="ax-player-search" name="q" type="search" placeholder="Find a player" maxLength={80} autoComplete="off" />
              </form>
            )}
            {context.development && (
              <span className="ax-pill">
                <ShieldCheck size={14} aria-hidden="true" />
                {ENVIRONMENT_NOTICE}
              </span>
            )}
            {context.branches[0]?.name && (
              <span className="ax-pill ax-pill-place">
                <MapPin size={14} aria-hidden="true" />
                {context.branches[0].name}
              </span>
            )}
          </>
        }
      >
        <div className="page-heading">
          <div>
            <span className="eyebrow">
              Plan with purpose. Coach with confidence.
            </span>
            <h1>{nav === "Training" ? "Training Studio" : nav}</h1>
            <p>
              {slugOfLabel(nav)
                ? MODULE_SUBTITLES[slugOfLabel(nav) as ModuleSlug]
                : ""}
            </p>
          </div>
          {nav === "Training" && (
            <button className="primary" disabled={busy} onClick={() => void newSession()}>
              <Plus size={18} />
              Create session
            </button>
          )}
        </div>
        <MfaNotice />
        {error && (
          <div className="error global-alert" role="alert">
            <span>{error}</span>
            {conflict &&
              dirty &&
              context.sessions.some(
                (x) =>
                  x.id === selected?.id &&
                  x.status === "DRAFT" &&
                  x.version !== selected.version,
              ) && (
                <button className="text-button" onClick={keepEditsOnLatest}>
                  Keep my edits on the latest version
                </button>
              )}
            <button
              className="text-button"
              onClick={() => {
                if (
                  !dirty ||
                  window.confirm("Discard unsaved edits and reload saved data?")
                ) {
                  const sc = scopeRef.current;
                  if (dirty && sc && selected)
                    clearDraft(store(), sc, selected.id);
                  setDirty(false);
                  setConflict(false);
                  void load();
                }
              }}
            >
              <RefreshCw size={14} />
              Reload saved data
            </button>
          </div>
        )}
        <Toast message={notice} icon={<Check size={15} aria-hidden="true" />} onDismiss={() => setNotice("")} />
        {busy && (
          <div role="status" className="saving-status">
            Saving…
          </div>
        )}
        {!slug ? (
          <ShellSkeleton />
        ) : !canOpen(who.role, slug) ? (
          <AccessDenied module={nav} home={hrefOf(defaultModule(who.role))} />
        ) : nav === "Training" && !can(context.actor, "training.studio") ? (
          <div className="notice">
            Training Studio requires coaching staff access. Select an authorised
            module from the sidebar.
          </div>
        ) : nav === "Training" ? (
          <>
            {recovery && (
              <RecoveryNotice
                recovery={recovery}
                onRestore={restoreRecovery}
                onDiscard={discardRecovery}
              />
            )}
            <OtherDrafts
              items={otherDrafts}
              onOpen={(id) => {
                const s = context.sessions.find((x) => x.id === id);
                if (s) choose(s);
              }}
            />
            <div className="training-tabs">
              <div className="tabs">
                {[
                  "Today",
                  "Weekly planner",
                  "Drill library",
                  "Player development",
                  "History",
                ].map((t) => (
                  <button
                    key={t}
                    className={tab === t ? "active" : ""}
                    onClick={() => setTab(t)}
                  >
                    {t}
                  </button>
                ))}
                {tab === "Session" && (
                  <button className="active">Session</button>
                )}
              </div>
              <span className="private-label">
                <ShieldCheck size={13} />
                Private academy workspace
              </span>
            </div>
            {tab === "Drill library" ? (
              <div className={`training-box step-${trainingPanel.toLowerCase()}`}>
                <ol className="training-steps" aria-label="Training workspace steps">
                  {[
                    ["Library", "Explore"],
                    ["Preview", "Drill details"],
                    ["Builder", "Session"],
                  ].map(([panel, label], i) => (
                    <li key={panel}>
                      <button
                        type="button"
                        className={trainingPanel === panel ? "active" : ""}
                        aria-current={trainingPanel === panel ? "step" : undefined}
                        onClick={() => setTrainingPanel(panel)}
                      >
                        <span className="step-number" aria-hidden="true">
                          {i + 1}
                        </span>
                        {label}
                      </button>
                    </li>
                  ))}
                </ol>
                <div className="training-step-panel" hidden={trainingPanel !== "Library"}>
                <Library
                  drills={context.drills}
                  favourites={context.favourites}
                  onFavourite={favourite}
                  onAdd={add}
                  onCustom={() => setCustom(true)}
                  selectedId={previewDrill?.id}
                  onPreview={(drill) => {
                    setPreviewDrillId(drill.id);
                    setTrainingPanel("Preview");
                  }}
                />
                </div>
                <div className="training-step-panel" hidden={trainingPanel !== "Preview"}>
                <DrillPreview
                  drill={previewDrill}
                  onBack={() => setTrainingPanel("Library")}
                  onAdd={add}
                  onPrevious={() => cycleDrill(-1)}
                  onNext={() => cycleDrill(1)}
                />
                </div>
                <div className="training-step-panel" hidden={trainingPanel !== "Builder"}>
                {editing ? (
                  <Builder
                    key={selected.id}
                    session={selected}
                    context={context}
                    onChange={updateData}
                    mutate={mutate}
                    busy={
                      busy || (!!recovery && recovery.verdict !== "obsolete")
                    }
                    dirty={dirty}
                    onDiscard={discardEdits}
                    onLibrary={() => setTrainingPanel("Library")}
                  />
                ) : (
                  <aside className="builder unstarted">
                    <div className="builder-title">
                      <span className="eyebrow">Session builder</span>
                      <Layers size={18} />
                    </div>
                    <div>
                      <span className="builder-illustration">
                        <BookOpen size={40} />
                      </span>
                      <h2>
                        Good coaching.
                        <br />A little more organised.
                      </h2>
                      <p>
                        Bring your favourite drills together into a session that
                        works for your players.
                      </p>
                      <button
                        className="primary full"
                        disabled={busy}
                        onClick={() => void newSession()}
                      >
                        <Plus size={17} />
                        Build a session
                      </button>
                      <span className="muted">
                        Or add a drill to get started.
                      </span>
                    </div>
                    <div className="builder-tips">
                      <span>
                        <Check size={15} />
                        Make a plan, refine it as you go
                      </span>
                      <span>
                        <Check size={15} />
                        Keep individual focus optional
                      </span>
                      <span>
                        <Check size={15} />
                        Save now, come back anytime
                      </span>
                    </div>
                    {selected && (
                      <button
                        className="secondary full"
                        onClick={() => setTab("Session")}
                      >
                        Return to {selected.data.title || "session"}
                        <ArrowUpRight size={15} />
                      </button>
                    )}
                  </aside>
                )}
                </div>
                {editing && trainingPanel !== "Builder" && (
                  <section className="training-session-bar" aria-label="Your session">
                    <span>
                      <strong>Your session</strong>
                      <span className="muted">
                        {selected.data.activities.length}{" "}
                        {selected.data.activities.length === 1 ? "drill" : "drills"} added
                      </span>
                    </span>
                    <button type="button" className="primary" onClick={() => setTrainingPanel("Builder")}>
                      Open session
                    </button>
                  </section>
                )}
              </div>
            ) : tab === "Today" ||
              tab === "Weekly planner" ||
              tab === "History" ? (
              <SessionCollection
                mode={tab}
                context={context}
                choose={choose}
                create={() => newSession()}
              />
            ) : tab === "Player development" ? (
              <Development
                key={focusId}
                initialPlayerId={focusId}
                context={context}
                busy={busy}
                save={async (body) => {
                  const goal = await execute<Goal>("/goals", body);
                  if (goal) {
                    setContext((c) =>
                      c
                        ? {
                            ...c,
                            goals: [
                              goal,
                              ...c.goals.filter((g) => g.id !== goal.id),
                            ],
                          }
                        : c,
                    );
                    setNotice("Player goal saved.");
                    return true;
                  }
                  return false;
                }}
              />
            ) : selected ? (
              <SessionView
                key={selected.id}
                session={selected}
                context={context}
                mutate={mutate}
                busy={busy}
                onEdit={() => setTab("Drill library")}
              />
            ) : null}
          </>
        ) : (
          <AcademyWorkspace
            key={nav}
            module={nav}
            focusId={focusId}
            nav={(name, id) => {
              if (name === "Training" && id === "new-session") {
                void newSession();
                return;
              }
              if (name === "Training" && id?.startsWith("development:")) {
                setFocusId(id.slice(12));
                setTab("Player development");
                go("Training");
                return;
              }
              setFocusId(id);
              go(name);
            }}
            onSession={(id) => void openTrainingSession(id)}
            onChange={() => void refreshTraining()}
          />
        )}
        <footer className="workspace-footer">
          <span>
            Sportozen <i />
            Built around the way you coach.
          </span>
          <span>Academy workspace · Private records</span>
        </footer>
      </AppShell>
      {custom && (
        <CustomDrill
          busy={busy}
          close={() => setCustom(false)}
          save={async (body) => {
            const drill = await execute<Drill>("/drills", body);
            if (drill) {
              setContext((c) =>
                c ? { ...c, drills: [...c.drills, drill] } : c,
              );
              setNotice("Private drill created. Coaching review pending.");
              return true;
            }
            return false;
          }}
        />
      )}
      {duplicate && (
        <Modal title="Add this drill again?" onClose={() => setDuplicate(null)}>
          <p>
            {duplicate.title} is already in the plan. Add a separate activity
            for another round?
          </p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setDuplicate(null)}>
              Keep one
            </button>
            <button className="primary" onClick={() => add(duplicate, true)}>
              Add another round
            </button>
          </div>
        </Modal>
      )}
    </ErrorContext.Provider>
  );
}
function SessionCollection({
  mode,
  context,
  choose,
  create,
}: {
  mode: string;
  context: Bootstrap;
  choose: (s: TrainingSession) => void;
  create: () => void;
}) {
  const [branch, setBranch] = useState("");
  const [batch, setBatch] = useState("");
  const [coach, setCoach] = useState("");
  const [date, setDate] = useState(() =>
    new Date().toLocaleDateString("en-CA", {
      timeZone: context.academy.timezone,
    }),
  );
  const [status, setStatus] = useState("");
  const start = new Date(`${date}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + i);
    return day.toISOString().slice(0, 10);
  });
  const sessions = context.sessions.filter(
    (s) =>
      (!branch || s.data.branchId === branch) &&
      (!batch || s.data.batchId === batch) &&
      (!coach || s.data.coachId === coach) &&
      (!status || s.status === status) &&
      (mode === "History" ||
        (mode === "Today"
          ? s.data.localDate === date
          : days.includes(s.data.localDate))),
  );
  return (
    <section className="collection">
      <div className="section-heading">
        <div>
          <span className="eyebrow">
            {mode === "History"
              ? "Past plans, future possibilities"
              : mode === "Weekly planner"
                ? "The week ahead"
                : "Your sessions, ready to coach"}
          </span>
          <h2>
            {mode === "Today"
              ? "Make today count."
              : mode === "Weekly planner"
                ? "A little perspective on the week."
                : "Every session has a story."}
          </h2>
          <p>
            {mode === "History"
              ? "Open any saved session to review or duplicate its plan. Copies never include actual results."
              : `Scheduled in ${context.academy.timezone}. Drafts stay flexible.`}
          </p>
        </div>
      </div>
      <div className="collection-filters">
        <label>
          {mode === "Weekly planner" ? "Week containing" : "Date"}
          <input
            type="date"
            value={date}
            onChange={(e) => {
              if (e.target.value) setDate(e.target.value);
            }}
            disabled={mode === "History"}
          />
        </label>
        <label>
          Branch
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option value="">All branches</option>
            {context.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Batch
          <select value={batch} onChange={(e) => setBatch(e.target.value)}>
            <option value="">All batches</option>
            {context.batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Coach
          <select value={coach} onChange={(e) => setCoach(e.target.value)}>
            <option value="">All coaches</option>
            {context.coaches.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {[
              "DRAFT",
              "PUBLISHED",
              "IN_PROGRESS",
              "COMPLETED",
              "CANCELLED",
            ].map((s) => (
              <option key={s} value={s}>
                {displayLabel(s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {mode === "Weekly planner" ? (
        <div className="week-grid">
          {days.map((day) => (
            <section key={day}>
              <h3>
                {new Date(`${day}T12:00:00Z`).toLocaleDateString("en-IN", {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  timeZone: "UTC",
                })}
              </h3>
              {sessions
                .filter((s) => s.data.localDate === day)
                .map((s) => (
                  <SessionCard
                    key={s.id}
                    session={s}
                    context={context}
                    choose={choose}
                  />
                ))}
              {!sessions.some((s) => s.data.localDate === day) && (
                <p className="muted">No session scheduled</p>
              )}
            </section>
          ))}
        </div>
      ) : (
        <div className="session-card-grid">
          {sessions.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              context={context}
              choose={choose}
            />
          ))}
        </div>
      )}
      {!sessions.length && mode !== "Weekly planner" && (
        <div className="empty">
          <CalendarDays size={36} />
          <h3>
            {mode === "History"
              ? "Your saved sessions will live here."
              : "A fresh page for today."}
          </h3>
          <p>
            Create a session, or change the date and filters to find an existing
            plan.
          </p>
          <button className="primary" onClick={create}>
            <Plus size={16} />
            Create session
          </button>
        </div>
      )}
    </section>
  );
}
function SessionCard({
  session: s,
  context,
  choose,
}: {
  session: TrainingSession;
  context: Bootstrap;
  choose: (s: TrainingSession) => void;
}) {
  return (
    <button className="session-card" onClick={() => choose(s)}>
      <div>
        <span>
          {formatDate(s.data.localDate) || "Unscheduled"} ·{" "}
          {s.data.localTime || "Time not set"}
        </span>
        <Badge status={s.status} />
      </div>
      <h3>{s.data.title || "Untitled draft"}</h3>
      <p>
        {context.batches.find((b) => b.id === s.data.batchId)?.name ||
          "Batch not set"}
      </p>
      <p>
        {context.coaches.find((c) => c.id === s.data.coachId)?.name} ·{" "}
        {s.data.duration} min
      </p>
      <div className="session-card-bottom">
        <span>{s.data.activities.length} activities</span>
        <strong>
          {s.status === "DRAFT"
            ? "Continue planning"
            : s.status === "PUBLISHED"
              ? "Open session"
              : s.status === "IN_PROGRESS"
                ? "Resume coaching"
                : "View record"}
          <ChevronRight size={15} />
        </strong>
      </div>
    </button>
  );
}
function Development({
  initialPlayerId,
  context,
  busy,
  save,
}: {
  initialPlayerId?: string;
  context: Bootstrap;
  busy: boolean;
  save: (body: unknown) => Promise<boolean>;
}) {
  const [playerId, setPlayerId] = useState(
    context.players.find((p) => p.id === initialPlayerId)?.id ??
      context.players[0]?.id ??
      "",
  );
  const [title, setTitle] = useState("");
  const [method, setMethod] = useState("");
  const notes = context.sessions.flatMap((s) =>
    s.data.observations
      .filter((n) => n.playerId === playerId)
      .map((n) => ({ ...n, session: s })),
  );
  return (
    <section className="development">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Small steps. Lasting progress.</span>
          <h2>Keep the player in focus.</h2>
          <p>Goals give direction. Recorded observations give context.</p>
        </div>
        <label>
          Player
          <select
            value={playerId}
            onChange={(e) => setPlayerId(e.target.value)}
          >
            {context.players.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="development-grid">
        <div className="panel">
          <h3>Player goals</h3>
          {context.goals
            .filter((g) => g.playerId === playerId)
            .map((g) => (
              <article className="goal-card" key={g.id}>
                <span className="tag">{g.status.toLowerCase()}</span>
                <h3>{g.title}</h3>
                <p>Assessment method: {g.method}</p>
                <small>
                  {g.author} · Created {formatDate(g.createdAt)}
                </small>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    save({
                      ...g,
                      status: g.status === "ACTIVE" ? "REVIEWED" : "ACTIVE",
                    })
                  }
                >
                  {g.status === "ACTIVE" ? "Mark reviewed" : "Make active"}
                  <Check size={14} />
                </button>
              </article>
            ))}
          {!context.goals.some((g) => g.playerId === playerId) && (
            <p className="muted">
              No goals recorded. Start with one clear focus.
            </p>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await save({ playerId, title, method, status: "ACTIVE" })) {
                setTitle("");
                setMethod("");
              }
            }}
          >
            <fieldset disabled={busy}>
              <label>
                New goal
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  minLength={2}
                  maxLength={200}
                  placeholder="e.g. Recover to base with balance"
                />
              </label>
              <label>
                How will it be assessed?
                <textarea
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  required
                  minLength={3}
                  maxLength={500}
                  placeholder="Describe the task, conditions and observation method."
                />
              </label>
              <button className="primary" disabled={!playerId}>
                Add goal
              </button>
            </fieldset>
          </form>
        </div>
        <div className="panel">
          <h3>Coach evidence</h3>
          {notes.map((n) => (
            <article className="observation" key={n.id}>
              <strong>{n.session.data.title}</strong>
              <p>{n.text}</p>
              <small>
                {n.author} · {n.at.slice(0, 10)} · Private draft
              </small>
            </article>
          ))}
          {!notes.length && (
            <div className="empty compact">
              <BookOpen size={28} />
              <h3>No observations recorded yet.</h3>
              <p>
                Missing evidence is not poor performance. Add optional notes
                while coaching.
              </p>
            </div>
          )}
          <div className="notice">
            No overall scores are generated. Qualitative observations are shown
            in context; family practice and measured assessments are not
            implemented.
          </div>
        </div>
      </div>
    </section>
  );
}
