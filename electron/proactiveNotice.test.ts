import { describe, expect, it } from 'vitest';
import { PROACTIVE_NOTICE_BODY, PROACTIVE_NOTICE_INTERVAL_MS, proactiveNotice } from './proactiveNotice';

const away = { focused: false, lastShownAt: null, now: 10_000 };

describe('proactive system notification', () => {
  it('carries only fixed text, never conversation content', () => {
    const options = proactiveNotice(true, away);
    expect(options).toEqual({ title: 'SKAZ', body: PROACTIVE_NOTICE_BODY, silent: false });
    // Whatever the renderer sends, only the sound flag is read from it.
    const smuggled = proactiveNotice({ body: 'Alex, what is the budget?' } as unknown, away);
    expect(JSON.stringify(smuggled)).not.toContain('budget');
    expect(smuggled?.body).toBe(PROACTIVE_NOTICE_BODY);
  });

  it('is silent unless sound was explicitly enabled', () => {
    expect(proactiveNotice(false, away)?.silent).toBe(true);
    expect(proactiveNotice(undefined, away)?.silent).toBe(true);
    expect(proactiveNotice('true', away)?.silent).toBe(true);
    expect(proactiveNotice(true, away)?.silent).toBe(false);
  });

  it('is not shown while SKAZ is in focus, and is rate limited', () => {
    expect(proactiveNotice(true, { ...away, focused: true })).toBeNull();
    expect(proactiveNotice(true, { focused: false, lastShownAt: 9_000, now: 10_000 })).toBeNull();
    expect(proactiveNotice(true, {
      focused: false, lastShownAt: 10_000 - PROACTIVE_NOTICE_INTERVAL_MS, now: 10_000,
    })).not.toBeNull();
  });
});
