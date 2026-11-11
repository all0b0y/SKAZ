import { describe, expect, it, vi } from 'vitest';
import { NAVIGATION_ACTIONS, runNavigation } from './navigation';

const openTask = vi.fn();
vi.mock('../research/store', () => ({ getResearchStore: () => ({ getState: () => ({ openTask }) }) }));

function services(call: (route: string, options?: unknown) => Promise<unknown>) {
  const set = vi.fn();
  const client = { call: vi.fn(call) };
  const open = vi.fn();
  const ui = { docExpanded: true, toggleDocExpanded: vi.fn(), showCenter: vi.fn() };
  return {
    set, client, open, ui,
    svc: { client, prefs: { getState: () => ({ set }) }, chats: { getState: () => ({ open }) }, ui: { getState: () => ui } } as never,
  };
}

describe('navigation buttons of notifications (0.4.0 B2, B6)', () => {
  it('lists every navigation action the backend sends', () => {
    expect([...NAVIGATION_ACTIONS].sort()).toEqual(['check_novelty', 'open_explore', 'open_research_task', 'review_updates', 'view_check']);
  });

  it('Open in Explore and View check open Explore; Review source updates opens All materials; nothing is resolved', async () => {
    const s = services(async () => { throw new Error('no call expected'); });
    expect(await runNavigation(s.svc, { payload: {} }, 'open_explore')).toEqual({ ok: true });
    expect(s.set).toHaveBeenLastCalledWith({ section: 'explore', sideOpen: true });
    await runNavigation(s.svc, { payload: { job_id: 'job-1' } }, 'view_check');
    expect(s.set).toHaveBeenLastCalledWith({ section: 'explore', sideOpen: true });
    await runNavigation(s.svc, { payload: {} }, 'review_updates');
    expect(s.set).toHaveBeenLastCalledWith({ section: 'materials', sideOpen: true });
    expect(s.client.call).not.toHaveBeenCalled();
  });

  it('Check novelty starts one run over the waiting candidates, on this click only', async () => {
    const s = services(async (route) => {
      if (route === 'GET /kb/freshness/weekly-checks/{check_id}') return { candidate_ids: ['cand-1', 'cand-2'] };
      if (route === 'POST /kb/explore/runs') return { id: 'run-9' };
      throw new Error(route);
    });
    expect(await runNavigation(s.svc, { payload: { job_id: 'job-1' } }, 'check_novelty')).toEqual({ ok: true });
    expect(s.client.call).toHaveBeenCalledWith('POST /kb/explore/runs', { body: { candidate_ids: ['cand-1', 'cand-2'], channels: [] } });
    expect(s.set).toHaveBeenLastCalledWith({ section: 'explore', sideOpen: true });
  });

  it('says so when nothing waits any more or the check is gone, and starts nothing', async () => {
    const empty = services(async () => ({ candidate_ids: [] }));
    expect(await runNavigation(empty.svc, { payload: { job_id: 'job-1' } }, 'check_novelty'))
      .toEqual({ ok: false, error: 'No candidates are waiting any more.' });
    expect(empty.client.call).toHaveBeenCalledTimes(1);
    const gone = services(async () => { throw new Error('This check wasn’t found.'); });
    expect(await runNavigation(gone.svc, { payload: { job_id: 'job-1' } }, 'check_novelty'))
      .toEqual({ ok: false, error: 'This check wasn’t found.' });
    expect(await runNavigation(gone.svc, { payload: {} }, 'check_novelty'))
      .toEqual({ ok: false, error: 'This check is no longer available.' });
  });

  it('Open task opens the research task view in the chat centre, over an expanded document (R3-14)', async () => {
    const s = services(async () => { throw new Error('no call expected'); });
    expect(await runNavigation(s.svc, { payload: { task_id: 't-1', chat_id: 'chat-7' } }, 'open_research_task')).toEqual({ ok: true });
    expect(s.set).toHaveBeenLastCalledWith({ section: 'chats', sideOpen: true });
    expect(s.ui.showCenter).toHaveBeenCalledWith('chat');
    expect(s.ui.toggleDocExpanded).toHaveBeenCalled();
    expect(openTask).toHaveBeenCalledWith('t-1');
    expect(await runNavigation(s.svc, { payload: {} }, 'open_research_task'))
      .toEqual({ ok: false, error: 'This task is no longer available.' });
  });

  it('Review source updates shows All materials in the centre (R3-14)', async () => {
    const s = services(async () => { throw new Error('no call expected'); });
    await runNavigation(s.svc, { payload: {} }, 'review_updates');
    expect(s.ui.showCenter).toHaveBeenCalledWith('materials');
  });
});
