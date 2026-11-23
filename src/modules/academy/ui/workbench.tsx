"use client";
import {
  Search,
  ChevronRight,
  FileText,
  CalendarDays,
  Users,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Status } from "./shared";
export function Pane({
  title,
  action,
  children,
  className = "",
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`wb-pane ${className}`}>
      {title && (
        <header className="wb-pane-heading">
          <h2>{title}</h2>
          {action}
        </header>
      )}
      <div className="wb-pane-content">{children}</div>
    </section>
  );
}
export function SearchBox({
  value,
  onChange,
  label = "Search records",
  placeholder = "Search…",
}: {
  value: string;
  onChange: (s: string) => void;
  label?: string;
  placeholder?: string;
}) {
  return (
    <label className="wb-search">
      <Search size={17} />
      <input
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
export function Person({
  name,
  subtitle,
  large = false,
}: {
  name: string;
  subtitle?: string;
  large?: boolean;
}) {
  return (
    <div className={`wb-person ${large ? "large" : ""}`}>
      <span className="wb-initials" aria-hidden="true">
        {name
          .split(" ")
          .map((n) => n[0])
          .slice(0, 2)
          .join("")}
      </span>
      <div>
        <strong>{name}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
    </div>
  );
}
export function Roster<T extends { id: string }>({
  rows,
  selectedId,
  onSelect,
  title,
  subtitle,
  status,
  empty = "No records match your filters.",
  emptyTitle,
  emptyAction,
}: {
  rows: T[];
  selectedId?: string;
  onSelect: (id: string) => void;
  title: (r: T) => string;
  subtitle?: (r: T) => string;
  status?: (r: T) => string;
  empty?: string;
  emptyTitle?: string;
  emptyAction?: BlankAction;
}) {
  return (
    <div className="wb-roster">
      {rows.length ? (
        rows.map((row) => (
          <button
            key={row.id}
            className={`wb-roster-item ${selectedId === row.id ? "selected" : ""}`}
            aria-pressed={selectedId === row.id}
            onClick={() => onSelect(row.id)}
          >
            <Person name={title(row)} subtitle={subtitle?.(row)} />
            {status && <Status value={status(row)} />}
            <ChevronRight size={15} />
          </button>
        ))
      ) : (
        <Blank title={emptyTitle} text={empty} action={emptyAction} />
      )}
    </div>
  );
}
/** What an empty state offers: one primary action (UX E-1). */
export type BlankAction = { label: string; onClick: () => void };
export function Blank({
  title = "Nothing recorded yet",
  text,
  icon: Icon = FileText,
  action,
}: {
  title?: string;
  text: string;
  icon?: LucideIcon;
  action?: BlankAction;
}) {
  return (
    <div className="wb-blank">
      <Icon size={31} />
      <h3>{title}</h3>
      <p>{text}</p>
      {action && (
        <button type="button" className="primary" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
export function Info({
  items,
}: {
  items: { label: string; value: React.ReactNode; icon?: LucideIcon }[];
}) {
  return (
    <dl className="wb-info">
      {items.map(({ label, value, icon: Icon = FileText }) => (
        <div key={label}>
          <dt>
            <Icon size={16} />
            {label}
          </dt>
          <dd>{value || "Not recorded"}</dd>
        </div>
      ))}
    </dl>
  );
}
export function Metrics({
  items,
}: {
  items: {
    label: string;
    value: React.ReactNode;
    help?: string;
    onClick?: () => void;
    icon?: LucideIcon;
    tone?: string;
  }[];
}) {
  return (
    <div className="wb-metrics">
      {items.map(
        ({
          label,
          value,
          help,
          onClick,
          icon: Icon = Users,
          tone = "green",
        }) => {
          const content = (
            <>
              <span className={`wb-metric-icon ${tone}`}>
                <Icon size={23} />
              </span>
              <div>
                <span>{label}</span>
                <strong>{value}</strong>
                {help && <small>{help}</small>}
              </div>
            </>
          );
          return onClick ? (
            <button key={label} className="wb-metric" onClick={onClick}>
              {content}
            </button>
          ) : (
            <div key={label} className="wb-metric">
              {content}
            </div>
          );
        },
      )}
    </div>
  );
}
export function ContextNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="wb-context">
      <ShieldCheck size={14} />
      {children}
    </p>
  );
}
export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="wb-toolbar">{children}</div>;
}
export function DateLabel({ date }: { date: string }) {
  return (
    <span className="wb-date">
      <CalendarDays size={16} />
      {new Date(date + "T12:00:00Z").toLocaleDateString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })}
    </span>
  );
}
