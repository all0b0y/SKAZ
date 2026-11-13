import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KbAreaMap } from '../../api/kb/types.gen';
import { MapPage, type MapPageProps } from './MapPage';
import { exploreClients, exploreWorld, searchFixture, sent, wikiArea, type ExploreWorld } from './test/fixtures';

// jsdom has no layout: give every element a box, so the treemap has room to place its tiles.
const BOX = { w: 800, h: 500 };
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => BOX.w });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => BOX.h });
});
afterAll(() => {
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});
afterEach(cleanup);

function setup(world: ExploreWorld = exploreWorld(), over: Partial<MapPageProps> = {}) {
  const h = exploreClients(world);
  const props: MapPageProps = {
    clients: h.clients, hidden: false, level: null, selected: null, multi: [], searches: world.searches, reloadKey: 0,
    onLevel: vi.fn(), onToggleMulti: vi.fn(), onClearMulti: vi.fn(), onOpenSearch: vi.fn(), onOpenDocument: vi.fn(),
    onOpenSettings: vi.fn(), onTopicAction: vi.fn(), onMap: vi.fn(), ...over,
  };
  const view = render(<MapPage {...props} />);
  return { ...h, props, rerender: (next: Partial<MapPageProps> = {}) => view.rerender(<MapPage {...props} {...next} />) };
}

const tile = (name: RegExp | string) => screen.findByRole('button', { name: typeof name === 'string' ? new RegExp(`^${name}`) : name });
const area = (el: HTMLElement) => parseFloat(el.style.width) * parseFloat(el.style.height);

describe('EX3 map page — the wiki as tiles, sized by its concepts (UX-13)', () => {
  it('draws one tile per topic with the concepts and materials it gives the wiki', async () => {
    setup();
    expect(await tile('Machine learning')).toHaveTextContent('457 concepts · 19 materials');
    expect(await tile('AI agents')).toHaveTextContent('249 concepts · 24 materials');
    expect(await tile('LLM systems')).toHaveTextContent('174 concepts · 34 materials');
    // the topic's subtopics belong to the next level, not to this one
    expect(screen.queryByRole('button', { name: /^Model architectures/ })).not.toBeInTheDocument();
    expect(screen.getByText('Your wiki by topic')).toBeInTheDocument();
  });

  it('gives a bigger tile to a topic with more concepts, not more materials', async () => {
    const world = exploreWorld({ areas: [wikiArea('few-mats', 'Few materials', 400, 2), wikiArea('many-mats', 'Many materials', 100, 40)] });
    setup(world);
    const few = await tile('Few materials');
    const many = await tile('Many materials');
    expect(area(few)).toBeGreaterThan(area(many));
    expect(area(few) / area(many)).toBeCloseTo(4, 0);
  });

  it('reads the top level first, and reports the map so the page can name its topics', async () => {
    const h = setup();
    await tile('Machine learning');
    expect(sent(h.request, 'GET', '/kb/explore/map')[0]!.query ?? {}).toEqual({});
    expect(h.props.onMap).toHaveBeenCalledTimes(1);
    expect((h.props.onMap as ReturnType<typeof vi.fn>).mock.calls[0]![0].areas).toHaveLength(6);
  });

  it('shows «No topics yet» when the wiki has no topics', async () => {
    setup(exploreWorld({ areas: [] }));
    expect(await screen.findByText('No topics yet')).toBeInTheDocument();
  });

  it('does not read anything while it is hidden, and reads when it is shown', async () => {
    const h = setup(exploreWorld(), { hidden: true });
    await act(async () => { await Promise.resolve(); });
    expect(h.request).not.toHaveBeenCalled();
    h.rerender({ hidden: false });
    await tile('Machine learning');
    expect(sent(h.request, 'GET', '/kb/explore/map')).toHaveLength(1);
  });
});

