import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KbServicesProvider } from '../state/context';
import { baseWorld } from '../test/fakeBridge';
import { ExploreSection } from './ExploreSection';
import { ExploreSide } from './ExploreSide';
import { exploreState } from './exploreState';
import { TOPICS_CHANGED } from './topicEvents';
import { weekdayShort } from './types';
import { exploreHarness, exploreWorld, findingFixture, searchFixture, sent, type ExploreWorld } from './test/fixtures';

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
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as { skaz?: unknown }).skaz; });

function setup(world: ExploreWorld = exploreWorld(), opts: { side?: boolean; hidden?: boolean } = {}) {
  const h = exploreHarness(world);
  const tree = (hidden?: boolean) => (
    <KbServicesProvider services={h.services}>
      {opts.side && <ExploreSide />}
      <ExploreSection hidden={hidden} />
    </KbServicesProvider>
  );
  const view = render(tree(opts.hidden));
  // The section made the store of this library; asking again for the same client returns that one.
  const store = exploreState(h.services.client, async () => ({ items: [], parallel_limit: 3 }));
  return { ...h, store, view, rerender: (hidden?: boolean) => view.rerender(tree(hidden)) };
}

const tile = (name: string) => screen.findByRole('button', { name: new RegExp(`^${name}`) });
const bar = () => screen.getByRole('search');
const find = () => within(bar()).getByRole('button', { name: /^Find/ });
const runs = (request: ReturnType<typeof setup>['request']) => sent(request, 'POST', '/kb/explore/runs');

