import { describe, expect, it, vi } from 'vitest';
import { BackgroundJobs, POLL_MS, TRAY_SOURCE, trayLine, type JobSummary } from './backgroundJobs';

const job = (over: Partial<JobSummary> = {}): JobSummary => ({
  owner: 'weekly', state: 'running', stage: 'collect', updated_at: '2026-11-11T10:00:00Z', ...over,
});

function harness(answers: unknown[]) {
  const getJson = vi.fn(async () => answers.shift() ?? null);
  const blocker = { start: vi.fn(() => 7), stop: vi.fn() };
  const tray = { set: vi.fn() };
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const jobs = new BackgroundJobs({
    getJson, blocker, tray,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: vi.fn(),
  });
  return { jobs, getJson, blocker, tray, intervals };
}

describe('background jobs keep the Mac awake and show in the tray (0.4.0 W4)', () => {
  it('names the job kind and stage, never the title (a research title is the user’s own text)', () => {
    expect(trayLine([job()])).toBe('Weekly check · collecting');
    expect(trayLine([job({ owner: 'links', stage: 'links' })])).toBe('Checking links');
    expect(trayLine([job({ owner: 'research', stage: 'novelty', updated_at: '2026-11-11T11:00:00Z' }), job()]))
      .toBe('Research task · checking novelty · +1 more');
    expect(trayLine([job({ state: 'paused' }), job({ state: 'done' })])).toBeNull();
  });

  it('holds the Mac awake while a job runs and lets go when none does', async () => {
    const h = harness([{ jobs: [job()] }, { jobs: [job()] }, { jobs: [job({ state: 'done' })] }]);
    h.jobs.start();
    await vi.waitFor(() => expect(h.blocker.start).toHaveBeenCalledTimes(1));
    expect(h.intervals[0]!.ms).toBe(POLL_MS);
    expect(h.tray.set).toHaveBeenLastCalledWith(TRAY_SOURCE, 'Weekly check · collecting');
    await h.jobs.poll();
    expect(h.blocker.start).toHaveBeenCalledTimes(1); // one blocker, not one per poll
    await h.jobs.poll();
    expect(h.blocker.stop).toHaveBeenCalledWith(7);
    expect(h.jobs.holdingAwake).toBe(false);
    expect(h.tray.set).toHaveBeenLastCalledWith(TRAY_SOURCE, null);
  });

  it('a backend that does not answer never leaves the blocker on', async () => {
    const h = harness([{ jobs: [job()] }, null]);
    await h.jobs.poll();
    expect(h.jobs.holdingAwake).toBe(true);
    await h.jobs.poll();
    expect(h.jobs.holdingAwake).toBe(false);
    expect(h.blocker.stop).toHaveBeenCalledWith(7);
  });

  it('ignores malformed answers and releases on stop', async () => {
    const h = harness([{ jobs: [job(), { owner: 1 }] }]);
    await h.jobs.poll();
    expect(h.tray.set).toHaveBeenLastCalledWith(TRAY_SOURCE, 'Weekly check · collecting');
    h.jobs.stop();
    expect(h.blocker.stop).toHaveBeenCalledWith(7);
    expect(h.tray.set).toHaveBeenLastCalledWith(TRAY_SOURCE, null);
  });
});
