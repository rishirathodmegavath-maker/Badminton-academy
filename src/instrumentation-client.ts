import {
  installEarlyTraversalGuard,
  type GuardWindow,
} from "./shell/traversal-guard";

/**
 * Runs in the browser before the application hydrates. The Back/Forward guard has to be listening before the App
 * Router registers its own `popstate` handler (see src/shell/traversal-guard.ts); with no screen registered it does
 * nothing.
 */
try {
  installEarlyTraversalGuard(window as unknown as GuardWindow);
} catch {
  /* a browser without what the guard needs simply goes unguarded; unload and link guards still apply */
}
