"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Plus, Search, ArrowRight } from "lucide-react";
import { Modal, ErrorContext } from "../../training/ui/common";
import { redirectIfGated } from "../../identity/ui/gate";
import { formatMoney } from "../../fees/domain/money";
import { label as displayLabel } from "./labels";
import { readJson, sendRequest } from "../../../shell/request";
import { fieldProblem } from "./field-rules";
export type Values = Record<string, string | boolean | string[]>;
export type Field = {
  name: string;
  label: string;
  kind?:
    | "text"
    | "textarea"
    | "select"
    | "multi"
    | "check"
    | "date"
    | "time"
    | "number"
    | "email"
    | "password";
  required?: boolean;
  options?: { value: string; label: string }[];
  help?: string;
  min?: number;
  max?: number;
};
export type DialogSpec = {
  title: string;
  fields: Field[];
  initial: Values;
  submit: (v: Values) => Promise<boolean>;
  button?: string;
  notice?: React.ReactNode;
  derive?: (values: Values, name: string) => Values;
  /**
   * Optional confirmation step (opt-in; dialogs without it behave exactly as before). Called on submit: null saves
   * directly; otherwise its content is shown for confirmation and its `values` (e.g. carrying a server preview
   * token) are what is saved.
   */
  confirm?: (values: Values) => Promise<Confirmation | null>;
};
export type Confirmation = {
  title: string;
  content: React.ReactNode;
  values: Values;
  button: string;
};
export function text(v: Values, key: string) {
  return String(v[key] ?? "");
}
export function list(v: Values, key: string) {
  return Array.isArray(v[key]) ? (v[key] as string[]) : [];
}
export function flag(v: Values, key: string) {
  return v[key] === true;
}
export function number(v: Values, key: string) {
  return Number(v[key]);
}
export function Editor({
  spec,
  close,
  busy,
}: {
  spec: DialogSpec;
  close: () => void;
  busy: boolean;
}) {
  const [values, setValues] = useState<Values>(spec.initial);
  const [review, setReview] = useState<Confirmation | null>(null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const formId = useId();
  const errorId = (name: string) => `${formId}-${name}-error`;
  const change = (name: string, value: string | boolean | string[]) => {
    setValues((old) => {
      const next = { ...old, [name]: value };
      return spec.derive ? spec.derive(next, name) : next;
    });
    // Editing a field withdraws its message; the whole form is checked again on the next save.
    setErrors((old) => (old[name] ? { ...old, [name]: "" } : old));
  };
  // Opening a form puts the cursor in its first field (otherwise the dialog's close button is the first stop).
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>("[data-field]:not([disabled])")?.focus({ preventScroll: true });
  }, []);
  const invalid = (name: string) => (errors[name] ? true : undefined);
  const describedBy = (f: Field) =>
    [errors[f.name] ? errorId(f.name) : "", f.help ? `${formId}-${f.name}-help` : ""].filter(Boolean).join(" ") || undefined;
  const fieldError = (f: Field) =>
    errors[f.name] ? (
      <small className="field-error" id={errorId(f.name)}>
        {errors[f.name]}
      </small>
    ) : null;
  const problemCount = Object.values(errors).filter(Boolean).length;
  if (review)
    return (
      // A fresh confirmation never shows an earlier save's error; a refused confirmation returns to the form,
      // where the new error is shown.
      <ErrorContext.Provider value="">
      <Modal title={review.title} onClose={close}>
        <div className="notice" role="status">
          {review.content}
        </div>
        <div className="modal-actions">
          <button className="secondary" type="button" disabled={busy} onClick={() => setReview(null)}>
            Back
          </button>
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={async () => {
              if (await spec.submit(review.values)) close();
              // A refused save (for example a preview that went stale) returns to the form, where the error shows.
              else setReview(null);
            }}
          >
            {busy ? "Saving…" : review.button}
          </button>
        </div>
      </Modal>
      </ErrorContext.Provider>
    );
  return (
    <Modal title={spec.title} onClose={close}>
      <form
        ref={formRef}
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          // Fields are checked here, not by the browser's pop-up tooltip, so every message stays on screen beside its
          // field and the first one receives focus.
          const found: Record<string, string> = {};
          for (const f of spec.fields) {
            const message = fieldProblem(f, values);
            if (message) found[f.name] = message;
          }
          setErrors(found);
          const first = spec.fields.find((f) => found[f.name]);
          if (first) {
            setProblem("");
            formRef.current?.querySelector<HTMLElement>(`[data-field="${first.name}"]`)?.focus();
            return;
          }
          if (spec.confirm) {
            setProblem("");
            setChecking(true);
            try {
              const confirmation = await spec.confirm(values);
              if (confirmation) {
                setReview(confirmation);
                return;
              }
            } catch (e) {
              setProblem((e as Error).message);
              return;
            } finally {
              setChecking(false);
            }
          }
          if (await spec.submit(values)) close();
        }}
      >
        <fieldset disabled={busy || checking}>
          {problem && (
            <div className="error" role="alert">
              {problem}
            </div>
          )}
          {problemCount > 0 && (
            <div className="error" role="alert">
              {problemCount === 1 ? "Fix the field marked below, then save again." : `Fix the ${problemCount} fields marked below, then save again.`}
            </div>
          )}
          {spec.notice && <div className="notice">{spec.notice}</div>}
          <div className="ops-form">
            {spec.fields.map((f) =>
              f.kind === "check" ? (
                <div className="ops-field-check" key={f.name}>
                  <label className="checkbox">
                    <input
                      data-field={f.name}
                      type="checkbox"
                      checked={flag(values, f.name)}
                      onChange={(e) => change(f.name, e.target.checked)}
                      aria-required={f.required || undefined}
                      aria-invalid={invalid(f.name)}
                      aria-describedby={describedBy(f)}
                    />
                    {f.label}
                  </label>
                  {fieldError(f)}
                </div>
              ) : f.kind === "multi" ? (
                <fieldset className="choice-group" key={f.name}>
                  <legend>{f.label}</legend>
                  {!f.options?.length && (
                    <p className="muted">No eligible records available.</p>
                  )}
                  {f.options?.map((o) => (
                    <label className="checkbox" key={o.value}>
                      <input
                        type="checkbox"
                        checked={list(values, f.name).includes(o.value)}
                        onChange={(e) =>
                          change(
                            f.name,
                            e.target.checked
                              ? [...list(values, f.name), o.value]
                              : list(values, f.name).filter(
                                  (id) => id !== o.value,
                                ),
                          )
                        }
                      />
                      {o.label}
                    </label>
                  ))}
                  {f.help && <small>{f.help}</small>}
                </fieldset>
              ) : (
                <div className="ops-field" key={f.name}>
                  <label>
                    {f.label}
                    {f.kind === "textarea" ? (
                      <textarea
                        data-field={f.name}
                        value={text(values, f.name)}
                        onChange={(e) => change(f.name, e.target.value)}
                        aria-required={f.required || undefined}
                        aria-invalid={invalid(f.name)}
                        aria-describedby={describedBy(f)}
                        rows={4}
                        maxLength={f.max ?? 5000}
                      />
                    ) : f.kind === "select" ? (
                      <select
                        data-field={f.name}
                        aria-label={f.label}
                        value={text(values, f.name)}
                        aria-required={f.required || undefined}
                        aria-invalid={invalid(f.name)}
                        aria-describedby={describedBy(f)}
                        onChange={(e) => change(f.name, e.target.value)}
                      >
                        {f.options?.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        data-field={f.name}
                        value={text(values, f.name)}
                        onChange={(e) => change(f.name, e.target.value)}
                        aria-required={f.required || undefined}
                        aria-invalid={invalid(f.name)}
                        aria-describedby={describedBy(f)}
                        type={f.kind ?? "text"}
                        min={f.min}
                        max={f.kind === "number" ? f.max : undefined}
                        maxLength={
                          f.kind !== "number" ? (f.max ?? 200) : undefined
                        }
                        autoComplete={
                          f.kind === "password" ? "new-password" : undefined
                        }
                      />
                    )}
                  </label>
                  {fieldError(f)}
                  {f.help && (
                    <small className="muted" id={`${formId}-${f.name}-help`}>
                      {f.help}
                    </small>
                  )}
                </div>
              ),
            )}
          </div>
          <div className="modal-actions">
            <button className="secondary" type="button" onClick={close}>
              Cancel
            </button>
            <button className="primary" type="submit">
              {busy ? "Saving…" : (spec.button ?? "Save")}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
export const options = (
  items: { id: string; name: string }[],
  empty = "Choose…",
) => [
  { value: "", label: empty },
  ...items.map((i) => ({ value: i.id, label: i.name })),
];
export const choices = (items: string[]) =>
  items.map((value) => ({ value, label: displayLabel(value) }));
export function Status({ value }: { value: string }) {
  return (
    <span
      className={`ops-status ${["APPROVED", "VERIFIED", "PUBLISHED", "ENROLLED", "SHARED", "AVAILABLE_IN_PORTAL", "ACTIVE", "PROCESSED"].includes(value) ? "positive" : ["BLOCKED", "REJECTED", "NOT_CONFIGURED", "VOID", "ARCHIVED", "CANCELLED", "WITHDRAWN"].includes(value) ? "negative" : ""}`}
    >
      {displayLabel(value)}
    </span>
  );
}
export function ModuleHeading({
  eyebrow,
  title,
  description,
  action,
  onAction,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="section-heading ops-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action && onAction && (
        <button className="primary" onClick={onAction}>
          <Plus size={16} />
          {action}
        </button>
      )}
    </div>
  );
}
/** A tab is its stored value, or a value with a different label to show ("ENQUIRY" shown as "Enquiry"). */
export type TabItem = string | { value: string; label: string };
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: TabItem[];
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <div className="tabs ops-tabs">
      {items.map((item) => {
        const v = typeof item === "string" ? item : item.value;
        const text = typeof item === "string" ? item : item.label;
        return (
          <button
            key={v}
            type="button"
            className={v === value ? "active" : ""}
            aria-current={v === value ? "true" : undefined}
            onClick={() => onChange(v)}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}
export function Empty({
  title = "Nothing recorded yet",
  description = "Records you add will appear here.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="empty compact">
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
export function GridTable<T extends { id: string }>({
  rows,
  columns,
  actions,
  focusId,
}: {
  rows: T[];
  columns: { label: string; render: (row: T) => React.ReactNode }[];
  actions?: (row: T) => React.ReactNode;
  focusId?: string;
}) {
  const [search, setSearch] = useState("");
  const filtered = rows.filter((row) =>
    JSON.stringify(row).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="ops-records">
      <label className="search ops-search">
        <Search size={15} />
        <input
          aria-label="Search records"
          placeholder="Search these records…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {!filtered.length ? (
        rows.length ? (
          <Empty
            title="No records match your search"
            description="Try a different word, or clear the search."
          />
        ) : (
          <Empty />
        )
      ) : (
        <div className="table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.label}>{c.label}</th>
                ))}
                {actions && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.id}
                  className={row.id === focusId ? "focused-record" : ""}
                >
                  {columns.map((c) => (
                    <td key={c.label} data-label={c.label}>
                      {c.render(row)}
                    </td>
                  ))}
                  {actions && (
                    <td data-label="Actions">
                      <div className="row-actions">{actions(row)}</div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
export function Action({
  children,
  onClick,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="text-button" onClick={onClick} disabled={disabled}>
      {children}
      <ArrowRight size={12} />
    </button>
  );
}
// Each amount is shown in the currency it was stored with, formatted for that currency's market.
export const money = formatMoney;
export const shortDate = (s: string) => (s ? s.slice(0, 10) : "Not set");
export function Details({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal title={title} onClose={close}>
      <div className="ops-details">{children}</div>
    </Modal>
  );
}
export async function academyRequest<T = unknown>(
  path = "",
  body?: unknown,
): Promise<T> {
  const response = await sendRequest(
    `/api/academy${path}`,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers:
            body instanceof FormData
              ? undefined
              : { "Content-Type": "application/json" },
          body: body instanceof FormData ? body : JSON.stringify(body),
        },
  );
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("Sign in to continue.");
  }
  const result = await readJson(response);
  // Several academies and none chosen for this session: nothing is readable until the person chooses.
  if (response.status === 409 && result?.code === "ACADEMY_SELECTION_REQUIRED") {
    window.location.assign("/academies");
    throw new Error(result.error ?? "Choose an academy to continue.");
  }
  // Signed in but with no usable academy (never assigned, or switched off everywhere): the "not part of an academy yet"
  // screen says so, explains who gives access, and offers to sign out.
  if (response.status === 403 && (result?.code === "NO_MEMBERSHIP" || result?.code === "MEMBERSHIP_INACTIVE")) {
    window.location.assign("/academies");
    throw Object.assign(new Error(result.error ?? "You are not assigned to an academy."), { code: result.code as string });
  }
  if (redirectIfGated(response.status, result))
    throw new Error(result.error ?? "Finish setting up your account.");
  if (!response.ok)
    throw Object.assign(new Error(result.error ?? "Request failed."), {
      code: result.code as string | undefined,
    });
  return result;
}
