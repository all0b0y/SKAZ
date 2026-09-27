// The proactive assistant's system notification (issue #10). Kept free of any
// Electron import so the privacy rule is unit-tested: the text is fixed here in
// main and the renderer can only pass a sound preference, so no transcript,
// question, name or answer can ever reach the OS notification center.

export interface ProactiveNoticeOptions {
  title: string;
  body: string;
  silent: boolean;
}

export const PROACTIVE_NOTICE_TITLE = 'SKAZ';
export const PROACTIVE_NOTICE_BODY = 'You may be being asked something. Open SKAZ to see the card.';
/** At most one notification in this window, however many cards arrive. */
export const PROACTIVE_NOTICE_INTERVAL_MS = 5_000;

/** Options for one notification, or null when none should be shown. */
export function proactiveNotice(
  sound: unknown,
  state: { focused: boolean; lastShownAt: number | null; now: number },
): ProactiveNoticeOptions | null {
  if (state.focused) return null;
  if (state.lastShownAt !== null && state.now - state.lastShownAt < PROACTIVE_NOTICE_INTERVAL_MS) return null;
  // Sound is off unless the renderer sent exactly `true`.
  return { title: PROACTIVE_NOTICE_TITLE, body: PROACTIVE_NOTICE_BODY, silent: sound !== true };
}