describe('EX3 explore page — the find bar is the one place a search starts (UX-14)', () => {
  it('has the scope, the words field and one Find button — and no frame to highlight', async () => {
    setup();
    await tile('Machine learning');
    expect(within(bar()).getByText('All your topics')).toBeInTheDocument();
    expect(within(bar()).getByRole('textbox', { name: 'What exactly? (optional)' })).toHaveAttribute('placeholder', expect.stringContaining('What exactly?'));
    expect(find()).toHaveTextContent("Find what's new");
    expect(screen.getAllByRole('button', { name: /^Find/ })).toHaveLength(1);
  });

  it('Find with some words starts a search over all your topics and opens its page', async () => {
    const h = setup(exploreWorld(), { side: true });
    await tile('Machine learning');
    fireEvent.change(within(bar()).getByRole('textbox'), { target: { value: '  evaluating RAG  ' } });
    fireEvent.click(find());
    await waitFor(() => expect(runs(h.request)).toHaveLength(1));
    expect(runs(h.request)[0]!.body).toEqual({ area_id: null, query: 'evaluating RAG', all_topics: false });
    // the page is now that search, drawn full page; the words field is empty again
    expect(await screen.findByRole('heading', { name: 'evaluating RAG' })).toBeInTheDocument();
    expect(h.store.getState().page).toMatchObject({ kind: 'search' });
    expect(within(bar()).getByRole('textbox')).toHaveValue('');
    // and the side list shows it, running
    expect(await screen.findByRole('button', { name: /evaluating RAG/ })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Topic' })).not.toBeInTheDocument();
  });

  it('Find with no words and no topic searches all your topics', async () => {
    const h = setup();
    await tile('Machine learning');
    fireEvent.click(find());
    await waitFor(() => expect(runs(h.request)).toHaveLength(1));
    expect(runs(h.request)[0]!.body).toEqual({ area_id: null, query: '', all_topics: true });
  });

  it('a click on a tile makes it the scope, and Find searches that topic', async () => {
    const h = setup();
    fireEvent.click(await tile('LLM systems'));
    await waitFor(() => expect(within(bar()).getByText('LLM systems')).toBeInTheDocument());
    fireEvent.click(find());
    await waitFor(() => expect(runs(h.request)[0]!.body).toEqual({ area_id: 'llm', query: '', all_topics: false }));
  });

  it('the × on the scope goes back to all your topics', async () => {
    const h = setup();
    fireEvent.click(await tile('LLM systems'));
    await waitFor(() => expect(within(bar()).getByText('LLM systems')).toBeInTheDocument());
    fireEvent.click(within(bar()).getByRole('button', { name: 'Search all your topics' }));
    expect(within(bar()).getByText('All your topics')).toBeInTheDocument();
    expect(h.store.getState()).toMatchObject({ level: null, selected: null });
    await tile('Machine learning');
  });

  it('⌘-picking tiles turns Find into «Find in N topics»: one search each, side by side, and a note', async () => {
    const h = setup();
    fireEvent.click(await tile('Machine learning'), { metaKey: true });
    fireEvent.click(await tile('AI agents'), { metaKey: true });
    await waitFor(() => expect(find()).toHaveTextContent('Find in 2 topics'));
    expect(within(bar()).getByText('2 topics')).toBeInTheDocument();
    fireEvent.click(find());
    await waitFor(() => expect(runs(h.request)).toHaveLength(2));
    expect(runs(h.request).map((r) => (r.body as { area_id: string }).area_id)).toEqual(['ml', 'agents']);
    expect(h.services.ui.getState().toast).toMatchObject({ text: '2 searches started — they run side by side; switch between them on the left.' });
    await waitFor(() => expect(h.store.getState().page).toMatchObject({ kind: 'search' }));
    expect(h.store.getState().multi).toEqual([]);
  });

  it('on a search page, the scope is that search\'s topic and Find starts another search in it', async () => {
    const world = exploreWorld({ searches: [searchFixture('run-1', 'Model architectures', { area_id: 'arch' })] });
    const h = setup(world);
    await tile('Machine learning');
    act(() => { void h.store.getState().refresh().then(() => h.store.getState().showSearch('run-1')); });
    await screen.findByRole('heading', { name: 'Model architectures' });
    // the topic's name is not known from the map yet: the section reads its level for it
    await waitFor(() => expect(within(bar()).getByTitle('Model architectures')).toBeInTheDocument());
    expect(within(bar()).queryByRole('button', { name: 'Search all your topics' })).not.toBeInTheDocument();
    fireEvent.change(within(bar()).getByRole('textbox'), { target: { value: 'sparse routing' } });
    fireEvent.click(find());
    await waitFor(() => expect(runs(h.request)[0]!.body).toEqual({ area_id: 'arch', query: 'sparse routing', all_topics: false }));
  });

  it.each([
    ['consent_required', 'Science search needs your permission in Settings → Search.', true],
    ['not_ready', 'Explore is not ready. Check Settings and try again.', true],
    ['provider_unavailable', 'The search provider is unavailable. Try again in a moment.', false],
  ])('a search that cannot start says why (%s) in plain words, without provider detail', async (code, message, settings) => {
    const world = exploreWorld();
    world.failing['POST /kb/explore/runs'] = { status: 503, detail: 'secret provider text', code };
    const h = setup(world);
    await tile('Machine learning');
    fireEvent.click(find());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(screen.queryByText(/secret provider text/)).not.toBeInTheDocument();
    const open = within(alert).queryByRole('button', { name: 'Open Settings' });
    expect(open !== null).toBe(settings);
    if (open) {
      fireEvent.click(open);
      expect(h.services.ui.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'search' });
    }
    expect(h.store.getState().page).toEqual({ kind: 'map' });
  });
});