describe('EX3 map page — clicking goes one level deeper (UX-15), ⌘-click picks several (UX-12)', () => {
  it('a click opens the topic one level deeper and tells the backend it was opened', async () => {
    const h = setup();
    fireEvent.click(await tile('LLM systems'));
    expect(h.props.onLevel).toHaveBeenCalledWith('llm');
    expect(h.props.onToggleMulti).not.toHaveBeenCalled();
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/areas/llm/opened')).toHaveLength(1));
  });

  it('⌘-click (or Ctrl-click) picks the tile instead of opening it', async () => {
    const h = setup();
    fireEvent.click(await tile('Machine learning'), { metaKey: true });
    fireEvent.click(await tile('AI agents'), { ctrlKey: true });
    expect(h.props.onToggleMulti).toHaveBeenNthCalledWith(1, 'ml');
    expect(h.props.onToggleMulti).toHaveBeenNthCalledWith(2, 'agents');
    expect(h.props.onLevel).not.toHaveBeenCalled();
    expect(sent(h.request, 'POST', /\/opened$/)).toHaveLength(0);
  });

  it('marks the selected tile, or every picked tile, as pressed', async () => {
    const one = setup(exploreWorld(), { selected: 'ml' });
    expect(await tile('Machine learning')).toHaveAttribute('aria-pressed', 'true');
    expect(await tile('AI agents')).toHaveAttribute('aria-pressed', 'false');
    cleanup();
    setup(exploreWorld(), { selected: 'ml', multi: ['agents', 'biz'] });
    expect(await tile('AI agents')).toHaveAttribute('aria-pressed', 'true');
    expect(await tile('Business communication')).toHaveAttribute('aria-pressed', 'true');
    expect(await tile('Machine learning')).toHaveAttribute('aria-pressed', 'false');
    expect(one.props.onLevel).not.toHaveBeenCalled();
  });

  it('shows a topic\'s subtopics at its level, and «‹ All topics» goes back to the top', async () => {
    const h = setup(exploreWorld(), { level: 'llm', selected: 'llm' });
    expect(await tile('Model architectures')).toHaveTextContent('34 concepts · 4 materials');
    expect(await tile('Inference optimization')).toBeInTheDocument();
    expect(screen.getByText('LLM systems', { selector: 'strong' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All topics' }));
    expect(h.props.onLevel).toHaveBeenCalledWith(null, null);
    expect(sent(h.request, 'GET', '/kb/explore/map').at(-1)!.query).toEqual({ parent_id: 'llm' });
  });

  it('a topic with subtopics shows no material tiles, and does not ask for its materials', async () => {
    const h = setup(exploreWorld(), { level: 'llm', selected: 'llm' });
    await tile('Model architectures');
    expect(sent(h.request, 'GET', /\/materials$/)).toHaveLength(0);
  });
});

describe('EX3 map page — the last level is the topic\'s own materials (UX-15)', () => {
  it('opens a topic without subtopics into tiles of its materials, sized by the concepts each gave the wiki', async () => {
    const h = setup(exploreWorld(), { level: 'arch', selected: 'arch' });
    const gpt = await tile('Transformer и GPT');
    expect(gpt).toHaveTextContent('16 concepts');
    expect(area(gpt)).toBeGreaterThan(area(await tile('Dense models')));
    expect(screen.getByText('its materials · size = concepts each gave your wiki')).toBeInTheDocument();
    expect(sent(h.request, 'GET', '/kb/explore/areas/arch/materials')[0]!.query).toEqual({ limit: 100 });
  });

  it('a material tile opens that material (Materials, highlighted), and «‹ LLM systems» goes up one level', async () => {
    const h = setup(exploreWorld(), { level: 'arch', selected: 'arch' });
    fireEvent.click(await tile('MoE — смесь экспертов'));
    expect(h.props.onOpenDocument).toHaveBeenCalledWith({ type: 'material', id: 'm-moe' });
    fireEvent.click(screen.getByRole('button', { name: 'LLM systems' }));
    expect(h.props.onLevel).toHaveBeenCalledWith('llm', 'llm');
  });

  it('says so when a topic has no materials yet', async () => {
    setup(exploreWorld({ materials: {} }), { level: 'arch', selected: 'arch' });
    expect(await screen.findByText('No materials in this topic yet.')).toBeInTheDocument();
  });
});

describe('EX3 map page — small topics share one «Other · N topics» tile', () => {
  const crowded = () => exploreWorld({
    areas: [wikiArea('big', 'Big topic', 900, 30), wikiArea('mid', 'Middle topic', 300, 10),
      ...[1, 2, 3, 4, 5].map((i) => wikiArea(`s${i}`, `Small ${i}`, 4, 1))],
  });

  it('folds topics under 4 % of the level into one tile, and opens them on a click', async () => {
    setup(crowded());
    const other = await tile('Other · 5 topics');
    expect(other).toHaveTextContent('20 concepts · 5 materials');
    expect(screen.queryByRole('button', { name: /^Small 1/ })).not.toBeInTheDocument();
    fireEvent.click(other);
    expect(await tile('Small 1')).toBeInTheDocument();
    expect(screen.getByText('Other topics')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Big topic/ })).not.toBeInTheDocument();
  });

  it('«Back» from the Other topics returns to the level', async () => {
    setup(crowded());
    fireEvent.click(await tile('Other · 5 topics'));
    await tile('Small 1');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await tile('Big topic')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Small 1/ })).not.toBeInTheDocument();
  });

  it('keeps the Other tile readable: it never shrinks below a twentieth of the level', async () => {
    setup(crowded());
    const other = await tile('Other · 5 topics');
    const big = await tile('Big topic');
    const total = [...document.querySelectorAll<HTMLElement>('.kb-ex-tile')].reduce((sum, t) => sum + area(t), 0);
    expect(area(other) / total).toBeGreaterThan(0.045);
    expect(area(big)).toBeGreaterThan(area(other));
  });

  it('does not hide a single small topic behind Other', async () => {
    setup(exploreWorld({ areas: [wikiArea('big', 'Big topic', 900, 30), wikiArea('only', 'Only small', 4, 1)] }));
    expect(await tile('Only small')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Other/ })).not.toBeInTheDocument();
  });

  it('puts every topic in the tiles when the level has just a few', async () => {
    setup(exploreWorld({ areas: [wikiArea('a', 'Alpha', 100, 5), wikiArea('b', 'Beta', 100, 5)] }));
    await tile('Alpha');
    await tile('Beta');
    expect(screen.queryByRole('button', { name: /^Other/ })).not.toBeInTheDocument();
  });
});

