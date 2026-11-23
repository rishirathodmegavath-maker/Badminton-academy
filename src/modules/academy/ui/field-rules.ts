import type { Field, Values } from "./shared";

/**
 * What is wrong with one field, in words the person can act on; "" when it is fine (UX A2: inline, field-linked errors).
 * This only saves a round trip: the server validates every value again and stays the authority, so nothing here is
 * ever a rule of its own. A field the form does not mark required, with no value, is never a problem.
 */
export function fieldProblem(f: Field, values: Values): string {
  // "Duration (minutes)" reads as "Duration" inside a sentence.
  const name = f.label.replace(/\s*\([^)]*\)/g, "").trim() || f.label;
  if (f.kind === "multi") return "";
  const value = values[f.name];
  if (f.kind === "check") return f.required && value !== true ? `Tick “${name}” to continue.` : "";
  const raw = String(value ?? "").trim();
  if (!raw) return f.required ? (f.kind === "select" ? `Choose an option for “${name}”.` : `${name} is required.`) : "";
  if (f.kind === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return `${name} must be a number.`;
    if (f.min !== undefined && n < f.min) return `${name} must be at least ${f.min}.`;
    if (f.max !== undefined && n > f.max) return `${name} must be at most ${f.max}.`;
  }
  if (f.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return `Enter a valid email address for “${name}”.`;
  return "";
}
