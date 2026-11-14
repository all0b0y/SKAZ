import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KbFinding } from '../../api/kb/types.gen';
import { DEFAULT_FILTERS, writeFilters, type FindingFilters } from './filters';
import { SearchPage, STOP_TEXT, lowerFirst, type SearchPageProps } from './SearchPage';
import { exploreClients, exploreWorld, findingFixture, searchFixture, sent, type ExploreWorld } from './test/fixtures';

const PAID_SENTENCE = (reason: string) =>
  `This article is paid. I think it's useful because ${reason}. You can check it yourself; if you get it, add it to your materials.`;

/** The papers of run-1: two new, one seen, one paid, one with no abstract, one hidden before, one unchecked. */
function papers(): KbFinding[] {
  const base = { run_id: 'run-1' };
  return [
    findingFixture('f1', 'RailS: Load Balancing for All-to-All Communication', { ...base, wiki_refs: [{ page_id: 'p-moe', title: 'MoE — смесь экспертов', block_id: null }], new_line: 'Conventional load-balancing methods fail on Rail topologies' }),
    findingFixture('f2', 'HAP: Hybrid Adaptive Parallelism', base, { publication_type: 'conference-paper', venue: 'IEEE Parallel and Distributed Systems', publication: { ...findingFixture('x', 'x').work.publication, year: 2025 } }),
    findingFixture('f3', 'Seen already: expert routing', { ...base, state: 'seen' }),
    findingFixture('f4', 'A paid study of expert routing', { ...base, access: 'paid', read_url: 'https://publisher.example/paper/4', new_line: 'It gives the first formal bound on expert load imbalance' }),
    findingFixture('f5', 'Sparse routing without an abstract', { ...base, has_abstract: false }, { abstract: '' }),
    findingFixture('f6', 'Hidden before: a dismissed paper', { ...base, state: 'dismissed' }),
    findingFixture('f7', 'Unchecked access paper', { ...base, access: 'unchecked' }),
  ];
}

function setup(over: { world?: Partial<ExploreWorld>; search?: Partial<ReturnType<typeof searchFixture>>; props?: Partial<SearchPageProps>; filters?: Partial<FindingFilters> | null } = {}) {
  // Free only is the default; most tests read the paid paper too, so they start with it off.
  if (over.filters !== null) writeFilters({ ...DEFAULT_FILTERS, free: false, ...over.filters });
  const search = searchFixture('run-1', 'Model architectures', { area_id: 'arch', ...over.search });
  const world = exploreWorld({ searches: [search], findings: papers(), ...over.world });
  const h = exploreClients(world);
  const toast = vi.fn();
  const props: SearchPageProps = {
    search, scopeName: 'Model architectures', explore: h.clients.explore, parallelLimit: 3,
    listWidth: 380, onListWidth: vi.fn(), onStarted: vi.fn(),
    covered: false, onCovered: vi.fn(),
    onChanged: vi.fn(), onDiscuss: vi.fn(), onOpenDocument: vi.fn(), onOpenSettings: vi.fn(), toast, ...over.props,
  };
  const view = render(<SearchPage {...props} />);
  return { ...h, world, search, props, toast, view, rerender: (next: Partial<SearchPageProps>) => view.rerender(<SearchPage {...props} {...next} />) };
}

