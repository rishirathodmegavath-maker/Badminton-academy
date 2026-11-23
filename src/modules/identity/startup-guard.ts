import { assertSecurityConfig, type Env } from "./security-config";

/**
 * Runs the start-up security review and, when production refuses the configuration, ENDS THE PROCESS with a non-zero code.
 *
 * Why not just let `assertSecurityConfig` throw: Next.js reports a throwing instrumentation hook ("Failed to prepare server")
 * but leaves the process alive and not listening. A supervisor (systemd, Docker, Kubernetes, a process manager) then sees a
 * running process, never restarts it and never alerts, and the first sign of the mistake is an outage with no health signal.
 * A refused start must look like a failed start. The messages are the value-free findings already printed by the review.
 */
export function enforceSecurityConfigAtStartup(
  env: Env = process.env,
  log: Pick<Console, "warn" | "error" | "info"> = console,
  exit: (code: number) => void = (code) => process.exit(code),
) {
  try {
    assertSecurityConfig(env, log);
  } catch (error) {
    log.error(error instanceof Error ? error.message : "Unsafe or invalid security configuration. The application will not start.");
    exit(1);
  }
}
