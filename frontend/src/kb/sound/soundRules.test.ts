import { describe, expect, it } from 'vitest';
import { answerDone, answerRunning, finished, materialDone, materialRunning, shouldPlay, type Tracked } from './soundRules';

const ctx = { enabled: true, focused: true, tookMs: 0, capturingSystemAudio: false };

describe('shouldPlay', () => {
  it('is silent when sounds are off or the computer sound is being recorded', () => {
    expect(shouldPlay('error', { ...ctx, enabled: false })).toBe(false);
    expect(shouldPlay('error', { ...ctx, capturingSystemAudio: true })).toBe(false);
  });

  it('an error always sounds; an answer only when unfocused or slow', () => {
    expect(shouldPlay('error', ctx)).toBe(true);
    expect(shouldPlay('answer', ctx)).toBe(false);
    expect(shouldPlay('answer', { ...ctx, tookMs: 6000 })).toBe(true);
    expect(shouldPlay('materials', { ...ctx, focused: false })).toBe(true);
  });
});

describe('finished', () => {
  it('reports streaming → done as an answer with its duration, → failed as an error', () => {
    const prev = new Map<string, Tracked>([['a', { state: 'streaming', since: 1000 }], ['b', { state: 'streaming', since: 2000 }]]);
    const { events, next } = finished(prev, [{ id: 'a', state: 'done' }, { id: 'b', state: 'failed' }], answerRunning, answerDone, 9000);
    expect(events).toEqual([{ sound: 'answer', tookMs: 8000 }, { sound: 'error', tookMs: 7000 }]);
    expect(next.get('a')).toEqual({ state: 'done', since: 9000 });
  });

  it('never plays for history that appears already finished, or for a stop by the user', () => {
    expect(finished(new Map(), [{ id: 'a', state: 'done' }], answerRunning, answerDone, 5).events).toEqual([]);
    const prev = new Map<string, Tracked>([['a', { state: 'streaming', since: 0 }]]);
    expect(finished(prev, [{ id: 'a', state: 'cancelled' }], answerRunning, answerDone, 5).events).toEqual([]);
  });

  it('keeps the start time while the state does not change', () => {
    const prev = new Map<string, Tracked>([['m', { state: 'processing', since: 100 }]]);
    expect(finished(prev, [{ id: 'm', state: 'processing' }], materialRunning, materialDone, 900).next.get('m')).toEqual({ state: 'processing', since: 100 });
    expect(finished(prev, [{ id: 'm', state: 'in_wiki' }], materialRunning, materialDone, 900).events).toEqual([{ sound: 'materials', tookMs: 800 }]);
  });
});
