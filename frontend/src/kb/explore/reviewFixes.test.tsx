import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KbAreaMap, KbAreaMaterials, KbExploreJob, KbFindings, KbJobSummary } from '../../api/kb/types.gen';
import { KbApiError } from '../api/client';
import { createFakeKb } from '../api/fake';
import { contractFixtures as f } from '../api/fake/fixtures';
import { scenes } from '../api/fake/scenes';
import { runNavigation } from '../notifications/navigation';
import { getResearchStore } from '../research/store';
import { Shell } from '../shell/Shell';
import { createServices, KbServicesProvider } from '../state/context';
import { createFakeBridge, chatWorld } from '../test/fakeBridge';
import { MotionProvider } from '../ui';
import { ExploreSection } from './ExploreSection';

afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });
const flush = () => act(async () => { await Promise.resolve(); });
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(1000); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const emptyFindings: KbFindings = { ...f.KbFindings, groups: [], next_cursor: null };
const checkpoint = f.KbFunnelRun.checkpoint!;
const summary = (job: KbExploreJob): KbJobSummary => ({
  ...f.KbJobs.jobs[0]!, ...job, task_id: null, chat_id: null, area_id: 'area-ai',
});

function shell() {
  const base = createFakeBridge(chatWorld());
  const fallback = base.requestMock.getMockImplementation()!;
  const chatId = base.world.chats[0]!.id;
  base.requestMock.mockImplementation(async (req) => {
    const answers: Record<string, unknown> = {
      '/kb/explore/map': scenes.home.map,
      '/kb/explore/findings': scenes.home.findings,
      '/kb/explore/exploring': { items: [] },
      '/kb/explore/jobs': { jobs: [] },
      '/kb/settings/science': f.KbScienceSettings,
      '/kb/settings/weekly-check': { ...f.KbWeeklySettings, enabled: false },
      '/kb/explore/findings/finding-contradicts': scenes.find.finding,
      '/kb/explore/findings/finding-contradicts/explore': { ...f.KbExploring, chat_id: chatId },
    };
    if (req.path in answers) return { ok: true, status: 200, data: structuredClone(answers[req.path]) };
    return fallback(req);
  });
  const services = createServices(base.bridge, null, { capture: null });
  services.prefs.getState().set({ section: 'explore' });
  const view = render(<KbServicesProvider services={services}><MotionProvider><Shell /></MotionProvider></KbServicesProvider>);
  return { base, services, chatId, ...view };
}