describe('EX3 map page — the topic panel', () => {
  it('names the whole wiki when no topic is selected, and lists every search', async () => {
    const world = exploreWorld({ searches: [searchFixture('run-1', 'Model architectures', { area_id: 'arch' }), searchFixture('run-2', 'Everything', { unseen: 0 })] });
    const h = setup(world);
    const panel = await screen.findByRole('complementary', { name: 'Topic' });
    expect(within(panel).getByRole('heading', { name: 'All your topics' })).toBeInTheDocument();
    expect(panel).toHaveTextContent('1432 wiki pages · 93 materials');
    expect(within(panel).getByRole('button', { name: /Model architectures/ })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: /Everything/ }));
    expect(h.props.onOpenSearch).toHaveBeenCalledWith('run-2');
    expect(within(panel).queryByRole('button', { name: 'Topic actions' })).not.toBeInTheDocument();
  });

  it('shows the selected topic: concepts, materials, main concepts and only its searches', async () => {
    const world = exploreWorld({ searches: [searchFixture('run-1', 'KV cache', { area_id: 'llm', unseen: 5 }), searchFixture('run-2', 'Other topic search', { area_id: 'ml' })] });
    setup(world, { selected: 'llm' });
    const panel = await screen.findByRole('complementary', { name: 'Topic' });
    await within(panel).findByRole('heading', { name: 'LLM systems' });
    expect(panel).toHaveTextContent('174 concepts · 34 materials');
    expect(within(panel).getByText('KV cache', { selector: '.kb-ex-chip' })).toBeInTheDocument();
    expect(within(panel).getByText('Attention', { selector: '.kb-ex-chip' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /KV cache\s*\+5/ })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Other topic search/ })).not.toBeInTheDocument();
  });

  it('offers Rename, Merge into and Pin for the topic, and says it is pinned', async () => {
    const world = exploreWorld();
    world.areas.find((a) => a.id === 'ml')!.pinned = true;
    const h = setup(world, { selected: 'ml' });
    const panel = await screen.findByRole('complementary', { name: 'Topic' });
    await within(panel).findByRole('heading', { name: 'Machine learning' });
    expect(panel).toHaveTextContent('Pinned, searched weekly');
    const open = async () => fireEvent.click(await within(panel).findByRole('button', { name: 'Topic actions' }));
    await open();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    expect(h.props.onTopicAction).toHaveBeenLastCalledWith('rename', expect.objectContaining({ id: 'ml' }));
    await open();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Merge into…' }));
    expect(h.props.onTopicAction).toHaveBeenLastCalledWith('merge', expect.objectContaining({ id: 'ml' }));
    await open();
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Unpin/ }));
    expect(h.props.onTopicAction).toHaveBeenLastCalledWith('pin', expect.objectContaining({ id: 'ml', pinned: true }));
  });

  it('offers Pin for a topic that is not pinned', async () => {
    setup(exploreWorld(), { selected: 'agents' });
    const panel = await screen.findByRole('complementary', { name: 'Topic' });
    await within(panel).findByRole('heading', { name: 'AI agents' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Topic actions' }));
    expect(await screen.findByRole('menuitem', { name: /^Pin/ })).toBeInTheDocument();
  });

  it('with several topics picked, says how many and clears the pick', async () => {
    const h = setup(exploreWorld(), { selected: 'ml', multi: ['ml', 'agents', 'biz'] });
    const panel = await screen.findByRole('complementary', { name: 'Picked topics' });
    expect(within(panel).getByRole('heading', { name: '3 topics picked' })).toBeInTheDocument();
    await waitFor(() => expect(panel).toHaveTextContent('Machine learning, AI agents, Business communication'));
    expect(panel).toHaveTextContent('Find in 3 topics');
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear picks' }));
    expect(h.props.onClearMulti).toHaveBeenCalled();
  });

  it('has no Find button of its own — Find is only in the bar above (UX-14)', async () => {
    setup(exploreWorld(), { selected: 'ml' });
    await tile('Machine learning');
    expect(screen.queryByRole('button', { name: /^Find/ })).not.toBeInTheDocument();
  });
});