const row = (title: RegExp | string) => screen.findByRole('button', { name: typeof title === 'string' ? new RegExp(title) : title });
const listitem = (title: string) => screen.getByRole('button', { name: new RegExp(title) }).closest('[role="listitem"]') as HTMLElement;
const reader = () => screen.getByRole('region', { name: 'Paper' });

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('EX3 search page — a paper in the list (UX-6)', () => {
  it('asks for the papers of this search with the remembered filters', async () => {
    const h = setup({ filters: { free: true } });
    await row(/RailS/);
    expect(sent(h.request, 'GET', '/kb/explore/findings')[0]!.query).toEqual({ run_id: 'run-1', show: 'active', free_only: true, sort: 'for_you', limit: 100 });
  });

  it('shows title, «year · type · source · Free», and the real abstract', async () => {
    setup();
    const item = (await row(/RailS/)).closest('[role="listitem"]') as HTMLElement;
    expect(within(item).getByText('RailS: Load Balancing for All-to-All Communication')).toBeInTheDocument();
    expect(item).toHaveTextContent('2026 · Journal article · Fixture Journal · Free');
    expect(within(item).getByText('Abstract of RailS: Load Balancing for All-to-All Communication.')).toBeInTheDocument();
    expect(listitem('HAP')).toHaveTextContent('2025 · Conference paper · IEEE Parallel and Distributed Systems · Free');
  });

  it('marks the paper as Paid, and says nothing about access when it was not checked', async () => {
    setup();
    await row(/RailS/);
    expect(within(listitem('A paid study')).getByText('Paid')).toHaveClass('is-paid');
    expect(within(listitem('RailS')).getByText('Free')).toHaveClass('is-free');
    const unchecked = listitem('Unchecked access');
    expect(within(unchecked).queryByText('Free')).not.toBeInTheDocument();
    expect(within(unchecked).queryByText('Paid')).not.toBeInTheDocument();
  });

  it('says so when the source gave no abstract, instead of showing a stub', async () => {
    setup();
    await row(/Sparse routing/);
    expect(within(listitem('Sparse routing')).getByText('No abstract from the source — open it to read.')).toHaveClass('is-none');
  });

  it('marks new papers with a dot and bold, seen ones without, and keeps hidden ones out of the list', async () => {
    setup();
    await row(/RailS/);
    expect(listitem('RailS')).toHaveClass('is-new');
    expect(within(listitem('RailS')).getByLabelText('New')).toBeInTheDocument();
    expect(listitem('Seen already')).not.toHaveClass('is-new');
    expect(screen.queryByRole('button', { name: /Hidden before/ })).not.toBeInTheDocument();
  });

  it('shows how many authors and where, in the head of the paper', async () => {
    setup({ world: { findings: [findingFixture('many', 'Many authors', { run_id: 'run-1' }, { authors: ['A One', 'B Two', 'C Three', 'D Four'], venue: 'Venue X' })] } });
    fireEvent.click(await row(/Many authors/));
    expect(within(reader()).getByText('A One, B Two, C Three et al. · 2026 · Venue X')).toBeInTheDocument();
  });

  it('says it is loading before the first answer', async () => {
    setup();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    await row(/RailS/);
  });
});

