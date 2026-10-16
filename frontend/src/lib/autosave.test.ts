import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Autosave, type SaveStatus } from './autosave';

const harness = (save: (content: string) => Promise<void>) => {
  const statuses: SaveStatus[] = [];
  const errors: string[] = [];
  const autosave = new Autosave({
    save,
    onStatus: (status, error) => {
      statuses.push(status);
      if (error) errors.push(error);
    },
    delayMs: 2_000,
  });
  return { autosave, statuses, errors };
};

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves on its own once typing stops', async () => {
    const saved: string[] = [];
    const { autosave, statuses } = harness(async (content) => void saved.push(content));
    autosave.change('первая строка');
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(saved).toEqual(['первая строка']);
    expect(statuses).toEqual(['dirty', 'saving', 'saved']);
  });

  it('does not save mid-word: each keystroke restarts the wait', async () => {
    const saved: string[] = [];
    const { autosave } = harness(async (content) => void saved.push(content));
    autosave.change('пер');
    await vi.advanceTimersByTimeAsync(1_500);
    autosave.change('первая');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(saved).toEqual(['первая']);
  });

  it('writes immediately on an explicit flush', async () => {
    const saved: string[] = [];
    const { autosave } = harness(async (content) => void saved.push(content));
    autosave.change('текст');
    await autosave.flush();
    expect(saved).toEqual(['текст']);
  });

  it('flushing with nothing pending writes nothing', async () => {
    const saved: string[] = [];
    const { autosave } = harness(async (content) => void saved.push(content));
    await autosave.flush();
    expect(saved).toEqual([]);
  });

  it('never runs two writes of the same note at once', async () => {
    const waiting: Array<() => void> = [];
    const active: string[] = [];
    let concurrent = 0;
    let peak = 0;
    const { autosave } = harness(async (content) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      active.push(content);
      await new Promise<void>((resolve) => void waiting.push(resolve));
      concurrent -= 1;
    });
    autosave.change('первая версия');
    const first = autosave.flush();
    // Let the save actually start before typing again.
    await Promise.resolve();
    autosave.change('вторая версия');
    await autosave.flush();
    // Release each write as it starts; the queued one only begins after the first ends.
    while (waiting.length || concurrent > 0) {
      waiting.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    }
    await first;
    expect(peak).toBe(1);
    // What the user typed last is what ends up stored.
    expect(active.at(-1)).toBe('вторая версия');
  });

  it('keeps the text dirty when a save fails instead of pretending it landed', async () => {
    const { autosave, statuses, errors } = harness(async () => {
      throw new Error('Диск недоступен');
    });
    autosave.change('важный конспект');
    await autosave.flush();
    expect(statuses).toContain('error');
    expect(statuses).not.toContain('saved');
    expect(errors[0]).toBe('Диск недоступен');
    expect(autosave.isDirty).toBe(true);
  });

  it('retries the failed text on the next flush rather than losing it', async () => {
    const saved: string[] = [];
    let fail = true;
    const { autosave } = harness(async (content) => {
      if (fail) throw new Error('Временная ошибка');
      saved.push(content);
    });
    autosave.change('конспект лекции');
    await autosave.flush();
    fail = false;
    await autosave.flush();
    expect(saved).toEqual(['конспект лекции']);
  });

  it('stops scheduling once disposed', async () => {
    const saved: string[] = [];
    const { autosave } = harness(async (content) => void saved.push(content));
    autosave.change('текст');
    autosave.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(saved).toEqual([]);
  });
});