describe('F6 folder state from the library', () => {
  it('names the actual folder of an already imported material instead of guessing From Explore', async () => {
    const h = setup(exploreWorld({
      searches: [searchFixture('run-1', 'Saved papers')],
      findings: [findingFixture('f1', 'Saved paper', { run_id: 'run-1', state: 'seen', material_id: 'material-added' })],
    }));
    const material = baseWorld().materials[0]!;
    act(() => h.services.library.setState({ contentLoad: 'ready',
      folders: [{ id: 'fld-sec', name: 'Agent Security', system: false, material_count: 1, created_at: material.created_at }],
      materials: [{ ...material, id: 'material-added', folder_id: 'fld-sec' }],
    }));
    await tile('Machine learning');
    act(() => h.store.getState().showSearch('run-1'));
    fireEvent.click(await screen.findByRole('button', { name: /Saved paper/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to materials' }));
    expect(await screen.findByText('In Materials › Agent Security (abstract only) · not in the wiki')).toBeInTheDocument();
  });
});

describe('EX3 explore page — the weekly line and the candidates the weekly check left', () => {
  it('shows which day the weekly check runs, and nothing when it is off', async () => {
    const world = exploreWorld();
    const day = weekdayShort(world.weekly.next_due_at)!;
    setup(world);
    expect(await screen.findByText(`Weekly · ${day}`)).toBeInTheDocument();
    cleanup();
    setup(exploreWorld({ weekly: { ...world.weekly, enabled: false } }));
    await tile('Machine learning');
    expect(screen.queryByText(/^Weekly/)).not.toBeInTheDocument();
  });

  it('offers Check novelty for the waiting candidates, and starts one search over them only on the click', async () => {
    const world = exploreWorld();
    world.weekly = { ...world.weekly, latest_check_id: 'check-1', candidates_waiting: 2 };
    world.weeklyCheck = { ...world.weeklyCheck, id: 'check-1', candidate_ids: ['c-1', 'c-2'] };
    const h = setup(world);
    const button = await screen.findByRole('button', { name: 'Check novelty' });
    expect(screen.getByText(/2 waiting/)).toBeInTheDocument();
    expect(runs(h.request)).toHaveLength(0);
    fireEvent.click(button);
    await waitFor(() => expect(runs(h.request)).toHaveLength(1));
    expect(runs(h.request)[0]!.body).toEqual({ candidate_ids: ['c-1', 'c-2'], channels: [] });
    await waitFor(() => expect(h.store.getState().page).toMatchObject({ kind: 'search' }));
    expect(screen.queryByRole('button', { name: 'Check novelty' })).not.toBeInTheDocument();
  });

  it('starts nothing when the check has no candidates any more, and drops the line', async () => {
    const world = exploreWorld();
    world.weekly = { ...world.weekly, latest_check_id: 'check-1', candidates_waiting: 2 };
    const h = setup(world);
    fireEvent.click(await screen.findByRole('button', { name: 'Check novelty' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Check novelty' })).not.toBeInTheDocument());
    expect(runs(h.request)).toHaveLength(0);
  });
});

describe('EX3 explore page — topic actions: Rename, Merge into, Pin (UX-8)', () => {
  /** Opens the topic (a click goes one level deeper, so the tile is only there the first time), then its menu. */
  const openMenu = async (name: string, item: RegExp | string, opened = false) => {
    if (!opened) fireEvent.click(await tile(name));
    const panel = await screen.findByRole('complementary', { name: 'Topic' });
    await within(panel).findByRole('heading', { name });
    fireEvent.click(within(panel).getByRole('button', { name: 'Topic actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: item }));
  };

  it('has no «New topic» or «New subtopic» anywhere: new topics come from a material\'s menu', async () => {
    setup();
    await tile('Machine learning');
    expect(screen.queryByRole('button', { name: /new (sub)?topic/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/new (sub)?topic/i)).not.toBeInTheDocument();
  });

  it('Pin makes it a weekly search, says so, and Unpin takes it back', async () => {
    const world = exploreWorld();
    const h = setup(world);
    await openMenu('Machine learning', /^Pin/);
    await waitFor(() => expect(sent(h.request, 'PATCH', '/kb/explore/areas/ml')[0]!.body).toEqual({ pinned: true }));
    await waitFor(() => expect(h.services.ui.getState().toast).toMatchObject({ text: 'Pinned: SKAZ searches this topic weekly.' }));
    // the map is read again and shows the topic as pinned
    expect(await screen.findByText(/Pinned, searched weekly/)).toBeInTheDocument();
    await openMenu('Machine learning', /^Unpin/, true);
    await waitFor(() => expect(sent(h.request, 'PATCH', '/kb/explore/areas/ml')[1]!.body).toEqual({ pinned: false }));
    await waitFor(() => expect(h.services.ui.getState().toast).toMatchObject({ text: 'Unpinned.' }));
  });

  it('Rename asks for a name, saves it, and the map shows it', async () => {
    const h = setup();
    await openMenu('Machine learning', 'Rename…');
    const dialog = await screen.findByRole('dialog', { name: 'Rename topic' });
    const field = within(dialog).getByRole('textbox', { name: 'Topic name' });
    expect(field).toHaveValue('Machine learning');
    fireEvent.change(field, { target: { value: 'ML & statistics' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(sent(h.request, 'PATCH', '/kb/explore/areas/ml')[0]!.body).toEqual({ name: 'ML & statistics' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const panel = await screen.findByRole('complementary', { name: 'Topic' });
    expect(await within(panel).findByRole('heading', { name: 'ML & statistics' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Machine learning' })).not.toBeInTheDocument();
  });

  it('keeps the rename dialog open with a plain message when it fails', async () => {
    const world = exploreWorld();
    world.failing['PATCH /kb/explore/areas/ml'] = { status: 503, detail: 'secret provider text', code: 'not_ready' };
    setup(world);
    await openMenu('Machine learning', 'Rename…');
    const dialog = await screen.findByRole('dialog', { name: 'Rename topic' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Topic name' }), { target: { value: 'Other' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Explore is not ready. Check Settings and try again.');
    expect(screen.queryByText(/secret provider text/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Topic name' })).toHaveValue('Other');
  });

  it('Merge into lists the other topics (not itself, not its subtopics), moves its materials, and opens the destination', async () => {
    const h = setup();
    await openMenu('LLM systems', 'Merge into…');
    const dialog = await screen.findByRole('dialog', { name: 'Merge topic' });
    const select = within(dialog).getByRole('combobox', { name: 'Destination topic' });
    await within(dialog).findByRole('option', { name: 'Machine learning' });
    expect(within(dialog).queryByRole('option', { name: 'LLM systems' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('option', { name: /Model architectures/ })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'ml' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/areas/llm/merge')[0]!.body).toEqual({ into_id: 'ml' }));
    await waitFor(() => expect(h.store.getState()).toMatchObject({ selected: 'ml' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('button', { name: /^LLM systems/ })).not.toBeInTheDocument());
  });

  it('reads the map again when topics change elsewhere (a material was moved to a new topic)', async () => {
    const h = setup();
    await tile('Machine learning');
    const reads = () => sent(h.request, 'GET', '/kb/explore/map').length;
    const before = reads();
    h.world.areas.push({ ...h.world.areas[0]!, id: 'fresh', name: 'Fresh topic', concepts: 50 });
    act(() => { window.dispatchEvent(new Event(TOPICS_CHANGED)); });
    expect(await tile('Fresh topic')).toBeInTheDocument();
    expect(reads()).toBeGreaterThan(before);
  });
});

describe('EX3 explore page — Discuss opens the chat itself', () => {
  async function openPaper() {
    const world = exploreWorld({
      searches: [searchFixture('run-1', 'Model architectures', { area_id: 'arch' })],
      findings: [findingFixture('f1', 'RailS: Load Balancing', { run_id: 'run-1' })],
    });
    const h = setup(world);
    await tile('Machine learning');
    localStorage.setItem('skaz.explore.filters', JSON.stringify({ free: false }));
    act(() => { void h.store.getState().refresh().then(() => h.store.getState().showSearch('run-1')); });
    fireEvent.click(await screen.findByRole('button', { name: /RailS/ }));
    return h;
  }

  it('switches to Chats, shows the chat and not All materials, collapses an expanded document, and opens the chat', async () => {
    const h = await openPaper();
    const open = vi.fn();
    const loadList = vi.fn(async () => undefined);
    h.services.chats.setState({ open, loadList } as never);
    h.services.ui.setState({ docExpanded: true, center: 'materials' } as never);
    fireEvent.click(within(screen.getByRole('region', { name: 'Paper' })).getByRole('button', { name: 'Discuss' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('chat-discuss'));
    expect(h.services.prefs.getState()).toMatchObject({ section: 'chats', sideOpen: true });
    expect(h.services.ui.getState().docExpanded).toBe(false);
    expect(h.services.ui.getState().center).toBe('chat');
    expect(loadList).toHaveBeenCalled();
    expect(sent(h.request, 'POST', '/kb/explore/findings/f1/discuss')).toHaveLength(1);
  });
});

describe('EX3 explore page — the paper view steps aside for everything drawn over it', () => {
  const view = () => ({ show: vi.fn(async () => true), bounds: vi.fn(async () => true), hide: vi.fn(async () => true), navigate: vi.fn(async () => true), onState: vi.fn(() => () => undefined) });

  async function openPaperWithView(side = false) {
    const paper = view();
    (window as unknown as { skaz: unknown }).skaz = { paperReader: paper };
    localStorage.setItem('skaz.explore.filters', JSON.stringify({ free: false }));
    const world = exploreWorld({
      searches: [searchFixture('run-1', 'Model architectures', { area_id: 'arch' })],
      findings: [findingFixture('f1', 'RailS: Load Balancing', { run_id: 'run-1' })],
    });
    const h = setup(world, { side });
    await tile('Machine learning');
    act(() => { void h.store.getState().refresh().then(() => h.store.getState().showSearch('run-1')); });
    fireEvent.click(await screen.findByRole('button', { name: /RailS/ }));
    await waitFor(() => expect(paper.show).toHaveBeenCalled());
    return { ...h, paper };
  }

  it('shows the paper while nothing covers it', async () => {
    const { paper } = await openPaperWithView();
    expect(paper.show).toHaveBeenCalledWith('https://arxiv.org/html/f1', expect.objectContaining({ width: expect.any(Number) }));
  });

  it.each([
    ['Settings', (ui: ReturnType<typeof exploreHarness>['services']['ui']) => ui.getState().openSettings('search'), (ui: ReturnType<typeof exploreHarness>['services']['ui']) => ui.getState().closeSettings()],
    ['the ⌘K palette', (ui: ReturnType<typeof exploreHarness>['services']['ui']) => ui.getState().setSearchOpen(true), (ui: ReturnType<typeof exploreHarness>['services']['ui']) => ui.getState().setSearchOpen(false)],
    ['the Add material window', (ui: ReturnType<typeof exploreHarness>['services']['ui']) => ui.getState().setAddMaterialOpen(true), (ui: ReturnType<typeof exploreHarness>['services']['ui']) => ui.getState().setAddMaterialOpen(false)],
    ['a toast (its Undo must stay reachable)', (ui: ReturnType<typeof exploreHarness>['services']['ui']) => ui.getState().showToast({ text: 'Hidden.' }), (ui: ReturnType<typeof exploreHarness>['services']['ui']) => ui.getState().closeToast()],
  ])('hides it while %s is up, and shows it again when it is gone', async (_name, up, down) => {
    const { paper, services } = await openPaperWithView();
    paper.hide.mockClear();
    paper.show.mockClear();
    act(() => up(services.ui));
    await waitFor(() => expect(paper.hide).toHaveBeenCalled());
    expect(paper.show).not.toHaveBeenCalled();
    act(() => down(services.ui));
    await waitFor(() => expect(paper.show).toHaveBeenCalledTimes(1));
  });

  it('hides it while a dialog of the side list is open', async () => {
    const { paper } = await openPaperWithView(true);
    const item = (await screen.findByRole('button', { name: /Model architectures/ })).closest('li') as HTMLElement;
    paper.hide.mockClear();
    paper.show.mockClear();
    fireEvent.click(within(item).getByRole('button', { name: 'Search actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    await screen.findByRole('dialog', { name: 'Rename search' });
    await waitFor(() => expect(paper.hide).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(paper.show).toHaveBeenCalledTimes(1));
  });

  it('hides it while a filter menu is open, and when Explore itself is hidden', async () => {
    const { paper, rerender } = await openPaperWithView();
    paper.hide.mockClear();
    paper.show.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Year' }));
    await screen.findByRole('menu', { name: 'Year' });
    await waitFor(() => expect(paper.hide).toHaveBeenCalled());
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Year' }), { key: 'Escape' });
    await waitFor(() => expect(paper.show).toHaveBeenCalledTimes(1));
    paper.hide.mockClear();
    rerender(true);
    await waitFor(() => expect(paper.hide).toHaveBeenCalled());
  });
});

describe('EX3 explore page — hidden by the shell (a document opened full width)', () => {
  it('is hidden in the DOM, reads nothing and polls nothing while it is hidden, and reads when shown', async () => {
    const world = exploreWorld({ searches: [searchFixture('run-1', 'Running one', { state: 'running' })] });
    const h = setup(world, { hidden: true });
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-pane="explore"]')).toHaveAttribute('hidden');
    expect(h.request).not.toHaveBeenCalled();
    h.rerender(false);
    await tile('Machine learning');
    expect(sent(h.request, 'GET', '/kb/explore/searches').length).toBeGreaterThanOrEqual(1);
  });
});
