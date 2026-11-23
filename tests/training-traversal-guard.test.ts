import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installEarlyTraversalGuard,
  installTraversalGuard,
  setTraversalHandler,
  type GuardWindow,
} from "../src/shell/traversal-guard";

/**
 * Stage 4: the Back / Forward guard, against a model of the browser's behaviour that matters here:
 *   Navigation API `navigate` (before) -> `popstate` on window (listeners run in registration order) -> the router's
 *   own popstate listener. `history.go()` is asynchronous and produces another traversal.
 */
class FakePopStateEvent extends Event {
  state: unknown;
  constructor(type: string, init?: { state?: unknown }) {
    super(type);
    this.state = init?.state;
  }
}
type Entry = { url: string; state: unknown };
function browser(entries: string[], start: number) {
  const history: Entry[] = entries.map((url, i) => ({
    url,
    state: { __NA: true, i },
  }));
  let index = start;
  const nav = new EventTarget() as EventTarget & {
    currentEntry: { index: number; url: string };
  };
  // getters, not Object.assign (which would freeze a snapshot of the value)
  Object.defineProperty(nav, "currentEntry", {
    get: () => ({ index, url: `http://app.test${history[index].url}` }),
  });
  const goCalls: number[] = [];
  const win = Object.assign(new EventTarget(), {
    PopStateEvent: FakePopStateEvent as unknown as typeof PopStateEvent,
    navigation: nav,
    history: {
      get state() {
        return history[index].state;
      },
      go(delta: number) {
        goCalls.push(delta);
        queueMicrotask(() => traverse(index + delta));
      },
    },
  }) as unknown as GuardWindow & { navigation: typeof nav };
  Object.defineProperty(win, "location", {
    get: () => ({ href: `http://app.test${history[index].url}` }),
  });
  const routerSaw: unknown[] = [];
  /** The user presses Back/Forward (or the page calls history.go): navigate fires first, then the move, then popstate. */
  function traverse(to: number, sameDocument = true) {
    const ev = Object.assign(new Event("navigate"), {
      navigationType: "traverse",
      destination: {
        index: to,
        url: `http://app.test${history[to].url}`,
        sameDocument,
      },
    });
    nav.dispatchEvent(ev);
    index = to;
    if (sameDocument)
      win.dispatchEvent(
        new FakePopStateEvent("popstate", { state: history[to].state }),
      );
  }
  const push = (url: string) => {
    nav.dispatchEvent(
      Object.assign(new Event("navigate"), {
        navigationType: "push",
        destination: { index: index + 1, url, sameDocument: true },
      }),
    );
    history.splice(index + 1);
    history.push({ url, state: { __NA: true, i: history.length } });
    index++;
  };
  return {
    win,
    history,
    goCalls,
    routerSaw,
    traverse,
    push,
    get index() {
      return index;
    },
    /** Registered AFTER the guard, like the router's listener (the guard must be installed first). */
    attachRouter() {
      win.addEventListener("popstate", (e) =>
        routerSaw.push((e as FakePopStateEvent).state),
      );
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("no guarded move: the router sees the traversal exactly as before and nobody is asked", () => {
  const b = browser(["/overview", "/training", "/players"], 2);
  let asked = 0;
  installTraversalGuard(b.win, {
    shouldBlock: () => false,
    confirmLeave: () => (asked++, true),
  });
  b.attachRouter();
  b.traverse(1);
  b.traverse(0);
  b.traverse(2);
  assert.equal(asked, 0);
  assert.equal(b.routerSaw.length, 3);
});

test("Back, staying: the router never sees it, the browser is put back, history is untouched, and it can happen again", async () => {
  const b = browser(["/overview", "/training"], 1);
  let asked = 0;
  const seen: [string, string][] = [];
  installTraversalGuard(b.win, {
    shouldBlock: (f, t) => (seen.push([f, t]), true),
    confirmLeave: () => (asked++, false),
  });
  b.attachRouter();
  const before = b.history.length;
  b.traverse(0);
  assert.equal(asked, 1);
  assert.deepEqual(seen, [["/training", "/overview"]]);
  assert.equal(
    b.routerSaw.length,
    0,
    "the router must not see a move that was cancelled",
  );
  assert.deepEqual(
    b.goCalls,
    [1],
    "put back with the exact opposite of the move",
  );
  await tick();
  assert.equal(b.index, 1, "back on the draft page");
  assert.equal(
    b.routerSaw.length,
    0,
    "and the undo is invisible to the router too",
  );
  assert.equal(asked, 1, "the undo did not ask again");
  assert.equal(b.history.length, before, "no history entries were added");
  // again, and again: no accumulation, no loop
  b.traverse(0);
  await tick();
  b.traverse(0);
  await tick();
  assert.equal(asked, 3);
  assert.deepEqual(b.goCalls, [1, 1, 1]);
  assert.equal(b.routerSaw.length, 0);
  assert.equal(b.history.length, before);
});

test("Back, leaving: the router sees exactly one traversal, with the new entry's own state, after one question", () => {
  const b = browser(["/overview", "/training"], 1);
  let asked = 0;
  let left = 0;
  installTraversalGuard(b.win, {
    shouldBlock: () => true,
    confirmLeave: () => (asked++, true),
    onLeave: () => left++,
  });
  b.attachRouter();
  b.traverse(0);
  assert.equal(asked, 1);
  assert.equal(left, 1);
  assert.deepEqual(
    b.routerSaw,
    [b.history[0].state],
    "replayed once, carrying the state the router needs",
  );
  assert.deepEqual(b.goCalls, []);
  assert.equal(b.index, 0);
  // the replay did not leave the guard in a state that swallows the next real move
  b.traverse(1);
  assert.equal(asked, 2);
});

test("Forward is guarded the same way", async () => {
  const b = browser(["/training", "/players"], 0);
  let asked = 0;
  installTraversalGuard(b.win, {
    shouldBlock: (f, t) => f !== t,
    confirmLeave: () => (asked++, false),
  });
  b.attachRouter();
  b.traverse(1);
  assert.equal(asked, 1);
  assert.deepEqual(b.goCalls, [-1]);
  await tick();
  assert.equal(b.index, 0);
  assert.equal(b.routerSaw.length, 0);
});

test("a long jump through several entries is undone by exactly that many steps", async () => {
  const b = browser(["/a", "/b", "/c", "/d"], 3);
  installTraversalGuard(b.win, {
    shouldBlock: () => true,
    confirmLeave: () => false,
  });
  b.attachRouter();
  b.traverse(0);
  assert.deepEqual(b.goCalls, [3]);
  await tick();
  assert.equal(b.index, 3);
  assert.equal(b.routerSaw.length, 0);
});

test("moves within the same page (hash only) and moves nobody asked to guard pass straight through", () => {
  const b = browser(["/training#a", "/training#b", "/players"], 1);
  let asked = 0;
  installTraversalGuard(b.win, {
    shouldBlock: (from, to) => from !== to, // what the training screen does: only a change of page is a departure
    confirmLeave: () => (asked++, false),
  });
  b.attachRouter();
  b.traverse(0); // /training#b -> /training#a
  assert.equal(asked, 0);
  assert.equal(b.routerSaw.length, 1);
  b.traverse(1);
  assert.equal(b.routerSaw.length, 2);
});

test("only traversals inside this document are guarded; pushes and other kinds of navigation are never intercepted", () => {
  const b = browser(["/overview", "/training"], 1);
  let asked = 0;
  installTraversalGuard(b.win, {
    shouldBlock: () => true,
    confirmLeave: () => (asked++, false),
  });
  b.attachRouter();
  b.push("http://app.test/players"); // a link click: handled by the shell's own guard, not here
  assert.equal(asked, 0);
  // a traversal that leaves the document fires no popstate here (beforeunload is what covers it)
  b.traverse(0, false);
  assert.equal(asked, 0);
  assert.equal(b.routerSaw.length, 0);
  // a stray popstate with no preceding traversal is not mistaken for a guarded move
  b.win.dispatchEvent(new FakePopStateEvent("popstate", { state: { x: 1 } }));
  assert.equal(asked, 0);
  assert.equal(b.routerSaw.length, 1);
});

test("a browser without the Navigation API is left alone (callers keep the recovery copy for that case)", () => {
  const b = browser(["/a", "/b"], 1);
  (b.win as unknown as { navigation?: unknown }).navigation = undefined;
  const g = installTraversalGuard(b.win, {
    shouldBlock: () => true,
    confirmLeave: () => false,
  });
  b.attachRouter();
  assert.equal(g.supported, false);
  b.win.dispatchEvent(new FakePopStateEvent("popstate", { state: {} }));
  assert.equal(b.routerSaw.length, 1);
});

test("uninstalling the guard restores the plain behaviour", () => {
  const b = browser(["/a", "/b"], 1);
  const g = installTraversalGuard(b.win, {
    shouldBlock: () => true,
    confirmLeave: () => false,
  });
  b.attachRouter();
  g.uninstall();
  b.traverse(0);
  assert.equal(b.routerSaw.length, 1);
});

test("the early guard is installed once, passes everything through with no screen registered, and obeys the registered screen", async () => {
  const b = browser(["/overview", "/training"], 1);
  installEarlyTraversalGuard(b.win);
  installEarlyTraversalGuard(b.win); // a second import or a hot reload must not add a second guard
  b.attachRouter();
  b.traverse(0);
  b.traverse(1);
  assert.equal(b.routerSaw.length, 2, "nothing registered: untouched");

  let asked = 0;
  const unregister = setTraversalHandler(b.win, {
    shouldBlock: () => true,
    confirmLeave: () => (asked++, false),
  });
  b.traverse(0);
  assert.equal(
    asked,
    1,
    "one question even though the guard was imported twice",
  );
  await tick();
  assert.equal(
    b.routerSaw.length,
    2,
    "the cancelled move never reached the router",
  );

  // a stale cleanup from an earlier screen must not remove the current screen's handler
  const other = setTraversalHandler(b.win, {
    shouldBlock: () => true,
    confirmLeave: () => (asked++, false),
  });
  unregister();
  b.traverse(0);
  assert.equal(asked, 2);
  await tick();
  other();
  b.traverse(0);
  assert.equal(
    b.routerSaw.length,
    3,
    "after the screen is gone, moves pass through again",
  );
});

test("the guard asks before the router in the order the listeners were registered (the reason it is installed first)", () => {
  const b = browser(["/a", "/b"], 1);
  const order: string[] = [];
  b.win.addEventListener("popstate", () => order.push("router-too-early")); // registered BEFORE the guard
  installTraversalGuard(b.win, {
    shouldBlock: () => true,
    confirmLeave: () => (order.push("ask"), true),
  });
  b.traverse(0);
  assert.equal(
    order[0],
    "router-too-early",
    "a router that registered first has already acted before the question: hence src/instrumentation-client.ts",
  );
  assert.deepEqual(order.slice(1), ["ask", "router-too-early"]);
});
