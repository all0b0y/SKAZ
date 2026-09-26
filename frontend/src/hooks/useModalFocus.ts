import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'input:not(:disabled), button:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

/** Keep keyboard focus inside a modal: focus its first control on open, wrap
 *  Tab / Shift+Tab at its edges, and pull focus back if it lands outside.
 *  Without this an `aria-modal` dialog still lets Tab walk into the app behind it. */
export function useModalFocus(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!panel.contains(document.activeElement)) (controls()[0] ?? panel).focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = controls();
      const first = items[0];
      const last = items.at(-1);
      const active = document.activeElement;
      if (!first) { e.preventDefault(); panel.focus(); }
      else if (e.shiftKey && (active === first || !panel.contains(active))) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (active === last || !panel.contains(active))) { e.preventDefault(); first.focus(); }
    };
    const keepFocus = (e: FocusEvent) => {
      if (!panel.contains(e.target as Node)) (controls()[0] ?? panel).focus();
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', keepFocus);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', keepFocus);
      if (previous?.isConnected) previous.focus();
    };
  }, [ref]);
}