describe('EX3 search page — opening a paper marks it seen (UX-2) and fills the reader slot', () => {
  it('gives the list the whole page until a paper is picked; picking one splits it once (FX-4)', async () => {
    setup();
    await row(/RailS/);
    expect(screen.queryByRole('region', { name: 'Paper' })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize papers list' })).not.toBeInTheDocument();
    fireEvent.click(await row(/Seen already/));
    expect(screen.getByRole('region', { name: 'Paper' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize papers list' })).toHaveAttribute('aria-controls', 'kb-ex-list');
  });

  it('opening a New paper sends «seen», takes the dot away and tells the page the counts changed', async () => {
    const h = setup();
    fireEvent.click(await row(/RailS/));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/findings/f1/seen')).toHaveLength(1));
    await waitFor(() => expect(listitem('RailS')).not.toHaveClass('is-new'));
    expect(h.props.onChanged).toHaveBeenCalled();
    expect(listitem('RailS')).toHaveClass('is-open');
    expect(within(reader()).getByRole('heading', { name: 'RailS: Load Balancing for All-to-All Communication' })).toBeInTheDocument();
    expect(within(reader()).queryByText('Pick a paper on the left — it opens here.')).not.toBeInTheDocument();
  });

  it('opening a paper that is already seen sends nothing', async () => {
    const h = setup();
    fireEvent.click(await row(/Seen already/));
    expect(within(reader()).getByRole('heading', { name: 'Seen already: expert routing' })).toBeInTheDocument();
    expect(sent(h.request, 'POST', /\/seen$/)).toHaveLength(0);
  });

  it('shows what is new for you, and the wiki concepts it touches, which open as pages', async () => {
    const h = setup();
    fireEvent.click(await row(/RailS/));
    const head = reader();
    expect(within(head).getByText('Conventional load-balancing methods fail on Rail topologies')).toBeInTheDocument();
    expect(head).toHaveTextContent('New for you: Conventional load-balancing methods fail on Rail topologies');
    fireEvent.click(within(head).getByRole('button', { name: 'MoE — смесь экспертов' }));
    expect(h.props.onOpenDocument).toHaveBeenCalledWith({ type: 'page', id: 'p-moe' });
  });

  it('says a paper mostly repeats the wiki when there is no new line', async () => {
    setup({ world: { findings: [findingFixture('rep', 'Repeats the wiki', { run_id: 'run-1', new_line: null })] } });
    fireEvent.click(await row(/Repeats the wiki/));
    expect(within(reader()).getByText('Mostly repeats what your wiki has.')).toBeInTheDocument();
  });

  it('closes the paper, and the list has the whole page again (FX-4)', async () => {
    setup();
    fireEvent.click(await row(/Seen already/));
    fireEvent.click(within(reader()).getByRole('button', { name: 'Close paper' }));
    expect(screen.queryByRole('region', { name: 'Paper' })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: 'Resize papers list' })).not.toBeInTheDocument();
  });

  it('opens the paper\'s own page: the read link, else the DOI, else says there is no page', async () => {
    setup({ world: { findings: [
      findingFixture('a', 'With read link', { run_id: 'run-1', read_url: 'https://arxiv.org/html/2510.1' }),
      findingFixture('b', 'DOI only', { run_id: 'run-1', read_url: null }, { doi: '10.1000/abc' }),
      findingFixture('c', 'No page at all', { run_id: 'run-1', read_url: null }, { doi: null }),
    ] } });
    fireEvent.click(await row(/With read link/));
    expect(within(reader()).getByRole('link', { name: 'Open in browser' })).toHaveAttribute('href', 'https://arxiv.org/html/2510.1');
    fireEvent.click(screen.getByRole('button', { name: /DOI only/ }));
    expect(within(reader()).getByRole('link', { name: 'Open in browser' })).toHaveAttribute('href', 'https://doi.org/10.1000/abc');
    fireEvent.click(screen.getByRole('button', { name: /No page at all/ }));
    expect(within(reader()).getByText('This paper has no page to open.')).toBeInTheDocument();
  });

  it('keeps the paper open when it leaves the list: under Show → New, opening it makes it seen', async () => {
    const h = setup({ filters: { show: 'new' } });
    fireEvent.click(await row(/RailS/));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/findings/f1/seen')).toHaveLength(1));
    // the backend now counts one paper fewer as unseen: the page reads the list again, without the paper
    h.rerender({ search: { ...h.search, unseen: h.search.unseen - 1 } });
    await waitFor(() => expect(screen.queryByRole('button', { name: /RailS/ })).not.toBeInTheDocument());
    expect(within(reader()).getByRole('heading', { name: 'RailS: Load Balancing for All-to-All Communication' })).toBeInTheDocument();
    expect(within(reader()).getByRole('button', { name: 'Add to materials' })).toBeInTheDocument();
  });

  it('turns «Free only» on by default and asks the backend for free papers only', async () => {
    const h = setup({ filters: { free: true } });
    await row(/RailS/);
    expect(screen.getByRole('button', { name: 'Free only' })).toHaveAttribute('aria-pressed', 'true');
    expect(sent(h.request, 'GET', '/kb/explore/findings').at(-1)!.query).toMatchObject({ free_only: true });
    expect(screen.queryByRole('button', { name: /A paid study/ })).not.toBeInTheDocument();
  });
});

describe('EX3 search page — Add to materials (UX-11)', () => {
  it('adds the paper, tells you where it went and how much of it, and shows it as In Materials, not in the wiki', async () => {
    const h = setup();
    fireEvent.click(await row(/RailS/));
    fireEvent.click(within(reader()).getByRole('button', { name: 'Add to materials' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/findings/f1/materials')).toHaveLength(1));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ text: 'Added to Materials › From Explore (abstract only) · not in the wiki yet', tone: 'done' }));
    expect(within(reader()).getByText('In Materials › From Explore (abstract only) · not in the wiki')).toBeInTheDocument();
    expect(within(reader()).queryByRole('button', { name: 'Add to materials' })).not.toBeInTheDocument();
    expect(within(reader()).queryByRole('button', { name: 'Not for me' })).not.toBeInTheDocument();
    fireEvent.click(within(reader()).getByRole('button', { name: 'Open' }));
    expect(h.props.onOpenDocument).toHaveBeenCalledWith({ type: 'material', id: 'material-added' });
    expect(h.props.onChanged).toHaveBeenCalled();
  });

  it('adds only once however fast it is clicked', async () => {
    const h = setup();
    fireEvent.click(await row(/RailS/));
    const add = within(reader()).getByRole('button', { name: 'Add to materials' });
    fireEvent.click(add);
    fireEvent.click(add);
    await waitFor(() => expect(h.toast).toHaveBeenCalled());
    expect(sent(h.request, 'POST', '/kb/explore/findings/f1/materials')).toHaveLength(1);
  });

  it('lands the paper in a folder picked from the menu: the move follows the add, and both notes name the folder', async () => {
    const onMoveMaterial = vi.fn(async () => undefined);
    const h = setup({ props: {
      onMoveMaterial,
      folders: [{ id: 'fld-sec', name: 'Agent Security', system: false, material_count: 0, created_at: '2026-11-01T10:00:00Z' }],
    } });
    fireEvent.click(await row(/RailS/));
    // the split button's caret opens the folder menu; picking a folder adds the paper straight into it
    fireEvent.click(within(reader()).getByRole('button', { name: 'Choose folder for material' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Agent Security' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/findings/f1/materials')).toHaveLength(1));
    await waitFor(() => expect(onMoveMaterial).toHaveBeenCalledWith('material-added', 'fld-sec'));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ text: 'Added to Materials › Agent Security (abstract only) · not in the wiki yet', tone: 'done' }));
    expect(within(reader()).getByText('In Materials › Agent Security (abstract only) · not in the wiki')).toBeInTheDocument();
    // the plaque offers the move to another folder, with the folder it is in now
    expect(within(reader()).getByRole('button', { name: 'Move to folder' })).toHaveTextContent('Folder: Agent Security');
  });

  it('moves an added paper to another folder from the plaque, and both notes follow', async () => {
    const onMoveMaterial = vi.fn(async () => undefined);
    const h = setup({ props: {
      onMoveMaterial,
      folders: [{ id: 'fld-sec', name: 'Agent Security', system: false, material_count: 0, created_at: '2026-11-01T10:00:00Z' }],
    } });
    fireEvent.click(await row(/RailS/));
    fireEvent.click(within(reader()).getByRole('button', { name: 'Add to materials' }));
    await waitFor(() => expect(within(reader()).getByText('In Materials › From Explore (abstract only) · not in the wiki')).toBeInTheDocument());
    fireEvent.click(within(reader()).getByRole('button', { name: 'Move to folder' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Agent Security' }));
    await waitFor(() => expect(onMoveMaterial).toHaveBeenCalledWith('material-added', 'fld-sec'));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ text: 'Moved to Materials › Agent Security', tone: 'done' }));
    expect(within(reader()).getByText('In Materials › Agent Security (abstract only) · not in the wiki')).toBeInTheDocument();
    expect(within(reader()).getByRole('button', { name: 'Move to folder' })).toHaveTextContent('Folder: Agent Security');
  });

  it('makes a new folder right from the menu, and the paper lands in it', async () => {
    const onMoveMaterial = vi.fn(async () => undefined);
    const onCreateFolder = vi.fn(async (name: string) => ({ id: 'fld-new', name }));
    const h = setup({ props: { onMoveMaterial, onCreateFolder } });
    fireEvent.click(await row(/RailS/));
    fireEvent.click(within(reader()).getByRole('button', { name: 'Choose folder for material' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New folder…' }));
    fireEvent.change(within(reader()).getByRole('textbox', { name: 'New folder name' }), { target: { value: 'Agent Security' } });
    fireEvent.click(within(reader()).getByRole('button', { name: 'Create & add' }));
    await waitFor(() => expect(onCreateFolder).toHaveBeenCalledWith('Agent Security'));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/findings/f1/materials')).toHaveLength(1));
    await waitFor(() => expect(onMoveMaterial).toHaveBeenCalledWith('material-added', 'fld-new'));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ text: 'Added to Materials › Agent Security (abstract only) · not in the wiki yet', tone: 'done' }));
    expect(within(reader()).getByText('In Materials › Agent Security (abstract only) · not in the wiki')).toBeInTheDocument();
  });

  it('says what went wrong in a toast, hides provider detail, and leaves the paper as it was', async () => {
    const world = exploreWorld({ searches: [searchFixture('run-1', 'Model architectures')], findings: papers() });
    world.failing['POST /kb/explore/findings/f1/materials'] = { status: 502, detail: 'secret provider text', code: 'provider_unavailable' };
    const h = setup({ world });
    fireEvent.click(await row(/RailS/));
    fireEvent.click(within(reader()).getByRole('button', { name: 'Add to materials' }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ text: 'The search provider is unavailable. Try again in a moment.', tone: 'problem' }));
    expect(JSON.stringify(h.toast.mock.calls)).not.toContain('secret provider text');
    expect(within(reader()).getByRole('button', { name: 'Add to materials' })).toBeEnabled();
  });

  it('opens the discussion without adding the paper, and hands the chat to the app', async () => {
    const h = setup();
    fireEvent.click(await row(/RailS/));
    fireEvent.click(within(reader()).getByRole('button', { name: 'Discuss' }));
    await waitFor(() => expect(h.props.onDiscuss).toHaveBeenCalledWith('chat-discuss'));
    expect(sent(h.request, 'POST', '/kb/explore/findings/f1/discuss')).toHaveLength(1);
    expect(sent(h.request, 'POST', /\/materials$/)).toHaveLength(0);
  });

  it('opens the paper\'s page in the browser from its head', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    setup();
    fireEvent.click(await row(/RailS/));
    fireEvent.click(within(reader()).getByRole('button', { name: 'Open in browser' }));
    expect(open).toHaveBeenCalledWith('https://arxiv.org/html/f1', '_blank', 'noopener,noreferrer');
  });
});

