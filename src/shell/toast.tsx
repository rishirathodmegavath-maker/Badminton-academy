"use client";
import { useEffect, type ReactNode } from "react";

/** How long a confirmation stays up. Errors never use this component: they stay until the person acts. */
export const TOAST_MS = 8000;

/**
 * A short confirmation ("Changes saved."). It is a polite status message, so a screen reader announces it without
 * moving focus, and it goes away by itself after a few seconds (or sooner with the close button) instead of piling up
 * on the page for the rest of the session. Pointer or keyboard attention on the message pauses nothing: it only repeats
 * what the page already shows.
 */
export function Toast({
  message,
  onDismiss,
  dismissLabel = "Dismiss notification",
  icon,
}: {
  message: string;
  onDismiss: () => void;
  dismissLabel?: string;
  icon?: ReactNode;
}) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onDismiss, TOAST_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);
  if (!message) return null;
  return (
    <div className="toast" role="status">
      {icon}
      {message}
      <button type="button" aria-label={dismissLabel} onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
