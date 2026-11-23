/**
 * Runs once when the server starts (Next.js instrumentation hook). It reviews the security
 * settings before the first request: in production an invalid or unsafe value stops start-up with
 * a clear, value-free message; in development the same findings are warnings.
 *
 * Only on a running Node.js server: the edge runtime has no Node APIs, and `next build` imports the
 * app without serving it (the review belongs to the server that will actually run).
 */
export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { enforceSecurityConfigAtStartup } = await import(
      "./modules/identity/startup-guard"
    );
    enforceSecurityConfigAtStartup();
  }
}
