import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KbServicesProvider } from '../state/context';
import { ExploreSide } from './ExploreSide';
import { exploreState } from './exploreState';
import { exploreHarness, exploreWorld, searchFixture, sent, type ExploreWorld } from './test/fixtures';

afterEach(cleanup);

const searches = () => [
  searchFixture('run-live', 'KV cache compression', { state: 'running', found: 31, area_id: 'inf', query: 'KV cache' }),
  searchFixture('run-wait', 'Business communication', { state: 'queued', found: 0, area_id: 'biz', unseen: 0 }),
  searchFixture('run-done', 'Model architectures', { area_id: 'arch', unseen: 47 }),
  searchFixture('run-seen', 'Everything', { area_id: null, unseen: 0 }),
  searchFixture('run-week', 'LLM systems', { owner: 'weekly', area_id: 'llm', unseen: 0 }),
  searchFixture('run-stop', 'Self-correction', { state: 'paused', stop_reason: 'user_pause' }),
  searchFixture('run-bad', 'Broken one', { state: 'error' }),
];

function setup(world: ExploreWorld = exploreWorld({ searches: searches() })) {
  const h = exploreHarness(world);
  const view = render(<KbServicesProvider services={h.services}><ExploreSide /></KbServicesProvider>);
  // The component made the store of this library; asking again for the same client returns that one.
  const store = exploreState(h.services.client, async () => ({ items: [], parallel_limit: 3 }));
  return { ...h, store, view };
}

const rowOf = async (name: RegExp | string) => {
  const button = await screen.findByRole('button', { name: typeof name === 'string' ? new RegExp(name) : name });
  return button.closest('li') as HTMLElement;
};
const openMenu = async (name: RegExp | string) => {
  const item = await rowOf(name);
  fireEvent.click(within(item).getByRole('button', { name: 'Search actions' }));
  return item;
};

