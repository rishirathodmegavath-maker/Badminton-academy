/**
 * Guards browser Back / Forward inside the Next.js App Router.
 *
 * Why this exists: the App Router listens to `popstate` itself and swaps the page without ever asking the application,
 * and a traversal cannot be cancelled before it happens. Links and sign-out are guarded by the shell's `guard`, and a
 * real unload by `beforeunload`; an in-app Back/Forward press reached neither.
 *
 * How it works (no history entries are added, so nothing can loop or pile up):
 *  1. The Navigation API's `navigate` event tells us, before the browser moves, which history entries are involved
 *     (`destination.index` and the current index) and whether the move stays in this document.
 *  2. Our `popstate` listener runs before the router's, because it is registered first (see installEarlyTraversalGuard:
 *     DOM order is registration order for listeners on `window`). If the move should be guarded we stop the event so the
 *     router never sees it, and ask the person.
 *  3. Stay: `history.go(-delta)` puts the browser back on the entry it was on. That second traversal is recognised and
 *     swallowed too, so the router never knew anything happened (same page, same state, same scroll).
 *  4. Leave: the stopped `popstate` is dispatched again for the router (marked so we let it through) and it navigates
 *     exactly as it would have.
 * Cross-document moves (leaving the site) never fire `popstate`; `beforeunload` is the only mechanism for those.
 * Browsers without the Navigation API cannot be guarded this way: the move proceeds unguarded (callers keep a recovery
 * copy of the draft for exactly that case).
 */
export type NavigationEntryLike = { index: number; url: string | null };
type NavigateEventLike = Event & {
  navigationType?: string;
  destination?: { index: number; url: string; sameDocument: boolean };
};
export type GuardWindow = EventTarget & {
  history: Pick<History, "go" | "state">;
  location: Pick<Location, "href">;
  navigation?: EventTarget & { currentEntry: NavigationEntryLike | null };
  PopStateEvent: typeof PopStateEvent;
};
export type TraversalGuardOptions = {
  /** Called at the moment of a same-document Back/Forward; return true when the move must be confirmed first. */
  shouldBlock: (fromPath: string, toPath: string) => boolean;
  /** Ask the person; true = leave, false = stay. */
  confirmLeave: () => boolean;
  /** Runs once when the person chose to leave (before the router handles the move). */
  onLeave?: () => void;
};

const pathOf = (url: string, base: string) => {
  try {
    return new URL(url, base).pathname;
  } catch {
    return "";
  }
};

export function installTraversalGuard(
  win: GuardWindow,
  options: TraversalGuardOptions,
) {
  const nav = win.navigation;
  if (!nav) return { supported: false, uninstall() {} };

  let pending: { delta: number; from: string; to: string } | null = null;
  let restoring = 0;
  let replaying = false;

  const onNavigate = (event: Event) => {
    const e = event as NavigateEventLike;
    const from = nav.currentEntry;
    if (
      e.navigationType !== "traverse" ||
      !e.destination?.sameDocument ||
      !from
    ) {
      pending = null;
      return;
    }
    pending = {
      delta: e.destination.index - from.index,
      from: pathOf(win.location.href, win.location.href),
      to: pathOf(e.destination.url, win.location.href),
    };
  };

  const onPopState = (event: Event) => {
    if (replaying) return; // our own re-dispatch: the router must see it
    const move = pending;
    pending = null;
    if (restoring > 0) {
      restoring--;
      event.stopImmediatePropagation(); // the undo of a cancelled move: invisible to the router
      return;
    }
    if (!move || move.delta === 0 || !options.shouldBlock(move.from, move.to))
      return;
    event.stopImmediatePropagation();
    if (options.confirmLeave()) {
      options.onLeave?.();
      replaying = true;
      try {
        win.dispatchEvent(
          new win.PopStateEvent("popstate", { state: win.history.state }),
        );
      } finally {
        replaying = false;
      }
    } else {
      restoring++;
      win.history.go(-move.delta);
    }
  };

  nav.addEventListener("navigate", onNavigate);
  win.addEventListener("popstate", onPopState, true);
  return {
    supported: true,
    uninstall() {
      nav.removeEventListener("navigate", onNavigate);
      win.removeEventListener("popstate", onPopState, true);
    },
  };
}

/**
 * Ordering matters: the guard must see `popstate` BEFORE the router does, and the router registers its own listener when
 * it mounts. So the guard is installed once, very early (src/instrumentation-client.ts runs before hydration), and the
 * screen that owns unsaved work only registers/unregisters a handler for it. With no handler registered every move
 * passes through untouched.
 */
export type TraversalHandler = Pick<
  TraversalGuardOptions,
  "shouldBlock" | "confirmLeave" | "onLeave"
>;
type HandlerHost = GuardWindow & {
  __sportozenTraversal?: {
    handler: TraversalHandler | null;
    installed: boolean;
  };
};
const registry = (win: HandlerHost) =>
  (win.__sportozenTraversal ??= { handler: null, installed: false });

export function installEarlyTraversalGuard(win: GuardWindow) {
  const host = registry(win as HandlerHost);
  if (host.installed) return; // hot reload or a second import: one guard only
  host.installed = true;
  installTraversalGuard(win, {
    shouldBlock: (from, to) => host.handler?.shouldBlock(from, to) ?? false,
    confirmLeave: () => host.handler?.confirmLeave() ?? true,
    onLeave: () => host.handler?.onLeave?.(),
  });
}
/** Registers (or, with null, removes) the handler consulted for guarded moves. Returns a function that unregisters it. */
export function setTraversalHandler(
  win: GuardWindow,
  handler: TraversalHandler | null,
) {
  const host = registry(win as HandlerHost);
  host.handler = handler;
  return () => {
    if (host.handler === handler) host.handler = null;
  };
}