describe('EX3 search page — Not for me (UX-2)', () => {
  it('hides the paper, closes it, and offers Undo that brings it back', async () => {
    const h = setup();
    fireEvent.click(await row(/RailS/));
    fireEvent.click(within(reader()).getByRole('button', { name: 'Not for me' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/findings/f1/dismiss')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: /RailS/ })).not.toBeInTheDocument());
    // the paper closes with the list, which has the whole page again (FX-4)
    expect(screen.queryByRole('region', { name: 'Paper' })).not.toBeInTheDocument();
    const toast = h.toast.mock.calls.at(-1)![0] as { text: string; action: { label: string; run: () => void } };
    expect(toast.text).toBe('Hidden. Show → Not for me brings it back.');
    expect(toast.action.label).toBe('Undo');
    act(() => toast.action.run());
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/findings/f1/restore')).toHaveLength(1));
    expect(await row(/RailS/)).toBeInTheDocument();
  });

  it('lists hidden papers under Show → Not for me, each with Restore', async () => {
    const h = setup({ filters: { show: 'dismissed' } });
    const hidden = await screen.findByRole('button', { name: /Hidden before/ });
    expect(screen.queryByRole('button', { name: /RailS/ })).not.toBeInTheDocument();
    const item = hidden.closest('[role="listitem"]') as HTMLElement;
    fireEvent.click(within(item).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/findings/f6/restore')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Hidden before/ })).not.toBeInTheDocument());
    expect(h.props.onChanged).toHaveBeenCalled();
  });

  it('offers Restore instead of Not for me when a hidden paper is opened', async () => {
    setup({ filters: { show: 'dismissed' } });
    fireEvent.click(await screen.findByRole('button', { name: /Hidden before/ }));
    expect(within(reader()).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(within(reader()).queryByRole('button', { name: 'Not for me' })).not.toBeInTheDocument();
  });
});

describe('EX3 search page — a paid paper (UX-3)', () => {
  const open = async (over: Partial<KbFinding> = {}) => {
    const h = setup({ world: { findings: [findingFixture('paid', 'A paid study', { run_id: 'run-1', access: 'paid', read_url: 'https://publisher.example/p', ...over })] } });
    fireEvent.click(await row(/A paid study/));
    return h;
  };
  const note = () => within(reader()).getByText(/This article is paid/);

  it('says exactly: «This article is paid. I think it\'s useful because … You can check it yourself; if you get it, add it to your materials.»', async () => {
    await open({ new_line: 'It gives the first formal bound on expert load imbalance' });
    expect(note().textContent).toBe(PAID_SENTENCE('it gives the first formal bound on expert load imbalance'));
  });

  it('gives the reason from the comparison with the wiki when there is no «new for you» line', async () => {
    await open({ new_line: null, reason: 'The library has routing methods but no load bound.' });
    expect(note().textContent).toBe(PAID_SENTENCE('the library has routing methods but no load bound'));
  });

  it('keeps a name or an acronym as it is written', async () => {
    await open({ new_line: 'MoE routing is never bounded this way' });
    expect(note().textContent).toBe(PAID_SENTENCE('MoE routing is never bounded this way'));
  });

  it('still says something true when there is no reason at all', async () => {
    await open({ new_line: null, reason: '' });
    expect(note().textContent).toBe(PAID_SENTENCE('it continues your topic'));
  });

  it('does not talk about buying, and keeps Add to materials, Discuss and Open in browser', async () => {
    await open();
    expect(note().textContent).not.toMatch(/\b(buy|purchase|pay for|price)\b/i);
    for (const name of ['Add to materials', 'Discuss', 'Open in browser', 'Not for me']) {
      expect(within(reader()).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('says nothing about it being paid for a free paper', async () => {
    setup();
    fireEvent.click(await row(/RailS/));
    expect(within(reader()).queryByText(/This article is paid/)).not.toBeInTheDocument();
  });

  it('stops saying it once the paper is added to Materials', async () => {
    await open();
    expect(note()).toBeInTheDocument();
    fireEvent.click(within(reader()).getByRole('button', { name: 'Add to materials' }));
    await within(reader()).findByText('In Materials › From Explore (abstract only) · not in the wiki');
    expect(within(reader()).queryByText(/This article is paid/)).not.toBeInTheDocument();
  });

  it('lowerFirst lowers a sentence\'s first word but keeps names and acronyms', () => {
    expect(lowerFirst('The library has it.')).toBe('the library has it');
    expect(lowerFirst('MoE routing')).toBe('MoE routing');
    expect(lowerFirst('GPT-4 changes it.')).toBe('GPT-4 changes it');
    expect(lowerFirst('Retrieval helps')).toBe('retrieval helps');
    expect(lowerFirst('a')).toBe('a');
  });
});

describe('EX3 search page — filters are remembered (UX-5)', () => {
  it('Year → Last 3 years asks again with the first year, and the choice survives a reopened page', async () => {
    const h = setup();
    await row(/RailS/);
    fireEvent.click(screen.getByRole('button', { name: 'Year' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Last 3 years' }));
    const thisYear = new Date().getFullYear();
    await waitFor(() => expect(sent(h.request, 'GET', '/kb/explore/findings').at(-1)!.query).toMatchObject({ year_from: thisYear - 3 }));
    expect(screen.getByRole('button', { name: /Last 3 years/ })).toHaveClass('is-on');
    expect(JSON.parse(localStorage.getItem('skaz.explore.filters')!)).toMatchObject({ year: '3y' });
    h.view.unmount();
    const again = setup({ filters: null });          // the page is opened again: it reads what was saved
    expect(screen.getByRole('button', { name: /Last 3 years/ })).toBeInTheDocument();
    await row(/RailS/);
    expect(sent(again.request, 'GET', '/kb/explore/findings')[0]!.query).toMatchObject({ year_from: thisYear - 3 });
  });

  it('Type, Show and Sort each send their choice and say it on the button', async () => {
    const h = setup();
    await row(/RailS/);
    const last = () => sent(h.request, 'GET', '/kb/explore/findings').at(-1)!.query;
    fireEvent.click(screen.getByRole('button', { name: 'Type' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Preprints' }));
    // the bridge carries one value per key: a single chosen type goes as `types=preprint` (a list of one for the backend)
    await waitFor(() => expect(last()).toMatchObject({ types: 'preprint' }));
    fireEvent.click(screen.getByRole('button', { name: 'New & seen' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Only new' }));
    await waitFor(() => expect(last()).toMatchObject({ show: 'new' }));
    fireEvent.click(screen.getByRole('button', { name: 'For you first' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Most cited' }));
    await waitFor(() => expect(last()).toMatchObject({ sort: 'cited', show: 'new', types: 'preprint' }));
    expect(screen.getByRole('button', { name: 'Preprints' })).toHaveClass('is-on');
    expect(screen.getByRole('button', { name: 'New' })).toHaveClass('is-on');
    expect(screen.getByRole('button', { name: 'Most cited' })).toBeInTheDocument();
  });

  it('Free only is a switch: off shows the paid papers too', async () => {
    const h = setup({ filters: { free: true } });
    await row(/RailS/);
    expect(screen.queryByRole('button', { name: /A paid study/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Free only' }));
    expect(await row(/A paid study/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Free only' })).toHaveAttribute('aria-pressed', 'false');
    expect(sent(h.request, 'GET', '/kb/explore/findings').at(-1)!.query).toMatchObject({ free_only: false });
    expect(JSON.parse(localStorage.getItem('skaz.explore.filters')!)).toMatchObject({ free: false });
  });

  it('keeps the paper view out of the way of an open menu, and gives the cover back when it closes or the page goes', async () => {
    const h = setup();
    await row(/RailS/);
    expect(h.props.onCovered).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Year' }));
    await screen.findByRole('menu', { name: 'Year' });
    expect(h.props.onCovered).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Year' }), { key: 'Escape' });
    await waitFor(() => expect(h.props.onCovered).toHaveBeenLastCalledWith(false));
    fireEvent.click(screen.getByRole('button', { name: 'Type' }));
    await screen.findByRole('menu', { name: 'Type' });
    h.view.unmount();
    expect(h.props.onCovered).toHaveBeenLastCalledWith(false);
  });
});

describe('EX3 search page — the funnel «found → fit → new» and its Steps', () => {
  it('says how many were found, fit the topic and are new, with the date', async () => {
    setup({ search: { found: 50, fit: 12, new: 4, no_text: 2, updated_at: '2026-11-09T10:05:00Z' } });
    await row(/RailS/);
    const when = new Date('2026-11-09T10:05:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    expect(screen.getByText(new RegExp(`${when} · 50 found → 12 fit → 4 new`))).toBeInTheDocument();
  });

  it('opens Steps with every stage, and what was dropped for having no text', async () => {
    setup({ search: { found: 50, fit: 12, new: 4, no_text: 2 } });
    await row(/RailS/);
    const steps = screen.getByRole('button', { name: 'Steps' });
    expect(steps).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(steps);
    expect(screen.getByRole('button', { name: 'Hide steps' })).toHaveAttribute('aria-expanded', 'true');
    const terms = screen.getAllByRole('term').map((t) => t.textContent);
    const defs = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(terms).toEqual(['Found in OpenAlex', 'Fit the topic', 'Readable (open text or a real abstract)', 'New for you (not already in your wiki)']);
    expect(defs).toEqual(['50', '12', '10 · dropped, no text: 2', '4']);
    fireEvent.click(screen.getByRole('button', { name: 'Hide steps' }));
    expect(screen.queryByRole('term')).not.toBeInTheDocument();
  });

  it('names no engine in the steps (UX-8)', async () => {
    setup();
    await row(/RailS/);
    fireEvent.click(screen.getByRole('button', { name: 'Steps' }));
    expect(document.querySelector('.kb-ex-steps')!.textContent).not.toMatch(/local model|openrouter|codex|free ·/i);
  });

  it('shows a search that is running with its live line of steps, and Stop pauses it', async () => {
    const h = setup({ search: { state: 'running', stage: 'decision', found: 31, after_rules: 40, decided: 12, fit: 0, new: 0 } });
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Understanding your request');
    expect(status).toHaveTextContent('Searching OpenAlex');
    expect(status).toHaveTextContent('Checking fit');
    expect(status).toHaveTextContent('Comparing with your wiki');
    expect(screen.getByText('12/40')).toBeInTheDocument();
    expect(screen.getByText('Checking fit').closest('li')).toHaveClass('is-on');
    expect(screen.getByText('Searching OpenAlex').closest('li')).toHaveClass('is-done');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/runs/run-1/pause')).toHaveLength(1));
    expect(h.props.onChanged).toHaveBeenCalled();
  });

  it('says it is searching before anything is found, and that papers appear as they are checked', async () => {
    setup({ search: { state: 'running', stage: 'collect', found: 0 }, world: { findings: [] } });
    expect(await screen.findByText('Searching OpenAlex')).toBeInTheDocument();
    expect(await screen.findByText('Papers appear here as they are checked.')).toBeInTheDocument();
  });

  it('says a search waits for a free place', async () => {
    setup({ search: { state: 'queued', found: 0 }, world: { findings: [] }, props: { parallelLimit: 3 } });
    expect(await screen.findByText('Waiting — 3 searches are already running.')).toBeInTheDocument();
  });

  it('reads the papers again when the counts change while it runs, so new ones appear', async () => {
    const h = setup({ search: { state: 'running', stage: 'novelty', found: 10, new: 0, unseen: 0 }, world: { findings: [] } });
    await screen.findByText('Papers appear here as they are checked.');
    h.world.findings = papers();
    h.rerender({ search: { ...h.search, new: 2, unseen: 2 } });
    expect(await row(/RailS/)).toBeInTheDocument();
  });
});

describe('EX3 search page — a search that stopped says why and what you can do', () => {
  const stopped = (stop_reason: string, extra: Record<string, unknown> = {}) => setup({
    search: { state: 'paused', stop_reason, checkpoint_id: 'cp-1', checkpoint_revision: 4, ...extra }, world: { findings: [] },
  });

  it.each([
    ['decision_model_required', true, false],
    ['science_consent_required', true, true],
    ['openalex_daily_limit', true, true],
    ['budget', false, true],
    ['user_pause', false, true],
    ['app_exit', false, true],
  ])('%s: settings button %s, continue button %s', async (reason, settings, resume) => {
    stopped(reason);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(STOP_TEXT[reason]!.text);
    expect(within(alert).queryByRole('button', { name: 'Open Settings' }) !== null).toBe(settings);
    expect(within(alert).queryByRole('button', { name: 'Continue' }) !== null).toBe(resume);
  });

  it('science consent: Open Settings goes to Settings → Search; Continue resumes from the saved checkpoint', async () => {
    const h = stopped('science_consent_required');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('SKAZ needs your OK to send the topic words to OpenAlex.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Open Settings' }));
    expect(h.props.onOpenSettings).toHaveBeenCalledWith('search');
    fireEvent.click(within(alert).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/runs/run-1/continue')[0]!.body).toEqual({ checkpoint_id: 'cp-1', revision: 4 }));
    expect(h.props.onChanged).toHaveBeenCalled();
  });

  it('a Quit-paused search says the paid checks wait for your Continue', async () => {
    stopped('app_exit');
    expect(await screen.findByRole('alert')).toHaveTextContent('paid checks wait for your Continue');
  });

  it('a provider that did not answer can be tried again', async () => {
    stopped('provider_unavailable');
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('offers no Continue when there is no checkpoint to continue from, and none for a failed search', async () => {
    stopped('user_pause', { checkpoint_id: null, checkpoint_revision: null });
    const alert = await screen.findByRole('alert');
    expect(within(alert).queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    cleanup();
    setup({ search: { state: 'error', stop_reason: 'failed', checkpoint_id: 'cp', checkpoint_revision: 1 }, world: { findings: [] } });
    const failed = await screen.findByRole('alert');
    expect(failed).toHaveTextContent('This search failed.');
    expect(within(failed).queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows what was found so far next to the stop', async () => {
    setup({ search: { state: 'paused', stop_reason: 'budget', checkpoint_id: 'cp', checkpoint_revision: 1 } });
    expect(await row(/RailS/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Paused at the step limit of this search.');
  });

  it('a stop with no reason falls back to «Paused»', async () => {
    setup({ search: { state: 'paused', stop_reason: null, checkpoint_id: 'cp', checkpoint_revision: 1 }, world: { findings: [] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Paused.');
  });
});

describe('EX3 search page — empty and failing lists tell the truth', () => {
  it('nothing found: says so', async () => {
    setup({ search: { found: 0, fit: 0, new: 0, no_text: 0 }, world: { findings: [] } });
    expect(await screen.findByText('Nothing found')).toBeInTheDocument();
  });

  it('nothing new: every paper that fit is already in the wiki — and counts the ones with no text', async () => {
    setup({ search: { found: 30, fit: 8, new: 0, no_text: 0 }, world: { findings: [] } });
    expect(await screen.findByText('Nothing new for you')).toBeInTheDocument();
    expect(screen.getByText('Every paper that fit is already covered by your wiki.')).toBeInTheDocument();
    cleanup();
    setup({ search: { found: 30, fit: 8, new: 0, no_text: 3 }, world: { findings: [] } });
    expect(await screen.findByText('Every paper that fit is already in your wiki, or had no text to read (3).')).toBeInTheDocument();
  });

  it('papers exist but the filters hide them: Clear filters brings the default view back and keeps the sort', async () => {
    const h = setup({ filters: { free: false, year: '1y', type: 'review', sort: 'cited' }, world: { findings: [] }, search: { new: 4 } });
    fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('skaz.explore.filters')!)).toEqual({ ...DEFAULT_FILTERS, sort: 'cited' }));
    const last = () => sent(h.request, 'GET', '/kb/explore/findings').at(-1)!.query;
    await waitFor(() => expect(last()).toMatchObject({ free_only: true, show: 'active', sort: 'cited' }));
    expect(last()).not.toHaveProperty('year_from');
    expect(last()).not.toHaveProperty('types');
  });

  it('with the default filters, the way out is to show paid papers too — not a useless Clear filters', async () => {
    setup({ filters: { free: true }, world: { findings: [] }, search: { new: 4 } });
    expect(await screen.findByText('Nothing matches the filters')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show paid papers too' }));
    expect(screen.getByRole('button', { name: 'Free only' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('says a read failed without provider detail, and Try again reads the papers again', async () => {
    const world = exploreWorld({ searches: [searchFixture('run-1', 'Model architectures')], findings: papers() });
    world.failing['GET /kb/explore/findings'] = { status: 500, detail: 'secret provider text' };
    setup({ world });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t complete this request. Try again.');
    expect(screen.queryByText(/secret provider text/)).not.toBeInTheDocument();
    delete world.failing['GET /kb/explore/findings'];
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await row(/RailS/)).toBeInTheDocument();
  });
});

describe('EX3 search page — the paper view', () => {
  const view = () => ({ show: vi.fn(async () => true), bounds: vi.fn(async () => true), hide: vi.fn(async () => true), navigate: vi.fn(async () => true), onState: vi.fn(() => () => undefined) });
  afterEach(() => { delete (window as { skaz?: unknown }).skaz; });

  it('opens the paper\'s page in the native view over the slot, and hides it while something covers it', async () => {
    const paper = view();
    (window as unknown as { skaz: unknown }).skaz = { paperReader: paper };
    const h = setup();
    fireEvent.click(await row(/RailS/));
    await waitFor(() => expect(paper.show).toHaveBeenCalledWith('https://arxiv.org/html/f1', expect.objectContaining({ width: expect.any(Number) })));
    paper.hide.mockClear();
    h.rerender({ covered: true });
    await waitFor(() => expect(paper.hide).toHaveBeenCalled());
    paper.show.mockClear();
    h.rerender({ covered: false });
    await waitFor(() => expect(paper.show).toHaveBeenCalledTimes(1));
  });

  it('hides the view when the paper is closed', async () => {
    const paper = view();
    (window as unknown as { skaz: unknown }).skaz = { paperReader: paper };
    setup();
    fireEvent.click(await row(/RailS/));
    await waitFor(() => expect(paper.show).toHaveBeenCalled());
    paper.hide.mockClear();
    fireEvent.click(within(reader()).getByRole('button', { name: 'Close paper' }));
    expect(paper.hide).toHaveBeenCalled();
  });
});
