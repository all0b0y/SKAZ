import { describe, expect, it, vi } from 'vitest';
import { createFakeKb } from '../api/fake';
import { scenes } from '../api/fake/scenes';
import { contractFixtures as f } from '../api/fake/fixtures';
import type { KbResearchTask, KbResearchTasks } from '../../api/kb/types.gen';
import { createServices } from '../state/context';
import { createFakeBridge } from '../test/fakeBridge';
import { bindResearchApi } from './store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function setup() {
  const api = createFakeKb('research_budget');
  const services = createServices(createFakeBridge().bridge, null, { capture: null });
  const store = bindResearchApi(services.client, api);
  return { api, store };
}

describe('FX-D research review regressions', () => {
  it('R3-09 consumes research task cursors so the sidebar includes later tasks', async () => {
    const { api, store } = setup();
    const first = scenes.research_budget.task;
    const later = { ...first, id: 'later-task', title: 'Later task' };
    api.research.tasks = vi.fn(async (q) => ({ tasks: q?.cursor ? [later] : [first], next_cursor: q?.cursor ? null : 'page-two' }));
    expect(await store.getState().loadTasks()).toHaveLength(2);
    expect(api.research.tasks).toHaveBeenLastCalledWith({ cursor: 'page-two' });
    expect(store.getState().tasksById[later.id]).toEqual(later);
  });

  it.each(['detail', 'list'] as const)('R3-11 rejects an older %s response arriving after Continue', async (kind) => {
    const { api, store } = setup();
    const paused = { ...structuredClone(scenes.research_budget.task), run: { ...scenes.research_budget.task.run,
      checkpoint: { ...f.KbFunnelRun.checkpoint!, id: 'checkpoint-old', revision: 1 } } };
    const running: KbResearchTask = { ...paused, run: { ...paused.run, state: 'running', checkpoint: null, updated_at: '2026-11-09T10:00:01Z' } };
    store.getState().upsertTask(paused);
    const detail = deferred<KbResearchTask>();
    const list = deferred<KbResearchTasks>();
    api.research.task = () => detail.promise;
    api.research.tasks = () => list.promise;
    api.research.resume = async () => running;
    const reading = kind === 'detail' ? store.getState().loadTask(paused.id) : store.getState().loadTasks();
    await store.getState().resumeTask(paused.id);
    detail.resolve(paused); list.resolve({ tasks: [paused], next_cursor: null });
    await reading;
    expect(store.getState().tasksById[paused.id]!.run.state).toBe('running');
    expect(store.getState().tasks[0]!.run.checkpoint).toBeNull();
  });
});