describe('EX3 map page — «N materials without a topic» (UX-8)', () => {
  it('shows the line only when there are materials without a topic, and sorts them on the button', async () => {
    const h = setup(exploreWorld({ unsorted: 3 }));
    expect(await screen.findByText('3 materials have no topic yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Organize topics' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/topics/sort')).toHaveLength(1));
    await waitFor(() => expect(sent(h.request, 'GET', '/kb/explore/map').length).toBeGreaterThan(1));
  });

  it('shows nothing when every material has a topic', async () => {
    setup(exploreWorld({ unsorted: 0 }));
    await tile('Machine learning');
    expect(screen.queryByRole('region', { name: 'Topic organization' })).not.toBeInTheDocument();
  });
});

describe('EX3 map page — failures and late answers', () => {
  it('says what went wrong without provider detail, and Try again reads the level again', async () => {
    const world = exploreWorld();
    world.failing['GET /kb/explore/map'] = { status: 503, detail: 'secret provider text', code: 'not_ready' };
    setup(world);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Explore is not ready. Check Settings and try again.');
    expect(screen.queryByText(/secret provider text/)).not.toBeInTheDocument();
    delete world.failing['GET /kb/explore/map'];
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await tile('Machine learning')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores a slow answer for a level the user already left', async () => {
    const h = setup(exploreWorld());
    await tile('Machine learning');
    const real = h.clients.areas.map.bind(h.clients.areas);
    let late!: (map: KbAreaMap) => void;
    vi.spyOn(h.clients.areas, 'map').mockImplementationOnce(() => new Promise<KbAreaMap>((resolve) => { late = resolve; }));
    h.rerender({ level: 'inf', selected: 'inf' });          // the slow read for «Inference optimization»…
    const older = await real({ parent_id: 'inf' });
    h.rerender({ level: 'llm', selected: 'llm' });          // …then the user goes to «LLM systems», which answers at once
    expect(await tile('Model architectures')).toBeInTheDocument();
    await act(async () => { late(older); });                 // the slow answer arrives last
    expect(screen.getByRole('button', { name: /^Model architectures/ })).toBeInTheDocument();
    expect(screen.getByText('LLM systems', { selector: 'strong' })).toBeInTheDocument();
  });
});

describe('EX3 map page — follows the topic labelling until it settles', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reads again every 1.5 s while topics are being organized, then stops', async () => {
    const world = exploreWorld({ labelling: { state: 'running', job_id: 'j', done: 10, total: 93, reason_code: null, engine: 'codex' } });
    const h = setup(world);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const reads = () => sent(h.request, 'GET', '/kb/explore/map').length;
    expect(reads()).toBe(1);
    expect(screen.getByText(/Organizing your topics · 10 of 93 materials/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(reads()).toBe(2);
    world.labelling = { state: 'idle', job_id: null, done: 93, total: 93, reason_code: null, engine: null };
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    const settled = reads();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(reads()).toBe(settled);
  });
});
