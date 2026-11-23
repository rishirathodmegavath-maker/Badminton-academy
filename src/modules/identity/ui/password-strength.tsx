"use client";

import { Check, Circle } from "lucide-react";
import type {
  PasswordRequirement,
  PasswordStrength,
} from "./auth-validation";

type PasswordStrengthMeterProps = {
  id?: string;
  strength: PasswordStrength;
};

const SEGMENTS = [1, 2, 3, 4] as const;

export function PasswordStrengthMeter({
  id,
  strength,
}: PasswordStrengthMeterProps) {
  return (
    <div
      id={id}
      className={`auth-strength is-${strength.level}`}
      data-strength={strength.level}
    >
      <div className="auth-strength-header">
        <span className="auth-strength-title">Password strength</span>
        <span className="auth-strength-label" aria-live="polite">
          {strength.label || "Enter at least 12 characters"}
        </span>
      </div>
      <div className="auth-strength-bars" aria-hidden="true">
        {SEGMENTS.map((segment) => (
          <span
            key={segment}
            className={`auth-strength-bar${strength.score >= segment ? " is-active" : ""}`}
          />
        ))}
      </div>
    </div>
  );
}

type PasswordRequirementsListProps = {
  id: string;
  requirements: PasswordRequirement[];
};

export function PasswordRequirementsList({
  id,
  requirements,
}: PasswordRequirementsListProps) {
  return (
    <ul
      id={id}
      className="auth-req-list"
      aria-label="Password requirements"
    >
      {requirements.map((item) => (
        <li
          key={item.id}
          className={`auth-req-item${item.met ? " is-met" : ""}`}
        >
          <span className="auth-req-dot" aria-hidden="true">
            {item.met ? <Check size={13} /> : <Circle size={9} />}
          </span>
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
