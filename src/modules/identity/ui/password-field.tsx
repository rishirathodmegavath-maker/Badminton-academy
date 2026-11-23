"use client";

import { useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";

export type PasswordFieldProps = {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string | null;
  hint?: string;
  labelAside?: ReactNode;
  describedBy?: string;
};

export function PasswordField({
  id,
  name,
  label,
  value,
  onChange,
  onBlur,
  autoComplete,
  placeholder,
  required,
  disabled,
  error,
  hint,
  labelAside,
  describedBy,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const targetLabel = label.toLowerCase();
  const toggleLabel = visible ? `Hide ${targetLabel}` : `Show ${targetLabel}`;

  const refs = [
    hint ? hintId : null,
    error ? errorId : null,
    describedBy ?? null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="auth-field">
      <div className="auth-field-header">
        <label className="auth-label" htmlFor={id}>
          {label}
        </label>
        {labelAside}
      </div>
      <div className="auth-input-wrap">
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          className={`auth-input auth-input-password${error ? " is-invalid" : ""}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          autoComplete={autoComplete}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={refs || undefined}
        />
        <button
          type="button"
          className="auth-eye-btn"
          aria-label={toggleLabel}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
          disabled={disabled}
          title={toggleLabel}
        >
          {visible ? (
            <EyeOff size={17} aria-hidden="true" />
          ) : (
            <Eye size={17} aria-hidden="true" />
          )}
        </button>
      </div>
      {hint && !error && (
        <p id={hintId} className="auth-field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="auth-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
