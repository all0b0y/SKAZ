// FX-4/FX-5 (and the FX-1/FX-2 seams the search page shows): the split of the search page and its
// resizable divider, the live line of steps, the words of an empty answer, the Importing… state of
// Add to materials, the honest agent_required stop, and the finished note that is dismissed while
// you are looking at the search it talks about.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonResponse } from '../../api/bridge';
import type { KbNotification, KbSearch } from '../../api/kb/types.gen';
import { KbServicesProvider } from '../state/context';
import {
  createPrefsStore, EXPLORE_LIST_DEFAULT, EXPLORE_LIST_MAX, EXPLORE_LIST_MIN, PREFS_KEY,
} from '../state/prefs';
import { renderKb, storedPrefs } from '../test/renderKb';
import { DEFAULT_FILTERS, writeFilters } from './filters';
import { ExploreSection } from './ExploreSection';
import { exploreState } from './exploreState';
import { SearchPage, importNote, liveSteps, splitTerms, type SearchPageProps } from './SearchPage';
import { exploreClients, exploreHarness, exploreWorld, findingFixture, searchFixture, sent, serveExplore, type ExploreWorld } from './test/fixtures';

// jsdom has no layout: give every element a box, so the treemap has room to place its tiles.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 500 });
});
afterAll(() => {
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); delete (window as { skaz?: unknown }).skaz; });

const reader = () => screen.getByRole('region', { name: 'Paper' });
const row = (title: RegExp) => screen.findByRole('button', { name: title });
const listitem = (title: RegExp) => screen.getByRole('button', { name: title }).closest('[role="listitem"]') as HTMLElement;
const divider = () => screen.getByRole('separator', { name: 'Resize papers list' });
/** The fake bridge's request mock, as the harnesses build it. */
type RequestMock = ReturnType<typeof exploreClients>['request'];

/** The page alone, like SearchPage.test.tsx: the real clients over the fake world, plain props. */
function page(over: { search?: Partial<KbSearch>; world?: Partial<ExploreWorld>; props?: Partial<SearchPageProps> } = {}) {
  writeFilters({ ...DEFAULT_FILTERS, free: false });
  const search = searchFixture('run-1', 'Model architectures', { area_id: 'arch', ...over.search });
  const world = exploreWorld({
    searches: [search],
    findings: [findingFixture('f1', 'RailS: Load Balancing', { run_id: 'run-1' })],
    ...over.world,
  });
  const h = exploreClients(world);
  const toast = vi.fn();
  const props: SearchPageProps = {
    search, scopeName: 'Model architectures', explore: h.clients.explore, parallelLimit: 3,
    listWidth: EXPLORE_LIST_DEFAULT, onListWidth: vi.fn(), onStarted: vi.fn(),
    covered: false, onCovered: vi.fn(), onChanged: vi.fn(), onDiscuss: vi.fn(),
    onOpenDocument: vi.fn(), onOpenSettings: vi.fn(), toast, ...over.props,
  };
  const view = render(<SearchPage {...props} />);
  return { ...h, world, search, props, toast, view, rerender: (next: Partial<SearchPageProps>) => view.rerender(<SearchPage {...props} {...next} />) };
}

/** The whole section on its services, so a test can move its store and read its prefs. */
function section(world: ExploreWorld = exploreWorld({
  searches: [searchFixture('run-1', 'Model architectures', { area_id: 'arch' })],
  findings: [findingFixture('f1', 'RailS: Load Balancing', { run_id: 'run-1' })],
})) {
  const h = exploreHarness(world);
  const view = render(<KbServicesProvider services={h.services}><ExploreSection /></KbServicesProvider>);
  const store = exploreState(h.services.client, async () => ({ items: [], parallel_limit: 3 }));
  return { ...h, world, view, store };
}

/** Open run-1 as the page's search, from the map the section starts on. */
async function openSearch(h: ReturnType<typeof section>) {
  await screen.findByRole('button', { name: /Machine learning/ });
  await act(async () => { await h.store.getState().refresh(); h.store.getState().showSearch('run-1'); });
  await screen.findByRole('region', { name: 'Papers found' });
}

/** Hold one route's answer back until the test releases it, so a busy state can be seen. */
function gate(request: RequestMock, path: string) {
  const original = request.getMockImplementation()!;
  let release!: (value: JsonResponse<unknown>) => void;
  const held = new Promise<JsonResponse<unknown>>((resolve) => { release = resolve; });
  request.mockImplementation(async (req) => (req.path === path ? held : original(req)));
  return { release, original };
}

