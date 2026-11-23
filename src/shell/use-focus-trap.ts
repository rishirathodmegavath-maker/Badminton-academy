"use client";
import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * While `active`, keeps keyboard focus inside `container` (Tab and Shift+Tab wrap), moves focus into it when it
 * opens, calls `onEscape` for the Escape key, and puts focus back on the element that had it before. Used for the
 * mobile navigation drawer; native `<dialog>` modals already do this themselves.
 */
export function useFocusTrap(
  active: boolean,
  container: RefObject<HTMLElement | null>,
  onEscape: () => void,
) {
  useEffect(() => {
    const root = container.current;
    if (!active || !root) return;
    const previous = document.activeElement as HTMLElement | null;
    const items = () =>
      [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
    (items()[0] ?? root).focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== "Tab") return;
      const list = items();
      if (!list.length) {
        event.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !root!.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !root!.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
    // onEscape is intentionally not a dependency: callers pass an inline closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, container]);
}
