"use client";
import { createContext, useContext, useEffect, useRef } from "react";
import { label } from "../../academy/ui/labels";
import { X } from "lucide-react";
import type { TrainingSession } from "../domain/types";
import { redirectIfGated } from "../../identity/ui/gate";
import { readJson, sendRequest } from "../../../shell/request";
export async function request<T>(path = "", body?: unknown): Promise<T> {
  const response = await sendRequest(
    `/api/training${path}`,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("Sign in to continue.");
  }
  const result = await readJson(response);
  if (redirectIfGated(response.status, result))
    throw new Error(result.error || "Finish setting up your account.");
  if (!response.ok)
    throw Object.assign(new Error(result.error || "Request failed."), {
      code: result.code as string | undefined,
      status: response.status,
    });
  return result;
}
export function Badge({ status }: { status: TrainingSession["status"] }) {
  return (
    <span className={`badge ${status.toLowerCase()}`}>
      <i />
      {label(status)}
    </span>
  );
}
export const ErrorContext = createContext("");
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const error = useContext(ErrorContext);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      const target = previous?.isConnected
        ? previous
        : document.getElementById("main");
      target?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="modal-title"
    >
      <div className="modal-heading">
        <h2 id="modal-title">{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {children}
    </dialog>
  );
}
export function Court({
  skill = "Overhead",
  large = false,
}: {
  skill?: string;
  large?: boolean;
}) {
  const net = skill === "Net play";
  const movement = skill === "Movement" || skill === "Fitness";
  return (
    <div className={`court-art ${large ? "large" : ""}`}>
      <svg
        viewBox="0 0 400 220"
        role="img"
        aria-label={`${skill} drill court illustration`}
      >
        <defs>
          <linearGradient
            id={`court-${skill.replaceAll(" ", "")}`}
            x2="0"
            y2="1"
          >
            <stop stopColor="#173b41" />
            <stop offset="1" stopColor="#0b262e" />
          </linearGradient>
        </defs>
        <rect width="400" height="220" fill="#0e2c35" />
        <circle cx="330" cy="15" r="120" fill="#b3d7ab" opacity=".04" />
        <g stroke="#7da99b" strokeWidth="1" fill="none" opacity=".65">
          <path d="M76 53H324L376 201H24Z" />
          <path d="M92 53L53 201M308 53L347 201M57 107H343M45 141H355M200 53V201M70 69H330M30 186H370" />
        </g>
        <path d="M40 116H360" stroke="#d0e9df" strokeWidth="2" />
        <path d="M40 116V96M360 116V96" stroke="#a6c8bc" strokeWidth="3" />
        <g
          stroke="#fff"
          strokeWidth="2"
          strokeDasharray="5 6"
          fill="none"
          opacity=".75"
        >
          <path
            d={
              movement
                ? "M200 167L92 83M200 167L310 82M200 167L73 177"
                : net
                  ? "M165 147Q210 81 260 105"
                  : "M149 152Q200 12 297 74"
            }
          />
        </g>
        <circle
          cx={net ? 260 : 297}
          cy={net ? 105 : 74}
          r="8"
          fill="#d8edb3"
          opacity=".2"
        />
        <circle cx={net ? 260 : 297} cy={net ? 105 : 74} r="3" fill="#e6f5c8" />
        <ellipse cx="153" cy="182" rx="29" ry="5" fill="#000" opacity=".2" />
        <g strokeLinecap="round" strokeLinejoin="round">
          <circle cx="155" cy="119" r="9" fill="#ddc5a0" />
          <path d="M151 133L150 151" stroke="#bdddba" strokeWidth="17" />
          <path
            d="M146 151L132 171L119 182M156 151L172 169L181 180"
            stroke="#b9d2c8"
            strokeWidth="8"
          />
          <path
            d="M147 132L129 143L117 137M160 132L174 115L182 94"
            stroke="#ddc5a0"
            strokeWidth="5"
          />
          <path d="M180 94L184 81" stroke="#b7c6bb" strokeWidth="2" />
          <ellipse
            cx="187"
            cy="72"
            rx="7"
            ry="12"
            transform="rotate(20 187 72)"
            fill="none"
            stroke="#d8edb3"
            strokeWidth="2"
          />
        </g>
        <text x="20" y="25" fill="#acc5ba" fontSize="9" letterSpacing="2">
          SPORTOZEN / DRILL NOTES
        </text>
        <text x="380" y="205" textAnchor="end" fill="#acc5ba" fontSize="9">
          ILLUSTRATION
        </text>
      </svg>
    </div>
  );
}
export type RunMutation = (
  id: string,
  version: number,
  action: string,
  payload?: unknown,
) => Promise<TrainingSession | undefined>;