/** Answer one route from the test instead of the world, and leave the rest to the fake. */
function answer(request: RequestMock, path: string, data: unknown) {
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (req) => (req.path === path ? { ok: true, status: 200, data: structuredClone(data) } : original(req)));
  return original;
}

// ---- FX-4: the list has the page until a paper is picked; the split is kept ------------------------------

describe('FX-4 — the search page splits only when a paper is open', () => {
  it('no paper picked: no reader slot and no divider — the list has the page to itself', async () => {
    const h = section();
    await openSearch(h);
    expect(screen.queryByRole('region', { name: 'Paper' })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize papers list' })).not.toBeInTheDocument();
    expect(document.querySelector('.kb-ex-search')!.className).toContain('is-wide');
    await row(/RailS/);
  });

  it('picking a paper splits the page once: the reader slot and the divider appear, closing gives the page back', async () => {
    const h = section();
    await openSearch(h);
    fireEvent.click(await row(/RailS/));
    expect(reader()).toBeInTheDocument();
    expect(document.querySelector('.kb-ex-search')!.className).not.toContain('is-wide');
    expect(divider()).toHaveAttribute('aria-controls', 'kb-ex-list');
    expect(divider()).toHaveAttribute('aria-valuemin', String(EXPLORE_LIST_MIN));
    expect(divider()).toHaveAttribute('aria-valuemax', String(EXPLORE_LIST_MAX));
    expect(divider()).toHaveAttribute('aria-valuenow', String(EXPLORE_LIST_DEFAULT));
    fireEvent.click(within(reader()).getByRole('button', { name: 'Close paper' }));
    expect(screen.queryByRole('region', { name: 'Paper' })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize papers list' })).not.toBeInTheDocument();
    expect(document.querySelector('.kb-ex-search')!.className).toContain('is-wide');
  });

  it('moving the divider (keyboard: arrows, Home/End) changes the width and keeps it in prefs', async () => {
    const h = section();
    await openSearch(h);
    fireEvent.click(await row(/RailS/));
    const bar = divider();
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(h.services.prefs.getState().exploreListWidth).toBe(EXPLORE_LIST_DEFAULT + 16);
    expect(divider()).toHaveAttribute('aria-valuenow', String(EXPLORE_LIST_DEFAULT + 16));
    fireEvent.keyDown(bar, { key: 'End' });
    expect(h.services.prefs.getState().exploreListWidth).toBe(EXPLORE_LIST_MAX);
    fireEvent.keyDown(bar, { key: 'Home' });
    expect(h.services.prefs.getState().exploreListWidth).toBe(EXPLORE_LIST_MIN);
    expect(divider()).toHaveAttribute('aria-valuenow', String(EXPLORE_LIST_MIN));
  });

  it('the list width is stored with the other prefs, read back, and clamped to its limits', () => {
    const keep = new Map<string, string>();
    const storage = {
      getItem: (k: string) => keep.get(k) ?? null,
      setItem: (k: string, v: string) => { keep.set(k, v); },
      removeItem: (k: string) => { keep.delete(k); },
    } as Storage;
    const store = createPrefsStore(storage);
    store.getState().setExploreListWidth(520);
    expect(JSON.parse(keep.get(PREFS_KEY)!).exploreListWidth).toBe(520);
    expect(createPrefsStore(storage).getState().exploreListWidth).toBe(520);
    store.getState().setExploreListWidth(99999);
    expect(store.getState().exploreListWidth).toBe(EXPLORE_LIST_MAX);
    store.getState().setExploreListWidth(1);
    expect(store.getState().exploreListWidth).toBe(EXPLORE_LIST_MIN);
    keep.set(PREFS_KEY, JSON.stringify({ ...JSON.parse(keep.get(PREFS_KEY)!), exploreListWidth: 10 }));
    expect(createPrefsStore(storage).getState().exploreListWidth).toBe(EXPLORE_LIST_MIN);
  });

  it('the searches side panel resizes on the Explore tab too, and its width is kept (sideWidth)', async () => {
    const world = exploreWorld();
    const r = renderKb();
    const original = r.fake.requestMock.getMockImplementation()!;
    r.fake.requestMock.mockImplementation(async (req) => (
      (req.path.startsWith('/kb/explore/') || req.path === '/kb/settings/weekly-check') ? serveExplore(world, req) : original(req)
    ));
    fireEvent.click(within(await screen.findByRole('navigation', { name: 'Sections' })).getByRole('button', { name: /^Explore/ }));
    await waitFor(() => expect(document.querySelector('[data-pane="explore"]')).toBeTruthy());
    const side = screen.getByRole('separator', { name: 'Resize side panel' });
    expect(side).toHaveAttribute('aria-valuenow', '248');
    fireEvent.keyDown(side, { key: 'ArrowRight' });
    expect(storedPrefs().sideWidth).toBe(264);
    expect(screen.getByRole('separator', { name: 'Resize side panel' })).toHaveAttribute('aria-valuenow', '264');
  });
});

// ---- FX-5: the live line of steps while a search runs ----------------------------------------------------

describe('FX-5 — the live line of steps while a search runs', () => {
  it('shows the four steps, the English terms and the fit counter, marking the done and active ones', async () => {
    page({ search: { state: 'running', stage: 'decision', terms: ['mixture of experts', 'load balancing'], found: 31, after_rules: 40, decided: 12 } });
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Understanding your request');
    expect(status).toHaveTextContent('Searching OpenAlex');
    expect(status).toHaveTextContent('Checking fit');
    expect(status).toHaveTextContent('Comparing with your wiki');
    expect(screen.getByText('(mixture of experts · load balancing)')).toBeInTheDocument();
    expect(screen.getByText('12/40')).toBeInTheDocument();
    expect(screen.getByText('Searching OpenAlex').closest('li')).toHaveClass('is-done');
    expect(screen.getByText('Checking fit').closest('li')).toHaveClass('is-on');
    expect(screen.getByText('Checking fit').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Comparing with your wiki').closest('li')).not.toHaveClass('is-done');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('the wiki comparison is the active step from novelty on, with its own counter', async () => {
    page({ search: { state: 'running', stage: 'novelty', novelty_checked: 5, fit: 12 } });
    expect((await screen.findByText('Comparing with your wiki')).closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('5/12')).toBeInTheDocument();
    expect(screen.getByText('Checking fit').closest('li')).toHaveClass('is-done');
    expect(screen.getByText('Checking fit').closest('li')).not.toHaveAttribute('aria-current');
  });

  it('the plan stage is the first step, and no counters are invented before they exist', async () => {
    page({ search: { state: 'running', stage: 'plan' }, world: { findings: [] } });
    expect((await screen.findByText('Understanding your request')).closest('li')).toHaveAttribute('aria-current', 'step');
    expect(document.querySelectorAll('.kb-ex-live__note')).toHaveLength(0);
  });

  it('liveSteps maps each stage to its step (ready still shows the comparison active)', () => {
    const at = (stage: string) => liveSteps(searchFixture('s', 'S', { stage }) as KbSearch).findIndex((s) => s.on);
    expect(at('plan')).toBe(0);
    expect(at('collect')).toBe(1);
    expect(at('rules')).toBe(1);
    expect(at('decision')).toBe(2);
    expect(at('novelty')).toBe(3);
    expect(at('ready')).toBe(3);
  });
});

// ---- FX-1: the terms of a finished search ----------------------------------------------------------------

describe('FX-1 — the terms a finished search went out with', () => {
  it('a finished search shows them under its title', async () => {
    page({ search: { state: 'done', terms: ['mixture of experts', 'load balancing'] } });
    await row(/RailS/);
    expect(screen.getByText('Searched for: mixture of experts · load balancing')).toBeInTheDocument();
  });

  it('a running search does not repeat them under the title — the live step already carries them', async () => {
    page({ search: { state: 'running', stage: 'collect', terms: ['mixture of experts'] } });
    await screen.findByRole('status');
    expect(screen.queryByText('Searched for: mixture of experts')).not.toBeInTheDocument();
  });
});

// ---- FX-5: an empty answer says the words and offers to edit them ----------------------------------------

describe('FX-5 — an empty answer says the words, and offers to edit them and search again', () => {
  async function emptySearch(h: ReturnType<typeof section>) {
    await openSearch(h);
    await screen.findByText('Nothing found');
    return h;
  }

  it('nothing found: the words are shown, and the section opens the new search with the edited words', async () => {
    const h = section(exploreWorld({
      searches: [searchFixture('run-1', 'Model architectures', {
        area_id: 'arch', state: 'done', found: 0, fit: 0, new: 0, no_text: 0, unseen: 0,
        terms: ['mixture of experts'], query: 'MoE',
      })],
      findings: [],
    }));
    await emptySearch(h);
    // the words the search went out with are shown, so the empty answer has its reason
    expect(screen.getAllByText('Searched for: mixture of experts').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Edit words and search again' }));
    const field = screen.getByRole('textbox', { name: 'Search words' });
    expect(field).toHaveValue('mixture of experts');
    fireEvent.change(field, { target: { value: 'MoE routing, expert balancing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search again' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/runs')[0]!.body).toEqual({
      area_id: 'arch', query: 'MoE routing, expert balancing',
      plan: [{ area_id: 'arch', label: 'MoE routing, expert balancing', terms: ['MoE routing', 'expert balancing'] }],
    }));
    await waitFor(() => expect(h.store.getState().page).toEqual({ kind: 'search', id: 'run-2' }));
    expect(await screen.findByRole('heading', { name: 'MoE routing, expert balancing' })).toBeInTheDocument();
  });

  it('nothing new for you: the same offer, prefilled with the request when there were no terms', async () => {
    const h = section(exploreWorld({
      searches: [searchFixture('run-1', 'Sparse routing', { area_id: 'arch', state: 'done', found: 30, fit: 8, new: 0, query: 'sparse routing' })],
      findings: [],
    }));
    await openSearch(h);
    await screen.findByText('Nothing new for you');
    expect(screen.getByText('Searched for: sparse routing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit words and search again' }));
    expect(screen.getByRole('textbox', { name: 'Search words' })).toHaveValue('sparse routing');
  });

  it('splitTerms cuts the field on commas, and importNote names what actually landed', () => {
    expect(splitTerms('MoE routing, expert balancing; load bounds')).toEqual(['MoE routing', 'expert balancing', 'load bounds']);
    expect(splitTerms('  , ,one term, ')).toEqual(['one term']);
    expect(importNote('abstract_only')).toBe(' (abstract only)');
    expect(importNote('link_only')).toBe(' (link only)');
    expect(importNote('pdf')).toBe('');
    expect(importNote('full_text')).toBe('');
    expect(importNote(null)).toBe('');
    expect(importNote(undefined)).toBe('');
  });
});

// ---- FX-2: Add to materials says what it is doing ---------------------------------------------------------

describe('FX-2 — Add to materials says what it is doing', () => {
  it('the button and the row say Importing… while the request runs, and then the note says what landed', async () => {
    const h = page();
    fireEvent.click(await row(/RailS/));
    const add = gate(h.request, '/kb/explore/findings/f1/materials');
    fireEvent.click(within(reader()).getByRole('button', { name: 'Add to materials' }));
    const busy = await screen.findByRole('button', { name: 'Importing…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(listitem(/RailS/)).toHaveTextContent('Importing…');
    add.release({ ok: true, status: 200, data: { finding_id: 'f1', material_id: 'm-1', content: 'pdf' } });
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ text: 'Added to Materials › From Explore · not in the wiki yet', tone: 'done' }));
    expect(screen.getByText('In Materials › From Explore · not in the wiki')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Importing…' })).not.toBeInTheDocument();
  });

  it('an abstract-only import says so in the toast and the plaque', async () => {
    const h = page();
    fireEvent.click(await row(/RailS/));
    fireEvent.click(within(reader()).getByRole('button', { name: 'Add to materials' }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ text: 'Added to Materials › From Explore (abstract only) · not in the wiki yet', tone: 'done' }));
    expect(screen.getByText('In Materials › From Explore (abstract only) · not in the wiki')).toBeInTheDocument();
  });

  it('a link-only import says so too', async () => {
    const h = page();
    fireEvent.click(await row(/RailS/));
    answer(h.request, '/kb/explore/findings/f1/materials', { finding_id: 'f1', material_id: 'm-1', content: 'link_only' });
    fireEvent.click(within(reader()).getByRole('button', { name: 'Add to materials' }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ text: 'Added to Materials › From Explore (link only) · not in the wiki yet', tone: 'done' }));
    expect(screen.getByText('In Materials › From Explore (link only) · not in the wiki')).toBeInTheDocument();
  });

  it('an import that continues in the background stays Importing… until the page reads it landed', async () => {
    const h = page();
    fireEvent.click(await row(/RailS/));
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (req) => {
      if (req.method === 'POST' && req.path === '/kb/explore/findings/f1/materials') {
        return { ok: true, status: 200, data: { finding_id: 'f1', material_id: 'm-1', content: 'pdf', importing: true } };
      }
      // The paper being read is asked on its own once it imports: answer from the world's live state.
      if (req.method === 'GET' && req.path === '/kb/explore/findings/f1') {
        return { ok: true, status: 200, data: structuredClone(h.world.findings[0]!) };
      }
      return original(req);
    });
    fireEvent.click(within(reader()).getByRole('button', { name: 'Add to materials' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Importing…' })).toBeDisabled());
    expect(screen.queryByText(/In Materials › From Explore/)).not.toBeInTheDocument();
    // the background import lands: the page's own beat reads the finding again and the paper takes it
    h.world.findings[0]!.state = 'materials';
    h.world.findings[0]!.material_id = 'm-1';
    h.world.findings[0]!.imported_content = 'pdf';
    await waitFor(() => expect(screen.getByText('In Materials › From Explore · not in the wiki')).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByRole('button', { name: 'Importing…' })).not.toBeInTheDocument();
  });
});

// ---- FX-1: an honest stop when there is no chat agent to turn the request into terms ----------------------

describe('FX-1 — agent_required: a stop without silent substitutions', () => {
  it('says what is missing, opens Settings on the models section, and continues from the checkpoint', async () => {
    const h = page({ search: { state: 'paused', stop_reason: 'agent_required', checkpoint_id: 'cp-1', checkpoint_revision: 4 }, world: { findings: [] } });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Set up a chat agent in Settings to turn your request into English search terms.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Open Settings' }));
    expect(h.props.onOpenSettings).toHaveBeenCalledWith('models');
    fireEvent.click(within(alert).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/runs/run-1/continue')[0]!.body).toEqual({ checkpoint_id: 'cp-1', revision: 4 }));
  });
});

// ---- FX-5: the finished note of the search you are looking at does not ring the bell ---------------------

describe('FX-5 — the finished note is dismissed while you look at that search', () => {
  const note = (id: string, jobId: string): KbNotification => ({
    id, kind: 'explore_finished', title: 'Search finished', body: '4 new · 2 repeat what you have',
    payload: { job_id: jobId }, requires_action: false, created_at: '2026-11-13T10:00:00Z', dismissed_at: null,
    seq: 9, actions: [{ id: 'open_explore', label: 'Open in Explore', primary: true, needs_text: false }],
    subject: null, resolved_at: null, resolution: null,
  });

  it('dismisses the note of the open search when it arrives, and keeps every other note', async () => {
    const h = section();
    await openSearch(h);
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (req) => (/^\/kb\/notifications\/[^/]+\/dismiss$/.test(req.path)
      ? { ok: true, status: 200, data: {} }
      : original(req)));
    act(() => { h.services.notifications.setState({ items: [note('n-open', 'run-1'), note('n-other', 'run-9')] }); });
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/notifications/n-open/dismiss')).toHaveLength(1));
    expect(sent(h.request, 'POST', '/kb/notifications/n-other/dismiss')).toHaveLength(0);
    await waitFor(() => expect(h.services.notifications.getState().items.map((n) => n.id)).toEqual(['n-other']));
  });

  it('a note that arrived elsewhere is dismissed when you open that search', async () => {
    const h = section();
    await screen.findByRole('button', { name: /Machine learning/ });
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (req) => (/^\/kb\/notifications\/[^/]+\/dismiss$/.test(req.path)
      ? { ok: true, status: 200, data: {} }
      : original(req)));
    // it arrives while the map is the page: nothing to dismiss yet
    act(() => { h.services.notifications.setState({ items: [note('n-open', 'run-1')] }); });
    expect(sent(h.request, 'POST', /\/dismiss$/)).toHaveLength(0);
    await act(async () => { await h.store.getState().refresh(); h.store.getState().showSearch('run-1'); });
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/notifications/n-open/dismiss')).toHaveLength(1));
    await waitFor(() => expect(h.services.notifications.getState().items).toEqual([]));
  });
});
