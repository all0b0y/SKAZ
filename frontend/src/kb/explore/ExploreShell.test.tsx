import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeRequest } from '../../api/bridge';
import { renderKb } from '../test/renderKb';
import { exploreWorld, findingFixture, searchFixture, serveExplore, type ExploreWorld } from './test/fixtures';

const isExplore = (req: BridgeRequest) => req.path.startsWith('/kb/explore/') || req.path === '/kb/settings/weekly-check' || req.path.startsWith('/kb/freshness/weekly-checks/');

/** The whole interface on its fake bridge, with the Explore routes answered from `world`. */
function app(world: ExploreWorld) {
  const r = renderKb();
  const original = r.fake.requestMock.getMockImplementation()!;
  r.fake.requestMock.mockImplementation(async (req) => (isExplore(req) ? serveExplore(world, req) : original(req)));
  return r;
}

const rail = () => screen.findByRole('navigation', { name: 'Sections' });
const openExplore = async () => {
  fireEvent.click(within(await rail()).getByRole('button', { name: /^Explore/ }));
};

beforeEach(() => { localStorage.setItem('skaz.explore.filters', JSON.stringify({ free: false })); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as { skaz?: unknown }).skaz; });

describe('EX3 Explore in the shell', () => {
  it('puts Explore in the rail between Wiki and Study', async () => {
    app(exploreWorld());
    const names = within(await rail()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    const order = ['Wiki', 'Explore', 'Study', 'Notifications'].map((n) => names.findIndex((x) => x.startsWith(n)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('opens the page in the centre and the map and searches in the side panel (UX-12)', async () => {
    app(exploreWorld({ searches: [searchFixture('run-1', 'Model architectures', { area_id: 'arch', unseen: 47 })] }));
    await openExplore();
    await waitFor(() => expect(document.querySelector('[data-pane="explore"]')).toBeTruthy());
    const side = document.querySelector<HTMLElement>('[data-pane="side"]')!;
    const nav = await within(side).findByRole('navigation', { name: 'Explore' });
    expect(within(nav).getByRole('button', { name: 'Map of your wiki' })).toHaveAttribute('aria-current', 'page');
    expect(await within(nav).findByRole('button', { name: /Model architectures/ })).toHaveTextContent('+47');
    // the page is the map of the wiki, with its find bar
    const pane = document.querySelector<HTMLElement>('[data-pane="explore"]')!;
    expect(within(pane).getByRole('search')).toBeInTheDocument();
    expect(await within(pane).findByText('Your wiki by topic')).toBeInTheDocument();
  });

  it('a search in the side list opens full page, and the map row comes back', async () => {
    const world = exploreWorld({
      searches: [searchFixture('run-1', 'Model architectures', { area_id: 'arch' })],
      findings: [findingFixture('f1', 'RailS: Load Balancing', { run_id: 'run-1' })],
    });
    app(world);
    await openExplore();
    const side = document.querySelector<HTMLElement>('[data-pane="side"]')!;
    fireEvent.click(await within(side).findByRole('button', { name: /Model architectures/ }));
    const pane = document.querySelector<HTMLElement>('[data-pane="explore"]')!;
    expect(await within(pane).findByRole('heading', { name: 'Model architectures' })).toBeInTheDocument();
    expect(await within(pane).findByRole('button', { name: /RailS/ })).toBeInTheDocument();
    // FX-4: the reader slot is not there until a paper is picked — the list has the page to itself
    expect(within(pane).queryByRole('region', { name: 'Paper' })).not.toBeInTheDocument();
    fireEvent.click(within(pane).getByRole('button', { name: /RailS/ }));
    expect(within(pane).getByRole('region', { name: 'Paper' })).toBeInTheDocument();
    fireEvent.click(within(side).getByRole('button', { name: 'Map of your wiki' }));
    expect(await within(pane).findByText('Your wiki by topic')).toBeInTheDocument();
    expect(within(pane).queryByRole('region', { name: 'Paper' })).not.toBeInTheDocument();
  });

  it('keeps what you were looking at when you leave Explore and come back', async () => {
    const world = exploreWorld({ searches: [searchFixture('run-1', 'Model architectures', { area_id: 'arch' })] });
    app(world);
    await openExplore();
    const side = document.querySelector<HTMLElement>('[data-pane="side"]')!;
    fireEvent.click(await within(side).findByRole('button', { name: /Model architectures/ }));
    await screen.findByRole('region', { name: 'Papers found' });
    fireEvent.click(within(await rail()).getByRole('button', { name: /^Wiki/ }));
    await waitFor(() => expect(document.querySelector('[data-pane="explore"]')).toBeNull());
    await openExplore();
    expect(await screen.findByRole('region', { name: 'Papers found' })).toBeInTheDocument();
  });

  it('is hidden by the shell while a document is opened full width, and the paper view goes with it', async () => {
    const paper = { show: vi.fn(async () => true), bounds: vi.fn(async () => true), hide: vi.fn(async () => true), navigate: vi.fn(async () => true), onState: vi.fn(() => () => undefined) };
    (window as unknown as { skaz: unknown }).skaz = { paperReader: paper };
    const world = exploreWorld({
      searches: [searchFixture('run-1', 'Model architectures', { area_id: 'arch' })],
      findings: [findingFixture('f1', 'RailS: Load Balancing', { run_id: 'run-1' })],
    });
    const { services } = app(world);
    await openExplore();
    const side = document.querySelector<HTMLElement>('[data-pane="side"]')!;
    fireEvent.click(await within(side).findByRole('button', { name: /Model architectures/ }));
    fireEvent.click(await screen.findByRole('button', { name: /RailS/ }));
    await waitFor(() => expect(paper.show).toHaveBeenCalled());
    paper.hide.mockClear();
    act(() => { services.ui.getState().openDocument({ type: 'material', id: 'm-a' }); services.ui.getState().toggleDocExpanded(); });
    const pane = document.querySelector<HTMLElement>('[data-pane="explore"]')!;
    expect(pane.hidden).toBe(true);
    await waitFor(() => expect(paper.hide).toHaveBeenCalled());
  });
});
