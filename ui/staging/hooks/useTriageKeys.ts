import { dialogPath, isLightboxOpen } from '@ein/ui/signals';
import { type RefObject, useEffect, useRef } from 'react';
import { keysAllowed, type KeyTarget, matchTriageKey, type TriageAction, type TriageScope } from '../lib/triage-keys.ts';

/** A held J or K moves at most this often. */
const REPEAT_MS = 120;

/**
 * The Sort tab's keys (`lib/triage-keys.ts`), acted on through `act` in the scope the cursor is in,
 * while `enabled`. One listener, on the window in the capture phase: it runs before a dialog's own
 * Escape, which Mantine also takes at the window, so the guard still sees open a dialog that the
 * same key closes. `modalOpen` says whether one of the page's own dialogs is open.
 */
export function useTriageKeys(enabled: boolean, scope: TriageScope, act: (action: TriageAction) => void, modalOpen: RefObject<boolean>): void {
  const actRef = useRef(act);
  actRef.current = act;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    if (!enabled) return;
    let lastRepeat = 0;
    const onKey = (event: KeyboardEvent) => {
      const context = { lightboxOpen: isLightboxOpen.peek(), dialogOpen: dialogPath.peek() !== null, modalOpen: modalOpen.current === true };
      if (!keysAllowed(event.target as KeyTarget | null, context, event.key)) return;
      const entry = matchTriageKey(event, scopeRef.current);
      if (!entry) return;
      event.preventDefault();
      if (event.repeat) {
        const now = performance.now();
        if (now - lastRepeat < REPEAT_MS) return;
        lastRepeat = now;
      }
      actRef.current(entry.action);
    };
    globalThis.addEventListener('keydown', onKey, { capture: true });
    return () => globalThis.removeEventListener('keydown', onKey, { capture: true });
  }, [enabled, modalOpen]);
}
