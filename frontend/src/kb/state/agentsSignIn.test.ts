// C-12: a sign-in follower that was stopped (a newer "Sign in again") does nothing with the answer
// it was still waiting for: no check, no result line, and the newer follower stays stoppable.
import { describe, expect, it, vi } from 'vitest';
import type { KbAgent } from '../../api/kb/types.gen';
import type { KbClient } from '../api/client';
import { createAgentsStore } from './agents';

interface Pending { route: string; resolve: (value: unknown) => void }

/** Every request waits until the test answers it. */
function deferredClient() {
  const pending: Pending[] = [];
  const call = vi.fn((route: string) => new Promise((resolve) => { pending.push({ route, resolve }); }));
  const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
  /** Answer the oldest open request to `route`. */
  const answer = async (route: string, value: unknown) => {
    const index = pending.findIndex((p) => p.route === route);
    expect(index, `an open ${route}`).toBeGreaterThanOrEqual(0);
    pending.splice(index, 1)[0]!.resolve(value);
    await flush();
  };
  const sent = (route: string) => call.mock.calls.filter(([r]) => r === route).length;
  return { client: { call } as unknown as KbClient, answer, sent, flush };
}

const LOGIN = 'POST /kb/agents/{engine}/login';
const WAIT = 'GET /kb/agents/{engine}/sign-in';
const CHECK = 'POST /kb/agents/{engine}/check';
const started = { engine: 'codex', method: 'browser', url: null, message: 'Finish in the browser.' };
const done = { engine: 'codex', method: 'browser', state: 'done' };

describe('Sign-in follower', () => {
  it('a stopped follower ignores its late answer; the newer one is still stopped by the next sign-in', async () => {
    const fake = deferredClient();
    const store = createAgentsStore(fake.client, { now: () => 1_000_000, hidden: () => false });
    const signIn = async () => {
      const result = store.getState().login('codex', false);
      await fake.answer(LOGIN, started);
      await result;
      await fake.flush();
    };

    await signIn();
    expect(fake.sent(WAIT)).toBe(1);
    await signIn(); // "Sign in again" while the first wait is still open
    expect(fake.sent(WAIT)).toBe(2);

    await fake.answer(WAIT, done); // the first, stopped follower's answer
    expect(fake.sent(CHECK)).toBe(0);
    expect(store.getState().signIns.codex?.state).toBe('waiting');

    await signIn(); // must stop the second follower
    await fake.answer(WAIT, done); // the second follower's answer: stopped too
    expect(fake.sent(CHECK)).toBe(0);

    await fake.answer(WAIT, done); // the live follower
    expect(fake.sent(CHECK)).toBe(1);
    await fake.answer(CHECK, { id: 'codex', signed_in: true, state: 'ready' } as unknown as KbAgent);
    expect(store.getState().signIns.codex?.state).not.toBe('waiting');
    expect(fake.sent(WAIT)).toBe(3);
  });
});