describe('EX3 side list — the map, then the searches with their live status (UX-12)', () => {
  it('starts with «Map of your wiki», current while the map is shown, then the Searches', async () => {
    setup();
    const nav = await screen.findByRole('navigation', { name: 'Explore' });
    const map = within(nav).getByRole('button', { name: 'Map of your wiki' });
    expect(map).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('heading', { name: 'Searches' })).toBeInTheDocument();
    await rowOf(/Model architectures/);
  });

  it('shows what each search is doing: found so far, waiting, +N new, 0 new, paused, failed', async () => {
    setup();
    const status = async (name: string) => within(await rowOf(new RegExp(name))).getByText(/found…|Waiting|^\+\d+$|0 new|Paused|Failed|Stopped/);
    expect(await status('KV cache compression')).toHaveTextContent('31 found…');
    expect(await status('Business communication')).toHaveTextContent('Waiting');
    expect(await status('Model architectures')).toHaveTextContent('+47');
    expect(await status('Everything')).toHaveTextContent('0 new');
    expect(await status('Self-correction')).toHaveTextContent('Paused');
    expect(await status('Broken one')).toHaveTextContent('Failed');
    expect(await status('Model architectures')).toHaveClass('is-new');
    expect(await status('Self-correction')).toHaveClass('is-stop');
  });

  it('marks a weekly search with «Weekly ·» in front of its name', async () => {
    setup();
    expect(await screen.findByText('Weekly · LLM systems')).toBeInTheDocument();
  });

  it('says there are no searches yet, and where to start one', async () => {
    setup(exploreWorld({ searches: [] }));
    expect(await screen.findByText(/None yet\. Pick a topic on the map and press “Find what's new”\./)).toBeInTheDocument();
  });

  it('says the searches could not be read, keeps what it had, and Try again reads them', async () => {
    const world = exploreWorld({ searches: searches() });
    world.failing['GET /kb/explore/searches'] = { status: 500, detail: 'x' };
    setup(world);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Searches could not be read.');
    delete world.failing['GET /kb/explore/searches'];
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await rowOf(/Model architectures/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens a search on a click (it is then the current row), and the map row goes back', async () => {
    const h = setup();
    const item = await rowOf(/Model architectures/);
    fireEvent.click(within(item).getByRole('button', { name: /Model architectures/ }));
    expect(h.store.getState().page).toEqual({ kind: 'search', id: 'run-done' });
    await waitFor(() => expect(item).toHaveClass('is-on'));
    expect(within(item).getByRole('button', { name: /Model architectures/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Map of your wiki' })).not.toHaveAttribute('aria-current');
    fireEvent.click(screen.getByRole('button', { name: 'Map of your wiki' }));
    expect(h.store.getState().page).toEqual({ kind: 'map' });
  });

  it('follows a running search: the list is read again while it runs and shows the new count', async () => {
    const h = setup();
    await rowOf(/KV cache compression/);
    h.world.searches[0]!.found = 44;
    await waitFor(() => expect(screen.getByText('44 found…')).toBeInTheDocument(), { timeout: 4000 });
  });
});

describe('EX3 side list — Rename (UX-12)', () => {
  it('renames a search from its menu, and the list shows the new name', async () => {
    const h = setup();
    await openMenu(/Model architectures/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename search' });
    const field = within(dialog).getByRole('textbox', { name: 'Name' });
    expect(field).toHaveValue('Model architectures');
    fireEvent.change(field, { target: { value: '  MoE routing  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(sent(h.request, 'PUT', '/kb/explore/searches/run-done/name')[0]!.body).toEqual({ name: 'MoE routing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: /MoE routing/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Model architectures/ })).not.toBeInTheDocument();
  });

  it('does not rename to an empty name', async () => {
    const h = setup();
    await openMenu(/Model architectures/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename search' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: '   ' } });
    expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeDisabled();
    fireEvent.submit(within(dialog).getByRole('textbox', { name: 'Name' }).closest('form')!);
    expect(sent(h.request, 'PUT', /\/name$/)).toHaveLength(0);
  });

  it('keeps the dialog open with a plain message when renaming fails, and shows no provider detail', async () => {
    const world = exploreWorld({ searches: searches() });
    world.failing['PUT /kb/explore/searches/run-done/name'] = { status: 502, detail: 'secret provider text', code: 'provider_unavailable' };
    setup(world);
    await openMenu(/Model architectures/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename search' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'New name' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The search provider is unavailable. Try again in a moment.');
    expect(screen.queryByText(/secret provider text/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('New name');
    expect(within(dialog).getByRole('button', { name: 'Rename' })).toBeEnabled();
  });

  it('Cancel leaves the name alone', async () => {
    const h = setup();
    await openMenu(/Model architectures/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Rename search' })).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sent(h.request, 'PUT', /\/name$/)).toHaveLength(0);
  });
});

describe('EX3 side list — Delete (UX-12: it never touches the papers you added)', () => {
  it('asks first, names the search, and says the added papers stay in Materials', async () => {
    const h = setup();
    await openMenu(/Model architectures/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this search?' });
    expect(dialog).toHaveTextContent('“Model architectures” and its list of papers go. Papers you added stay in Materials.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sent(h.request, 'DELETE', /\/kb\/explore\/searches\//)).toHaveLength(0);
  });

  it('deletes it, drops the row, and says so', async () => {
    const h = setup();
    await openMenu(/Model architectures/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this search?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sent(h.request, 'DELETE', '/kb/explore/searches/run-done')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Model architectures/ })).not.toBeInTheDocument());
    expect(h.services.ui.getState().toast).toMatchObject({ text: 'Search deleted. Papers you added stay in Materials.' });
    expect(screen.getByRole('button', { name: /KV cache compression/ })).toBeInTheDocument();
  });

  it('goes back to the map when the open search is deleted', async () => {
    const h = setup();
    await rowOf(/Model architectures/);
    act(() => h.store.getState().showSearch('run-done'));
    await openMenu(/Model architectures/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this search?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(h.store.getState().page).toEqual({ kind: 'map' }));
  });

  it('stays on the open search when another one is deleted', async () => {
    const h = setup();
    await rowOf(/Model architectures/);
    act(() => h.store.getState().showSearch('run-done'));
    await openMenu(/Business communication/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this search?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Business communication/ })).not.toBeInTheDocument());
    expect(h.store.getState().page).toEqual({ kind: 'search', id: 'run-done' });
  });

  it('says a delete that failed, with a plain message', async () => {
    const world = exploreWorld({ searches: searches() });
    world.failing['DELETE /kb/explore/searches/run-done'] = { status: 500, detail: 'secret provider text' };
    const h = setup(world);
    await openMenu(/Model architectures/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this search?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(h.services.ui.getState().toast).toMatchObject({ text: 'Couldn’t complete this request. Try again.', tone: 'problem' }));
    expect(screen.getByRole('button', { name: /Model architectures/ })).toBeInTheDocument();
  });
});

describe('EX3 side list — Run again (UX-12)', () => {
  it('starts a new search with the same topic and words, and opens it', async () => {
    const h = setup();
    await openMenu(/KV cache compression/);   // running: Run again is off; use a finished one below
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Search actions' }), { key: 'Escape' });
    await openMenu(/Model architectures/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Run again' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/runs')).toHaveLength(1));
    expect(sent(h.request, 'POST', '/kb/explore/runs')[0]!.body).toEqual({ area_id: 'arch', query: '', all_topics: false });
    await waitFor(() => expect(h.store.getState().page.kind).toBe('search'));
    const page = h.store.getState().page as { kind: 'search'; id: string };
    expect(page.id).not.toBe('run-done');
    expect(h.store.getState().searches.map((s) => s.id)).toContain(page.id);
    // the old search stays
    expect(screen.getAllByRole('button', { name: /Model architectures/ }).length).toBeGreaterThanOrEqual(2);
  });

  it('repeats the words of a search that had some', async () => {
    const h = setup(exploreWorld({ searches: [searchFixture('run-q', 'KV cache', { area_id: 'inf', query: 'KV cache compression' })] }));
    await openMenu(/KV cache/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Run again' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/runs')[0]!.body).toEqual({ area_id: 'inf', query: 'KV cache compression', all_topics: false }));
  });

  it('a search over all your topics runs over all of them again', async () => {
    const h = setup();
    await openMenu(/Everything/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Run again' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/runs')[0]!.body).toEqual({ area_id: null, query: '', all_topics: true }));
  });

  it('a weekly search is run again as a search of its own', async () => {
    const h = setup();
    await openMenu(/Weekly · LLM systems/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Run again' }));
    await waitFor(() => expect(sent(h.request, 'POST', '/kb/explore/runs')[0]!.body).toEqual({ area_id: 'llm', query: '', all_topics: false }));
  });

  it('is not offered while the search runs or waits', async () => {
    const h = setup();
    for (const name of [/KV cache compression/, /Business communication/]) {
      await openMenu(name);
      const again = await screen.findByRole('menuitem', { name: /Run again/ });
      expect(again).toHaveAttribute('aria-disabled', 'true');
      expect(again).toHaveTextContent('Running');
      fireEvent.click(again);
      fireEvent.keyDown(screen.getByRole('menu', { name: 'Search actions' }), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    }
    expect(sent(h.request, 'POST', '/kb/explore/runs')).toHaveLength(0);
  });

  it('says in a toast when the new search could not start', async () => {
    const world = exploreWorld({ searches: searches() });
    world.failing['POST /kb/explore/runs'] = { status: 403, detail: 'secret', code: 'consent_required' };
    const h = setup(world);
    await openMenu(/Model architectures/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Run again' }));
    await waitFor(() => expect(h.services.ui.getState().toast).toMatchObject({ text: 'Science search needs your permission in Settings → Search.', tone: 'problem' }));
    expect(h.store.getState().page).toEqual({ kind: 'map' });
  });
});

describe('EX3 side list — its dialogs cover the paper view', () => {
  it('counts a dialog as a cover while it is open, and gives it back when it closes', async () => {
    const h = setup();
    await openMenu(/Model architectures/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    await screen.findByRole('dialog', { name: 'Rename search' });
    expect(h.store.getState().covers).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(h.store.getState().covers).toBe(0));
    await openMenu(/Model architectures/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await screen.findByRole('dialog', { name: 'Delete this search?' });
    expect(h.store.getState().covers).toBe(1);
  });

  it('gives the cover back when the list goes away with a dialog open', async () => {
    const h = setup();
    await openMenu(/Model architectures/);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await screen.findByRole('dialog', { name: 'Delete this search?' });
    expect(h.store.getState().covers).toBe(1);
    h.view.unmount();
    expect(h.store.getState().covers).toBe(0);
  });
});