describe('FX-D review regressions', () => {
  it.each(['Brief tour', 'Deep dive', 'Notes', 'Open chat'])('R3-02 reveals the selected chat through Shell: %s', async (action) => {
    const { services, base, chatId } = shell();
    // A cached research overlay for this same chat must also close.
    await act(async () => { await services.chats.getState().open(chatId); });
    act(() => getResearchStore(services.client).getState().openNewTask());
    fireEvent.click(await screen.findByRole('button', { name: /Self-correction in LLMs does not/ }));
    if (action === 'Open chat') {
      const fallback = base.requestMock.getMockImplementation()!;
      base.requestMock.mockImplementation(async (req) => req.path === '/kb/explore/exploring'
        ? { ok: true, status: 200, data: { items: [{ ...f.KbExploring, finding_id: 'finding-contradicts', chat_id: chatId }] } }
        : fallback(req));
      // Reopen to re-read the persisted Exploring entry.
      fireEvent.click(await screen.findByRole('button', { name: 'New' }));
      fireEvent.click(await screen.findByRole('button', { name: /Self-correction in LLMs does not/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Open chat' }));
    } else {
      fireEvent.click(within(await screen.findByLabelText('Finding details')).getByRole('button', { name: 'Explore' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(action) }));
    }
    await flush();
    expect(document.querySelector('[data-pane="explore"]')).toBeNull();
    expect(screen.getByRole('region', { name: 'Chat' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Research task' })).toBeNull();
    expect(services.chats.getState().currentId).toBe(chatId);
  });

  it('R3-03 refreshes findings and map when a run completes', async () => {
    vi.useFakeTimers();
    const kb = createFakeKb('area');
    let done = false;
    kb.explore.jobs = async () => ({ jobs: done ? [] : [summary(scenes.searching.run)] });
    kb.explore.run = async () => structuredClone(done ? scenes.done.run : scenes.searching.run);
    kb.explore.findings = async () => structuredClone(done ? scenes.home.findings : emptyFindings);
    const map = vi.spyOn(kb.areas, 'map').mockImplementation(async () => ({ ...scenes.area.map,
      areas: scenes.area.map.areas.map((area) => ({ ...area, new_findings: done ? 99 : 0 })),
    }));
    render(<ExploreSection clients={kb} />);
    await flush();
    const calls = map.mock.calls.length;
    done = true;
    await tick();
    expect(screen.getByText('Done just now')).toBeInTheDocument();
    expect(screen.getByText('Claim-level grounding for long-lived agent memory')).toBeInTheDocument();
    expect(map.mock.calls.length).toBeGreaterThan(calls);
    fireEvent.mouseEnter(screen.getByRole('button', { name: /Artificial Intelligence/ }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('99 new');
  });

  it('R3-03 refreshes findings when a research job leaves the active list', async () => {
    vi.useFakeTimers();
    const kb = createFakeKb('home');
    let done = false;
    kb.explore.jobs = async () => ({ jobs: done ? [] : [{ ...summary(scenes.searching.run), owner: 'research' }] });
    kb.explore.findings = async () => structuredClone(done ? scenes.home.findings : emptyFindings);
    render(<ExploreSection clients={kb} />);
    await flush();
    done = true;
    await tick();
    expect(screen.getByText('Claim-level grounding for long-lived agent memory')).toBeInTheDocument();
  });

  it('R3-04 reattaches, polls and continues a repeat check, then reloads material summaries', async () => {
    vi.useFakeTimers();
    const kb = createFakeKb('topic');
    let state = 'running';
    kb.explore.jobs = async () => ({ jobs: state === 'done' ? [] : [summary(f.KbRepeatCheck)] });
    const paused = { ...f.KbRepeatCheck, area_id: 'topic-rag', state: 'paused' as const, stop_reason: 'decision_model_required' as const,
      decision_choices: ['download_local' as const], checkpoint };
    kb.repeats.check = vi.fn(async () => state === 'paused' ? paused : { ...paused, state: state as 'running' | 'done', stop_reason: null });
    const resume = vi.spyOn(kb.repeats, 'resume').mockImplementation(async () => { state = 'done'; return { ...paused, state: 'done' }; });
    const materials = vi.spyOn(kb.areas, 'materials');
    render(<ExploreSection clients={kb} initial={{ topicId: 'topic-rag' }} />);
    await flush();
    expect(screen.getByText('Checking older materials')).toBeInTheDocument();
    state = 'paused';
    await tick();
    expect(screen.getByText('Repeat check paused')).toBeInTheDocument();
    const count = materials.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Download local model/ }));
    await flush();
    expect(resume).toHaveBeenCalledWith(paused.id, { checkpoint_id: checkpoint.id, revision: checkpoint.revision, decision_choice: 'download_local' });
    expect(materials.mock.calls.length).toBeGreaterThan(count);
  });

  it('R3-04 polls a started check through its budget pause and reattaches after reopening', async () => {
    vi.useFakeTimers();
    const kb = createFakeKb('topic');
    let started = false;
    let paused = false;
    const check = () => ({ ...f.KbRepeatCheck, area_id: 'topic-rag', state: paused ? 'paused' as const : 'running' as const,
      stop_reason: paused ? 'budget' as const : null, checkpoint: paused ? checkpoint : null, materials_checked: paused ? 3 : 1 });
    kb.explore.jobs = async () => ({ jobs: started ? [summary(check())] : [] });
    kb.repeats.check = async () => check();
    kb.repeats.start = async () => { started = true; return check(); };
    const view = render(<ExploreSection clients={kb} initial={{ topicId: 'topic-rag' }} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Check older materials' }));
    await flush();
    paused = true;
    await tick();
    expect(screen.getByText('Repeat check paused')).toBeInTheDocument();
    expect(screen.getByText(/3 of .* materials checked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    view.unmount();
    render(<ExploreSection clients={kb} initial={{ topicId: 'topic-rag' }} />);
    await flush();
    expect(screen.getByText('Repeat check paused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('R3-05 preserves the notified weekly check id and allows checkpoint recovery', async () => {
    const { services, base } = shell();
    const fallback = base.requestMock.getMockImplementation()!;
    const check = { ...f.KbWeeklyCheck, id: 'notified-weekly', state: 'paused' as const,
      stop_reason: 'science_consent_required' as const, checkpoint };
    base.requestMock.mockImplementation(async (req) => req.path.startsWith('/kb/freshness/weekly-checks/notified-weekly')
      ? { ok: true, status: 200, data: { ...check, ...(req.method === 'POST' ? { state: 'running' } : {}) } }
      : fallback(req));
    await act(async () => { await runNavigation(services, { payload: { job_id: check.id } }, 'view_check'); });
    expect(await screen.findByText('Weekly check paused')).toBeInTheDocument();
    const panel = screen.getByRole('region', { name: 'Weekly check' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Continue' }));
    await flush();
    expect(base.requestMock).toHaveBeenCalledWith(expect.objectContaining({
      path: '/kb/freshness/weekly-checks/notified-weekly/continue', method: 'POST',
      body: { checkpoint_id: checkpoint.id, revision: checkpoint.revision },
    }));
  });

  it('R3-05 discovers and polls a persisted weekly check when reopened', async () => {
    vi.useFakeTimers();
    const kb = createFakeKb('home');
    kb.explore.jobs = async () => ({ jobs: [summary(f.KbWeeklyCheck)] });
    let paused = false;
    kb.maintenance.check = async () => ({ ...f.KbWeeklyCheck, state: paused ? 'paused' : 'running', stop_reason: paused ? 'provider_unavailable' : null, checkpoint });
    render(<ExploreSection clients={kb} />);
    await flush();
    expect(screen.getByText('Weekly check running')).toBeInTheDocument();
    paused = true;
    await tick();
    expect(screen.getByText('Weekly check paused')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Weekly check' })).getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it.each(['science_consent_required', 'openalex_daily_limit'] as const)('R3-06 offers Continue and Cancel after %s and reads the latest checkpoint', async (stop_reason) => {
    const kb = createFakeKb('home');
    kb.explore.jobs = async () => ({ jobs: [] });
    const run = { ...scenes.searching.run, state: 'paused' as const, stop_reason, retry_at: '2020-01-01T00:00:00Z', checkpoint };
    kb.explore.run = async () => ({ ...run, checkpoint: { ...checkpoint, revision: 2 } });
    const resume = vi.spyOn(kb.explore, 'resume').mockResolvedValue(scenes.searching.run);
    render(<ExploreSection clients={kb} initial={{ run }} />);
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeEnabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await flush();
    expect(resume).toHaveBeenCalledWith(run.id, { checkpoint_id: checkpoint.id, revision: 2 });
  });

  it('R3-07 rejects late leaf responses and reloads the parent when moving up', async () => {
    const kb = createFakeKb('topic');
    kb.explore.jobs = async () => ({ jobs: [] });
    const slowMaterials = deferred<KbAreaMaterials>();
    const slowFindings = deferred<KbFindings>();
    kb.areas.materials = async (id) => id === 'topic-rag' ? slowMaterials.promise : { ...scenes.topic.materials, materials: [{ ...scenes.topic.materials.materials[0]!, title: id === 'area-ai' ? 'Parent material' : 'B material' }] };
    kb.explore.findings = async (q) => q?.area_id === 'topic-rag' ? slowFindings.promise : emptyFindings;
    render(<ExploreSection clients={kb} />);
    fireEvent.click(await screen.findByRole('button', { name: /Retrieval-augmented generation/ }));
    fireEvent.click(screen.getByRole('button', { name: /LLM agents and tool use/ }));
    expect(await screen.findByText('B material')).toBeInTheDocument();
    await act(async () => { slowMaterials.resolve(scenes.topic.materials); slowFindings.resolve(scenes.home.findings); });
    expect(screen.queryByText('RAG beyond the basics')).toBeNull();
    expect(screen.queryByText('Claim-level grounding for long-lived agent memory')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Up a level' }));
    fireEvent.click(await screen.findByRole('tab', { name: /Your materials/ }));
    expect(await screen.findByText('Parent material')).toBeInTheDocument();
    expect(screen.queryByText('B material')).toBeNull();
  });

  it('R3-07 clears preceding scope data if the next leaf fails', async () => {
    const kb = createFakeKb('topic');
    kb.explore.jobs = async () => ({ jobs: [] });
    render(<ExploreSection clients={kb} initial={{ topicId: 'topic-rag' }} />);
    expect(await screen.findByText('RAG beyond the basics')).toBeInTheDocument();
    kb.areas.materials = async () => { throw new KbApiError(503, 'private material text', 'not_ready'); };
    fireEvent.click(screen.getByRole('button', { name: /LLM agents and tool use/ }));
    await flush();
    expect(screen.queryByText('RAG beyond the basics')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(/not ready/i);
  });

  it('R3-08 shows a mandatory load failure and offers retry instead of an empty success', async () => {
    const kb = createFakeKb('home');
    kb.areas.map = async () => { throw new KbApiError(503, 'private material text', 'not_ready'); };
    render(<ExploreSection clients={kb} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/not ready/i);
    expect(screen.queryByText('Nothing new here yet.')).toBeNull();
    expect(screen.queryByText('private material text')).toBeNull();
    kb.areas.map = async () => scenes.home.map;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Physical Sciences/ })).toBeInTheDocument();
  });

  it('R3-08 retries the failed parent scope without substituting the root', async () => {
    const kb = createFakeKb('area');
    kb.explore.jobs = async () => ({ jobs: [] });
    const map = vi.spyOn(kb.areas, 'map').mockRejectedValueOnce(new KbApiError(503, 'private', 'not_ready'));
    render(<ExploreSection clients={kb} initial={{ parentId: 'field-cs' }} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: /Artificial Intelligence/ });
    expect(map).toHaveBeenLastCalledWith({ parent_id: 'field-cs' });
  });

  it.each(['pause', 'cancel', 'resume'] as const)('R3-08 catches %s provider failures without exposing provider detail', async (action) => {
    const kb = createFakeKb('home');
    kb.explore.jobs = async () => ({ jobs: [] });
    const run = { ...scenes.searching.run, state: action === 'pause' ? 'running' as const : 'paused' as const,
      stop_reason: 'user_pause' as const, checkpoint };
    kb.explore.run = async () => run;
    kb.explore[action] = async () => { throw new KbApiError(502, 'private provider text', 'provider_unavailable'); };
    render(<ExploreSection clients={kb} initial={{ run }} />);
    fireEvent.click(await screen.findByRole('button', { name: action === 'pause' ? 'Stop' : action === 'cancel' ? 'Cancel' : 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/provider is unavailable/i);
    expect(screen.queryByText('private provider text')).toBeNull();
  });

  it('R3-08 explains consent failure before a run exists and routes to Settings', async () => {
    const kb = createFakeKb('home');
    kb.explore.jobs = async () => ({ jobs: [] });
    kb.explore.start = async () => { throw new KbApiError(403, 'untrusted payload', 'consent_required'); };
    const settings = vi.fn();
    render(<ExploreSection clients={kb} onOpenSettings={settings} />);
    await screen.findByRole('button', { name: /Physical Sciences/ });
    fireEvent.click(screen.getByRole('button', { name: /Find what's new/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/permission/i);
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(settings).toHaveBeenCalledWith('search');
  });

  it('R3-08 explains HTTP consent_required from the map and opens Settings → Search', async () => {
    const kb = createFakeKb('home');
    kb.explore.jobs = async () => ({ jobs: [] });
    kb.areas.map = async () => { throw new KbApiError(403, 'untrusted map detail', 'consent_required'); };
    const settings = vi.fn();
    render(<ExploreSection clients={kb} onOpenSettings={settings} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/permission/i);
    expect(screen.queryByText('Nothing new here yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(settings).toHaveBeenCalledWith('search');
  });

  it('R3-08 catches stale-checkpoint conflicts and refreshes the paused run', async () => {
    const kb = createFakeKb('home');
    kb.explore.jobs = async () => ({ jobs: [] });
    const run = { ...scenes.searching.run, state: 'paused' as const, stop_reason: 'user_pause' as const, checkpoint };
    const read = vi.spyOn(kb.explore, 'run').mockResolvedValue(run);
    kb.explore.resume = async () => { throw new KbApiError(409, 'conflict details', 'conflict'); };
    render(<ExploreSection clients={kb} initial={{ run }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed/i);
    expect(read.mock.calls.length).toBeGreaterThan(1);
  });

  it('R3-09 exposes the next findings and materials pages', async () => {
    const kb = createFakeKb('topic');
    kb.explore.jobs = async () => ({ jobs: [] });
    const laterFinding = { ...scenes.home.findings.groups[0]!.findings[0]!, id: 'later-finding', work: { ...f.KbFinding.work, title: 'Page two finding' } };
    kb.explore.findings = async (q) => ({ ...emptyFindings, next_cursor: q?.cursor ? null : 'findings-next', groups: q?.cursor ? [{ ...scenes.home.findings.groups[0]!, findings: [laterFinding] }] : [] });
    kb.areas.materials = async (_, q) => ({ ...scenes.topic.materials, next_cursor: q?.cursor ? null : 'materials-next', materials: q?.cursor ? [{ ...scenes.topic.materials.materials[0]!, material_id: 'later', title: 'Page two material' }] : scenes.topic.materials.materials });
    render(<ExploreSection clients={kb} initial={{ topicId: 'topic-rag' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more materials' }));
    expect(await screen.findByText('Page two material')).toBeInTheDocument();
    expect(screen.getByText('RAG beyond the basics')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /^New/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more findings' }));
    expect(await screen.findByText('Page two finding')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more findings' })).toBeNull();
  });

  it('R3-09 keeps loaded pages when job progress refreshes the current scope', async () => {
    vi.useFakeTimers();
    const kb = createFakeKb('topic');
    let changed = false;
    kb.explore.jobs = async () => ({ jobs: changed ? [{ ...summary(scenes.searching.run), owner: 'research' }] : [] });
    kb.areas.materials = async (_, q) => ({ ...scenes.topic.materials, next_cursor: q?.cursor ? null : 'next', materials: q?.cursor
      ? [{ ...scenes.topic.materials.materials[0]!, material_id: 'later', title: 'Still on page two' }] : scenes.topic.materials.materials });
    render(<ExploreSection clients={kb} initial={{ topicId: 'topic-rag' }} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Load more materials' }));
    await flush();
    changed = true;
    await tick();
    expect(screen.getByText('Still on page two')).toBeInTheDocument();
  });

  it('R3-10 pins and unpins the active area using the saved PATCH response', async () => {
    const kb = createFakeKb('area');
    kb.explore.jobs = async () => ({ jobs: [] });
    const area = scenes.area.map.breadcrumbs.at(-1)!;
    const update = vi.spyOn(kb.areas, 'update').mockImplementation(async (_, patch) => ({ ...area, pinned: patch.pinned ?? false }));
    render(<ExploreSection clients={kb} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pin area for weekly discovery' }));
    expect(await screen.findByRole('button', { name: 'Unpin area from weekly discovery' })).toHaveAttribute('aria-pressed', 'true');
    expect(update).toHaveBeenLastCalledWith(area.id, { pinned: true });
    fireEvent.click(screen.getByRole('button', { name: 'Unpin area from weekly discovery' }));
    expect(await screen.findByRole('button', { name: 'Pin area for weekly discovery' })).toHaveAttribute('aria-pressed', 'false');
    expect(update).toHaveBeenLastCalledWith(area.id, { pinned: false });
  });

  it('R3-10 keeps a saved pin when a map refresh started before PATCH returns late', async () => {
    vi.useFakeTimers();
    const kb = createFakeKb('area');
    let changed = false;
    kb.explore.jobs = async () => ({ jobs: changed ? [{ ...summary(scenes.searching.run), owner: 'research' }] : [] });
    const lateMap = deferred<KbAreaMap>();
    vi.spyOn(kb.areas, 'map').mockResolvedValueOnce(scenes.area.map).mockImplementation(() => lateMap.promise);
    const area = scenes.area.map.breadcrumbs.at(-1)!;
    kb.areas.update = async () => ({ ...area, pinned: true });
    render(<ExploreSection clients={kb} />);
    await flush();
    changed = true;
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Pin area for weekly discovery' }));
    await flush();
    expect(screen.getByRole('button', { name: 'Unpin area from weekly discovery' })).toBeInTheDocument();
    await act(async () => { lateMap.resolve(scenes.area.map); });
    expect(screen.getByRole('button', { name: 'Unpin area from weekly discovery' })).toBeInTheDocument();
  });

  it('R3-12 honors Shell hiding Explore when a document expands with its actual CSS', async () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(__dirname, 'explore.css'), 'utf8');
    document.head.append(style);
    try {
      const { services } = shell();
      await screen.findByRole('button', { name: /Physical Sciences/ });
      act(() => { services.ui.getState().openDocument({ type: 'material', id: 'm-a' }); services.ui.getState().toggleDocExpanded(); });
      const pane = document.querySelector<HTMLElement>('[data-pane="explore"]')!;
      expect(pane.hidden).toBe(true);
      // jsdom's hidden UA rule differs from Chromium's author cascade; verify the author rule too.
      expect(style.textContent).toMatch(/\.kb-explore\[hidden\]\s*\{\s*display:\s*none/);
      expect(getComputedStyle(pane).display).toBe('none');
    } finally { style.remove(); }
  });

  it.each(['light', 'dark'])('R3-13 uses a defined opaque tooltip surface in %s, with every Explore token resolving', (theme) => {
    document.documentElement.dataset.theme = theme;
    const css = readFileSync(resolve(__dirname, 'explore.css'), 'utf8');
    const tokens = readFileSync(resolve(__dirname, '../styles/tokens.css'), 'utf8');
    const defined = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const used = [...css.matchAll(/var\((--(?:kb-|t-)[\w-]+)/g)].map((m) => m[1]);
    expect([...new Set(used)].filter((token) => !defined.has(token))).toEqual([]);
    const tooltip = css.match(/\.kb-explore-map__tooltip\s*\{([^}]+)\}/)![1]!;
    expect(tooltip).toMatch(/background:\s*var\(--kb-pane\)/);
    expect(tooltip).toMatch(/box-shadow:\s*var\(--kb-shadow-pop\)/);
  });
});
