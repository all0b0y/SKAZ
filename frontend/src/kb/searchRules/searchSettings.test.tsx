import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { searchSettingsStore, siteOf, sitesShort } from './sites';

// N7 · Settings → Search: the global rules every chat starts from (Never, Only these sites, Prefer).

const openSettings = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  return screen.findByRole('dialog', { name: 'Settings' });
};
type Call = { method: string; path: string; body?: unknown };
const lastPut = (calls: Call[]) => [...calls].reverse().find((c) => c.method === 'PUT' && c.path === '/kb/settings/search')?.body as Record<string, unknown> | undefined;
const row = (dialog: HTMLElement, label: string) => within(dialog).getByRole('group', { name: label });

describe('site names', () => {
  it('keep the site of a pasted link and refuse what is no site', () => {
    expect(siteOf('https://www.Arxiv.org/abs/1')).toBe('arxiv.org');
    expect(siteOf('*.pinterest.com')).toBe('pinterest.com');
    expect(siteOf('pubmed.ncbi.nlm.nih.gov/')).toBe('pubmed.ncbi.nlm.nih.gov');
    expect(siteOf('not a site')).toBeNull();
    expect(siteOf('localhost')).toBeNull();
    expect(siteOf('1.2.3.4')).toBeNull();
    expect(sitesShort(['pinterest.com', 'quora.com', 'medium.com'])).toBe('pinterest.com +2');
  });
});

describe('Settings → Search (N7)', () => {
  it('is the last section of the menu and saves each list at once', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.searchSettings = { never: ['pinterest.com'], only_on: false, only: ['arxiv.org'], prefer: [], beta: true };
    const { fake } = renderKb({ world });
    const dialog = await openSettings();
    const nav = within(dialog).getByRole('navigation', { name: 'Settings sections' });
    const items = within(nav).getAllByRole('button').map((b) => b.textContent);
    expect(items[items.length - 1]).toBe('Search');
    await user.click(within(nav).getByRole('button', { name: 'Search' }));
    expect(within(dialog).getByRole('heading', { name: 'Search', level: 3 })).toBeInTheDocument();

    const never = row(dialog, 'Blocked sites');
    expect(never).toHaveTextContent('Always, in every chat. Links from these sites are removed before the agent sees them.');
    const blocked = await within(never).findByRole('list', { name: 'Blocked sites' });
    expect(within(blocked).getByText('pinterest.com')).toBeInTheDocument();
    await user.click(within(never).getByRole('button', { name: 'Add site' }));
    await user.type(within(never).getByRole('textbox', { name: 'Add to blocked sites' }), 'https://www.Quora.com/q{Enter}');
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PUT', path: '/kb/settings/search', body: { never: ['pinterest.com', 'quora.com'], only_on: false, only: ['arxiv.org'], prefer: [], beta: true },
    })));
    expect(within(blocked).getByText('quora.com')).toBeInTheDocument();
    await user.click(within(never).getByRole('button', { name: 'Remove pinterest.com' }));
    await waitFor(() => expect(within(blocked).queryByText('pinterest.com')).toBeNull());
    await waitFor(() => expect(lastPut(fake.calls)?.never).toEqual(['quora.com']));

    // «Only these sites»: a switch beside the label; the list stays editable (muted) while it is off.
    const only = row(dialog, 'Only these sites');
    const toggle = within(only).getByRole('switch', { name: 'Only these sites' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(lastPut(fake.calls)?.only_on).toBe(true));

    const prefer = row(dialog, 'Preferred sites');
    expect(prefer).toHaveTextContent('Google Scholar can’t be searched directly');
    await user.click(within(prefer).getByRole('button', { name: 'Add site' }));
    await user.type(within(prefer).getByRole('textbox', { name: 'Add to preferred sites' }), 'not a site{Enter}');
    expect(within(prefer).getByRole('alert')).toHaveTextContent('Write it like example.com.');
    expect(lastPut(fake.calls)?.prefer).toEqual([]);
  });

  it('saves a typed site when leaving the field without pressing Enter', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.searchSettings = { never: [], only_on: true, only: [], prefer: [], beta: true };
    const { fake } = renderKb({ world });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    const only = row(dialog, 'Only these sites');
    await user.click(await within(only).findByRole('button', { name: 'Add site' }));
    await user.type(within(only).getByRole('textbox', { name: 'Add to only these sites' }), 'https://www.Example.org/evidence');
    await user.click(within(dialog).getByRole('heading', { name: 'Search', level: 3 }));
    await waitFor(() => expect(lastPut(fake.calls)?.only).toEqual(['example.org']));
    expect(within(only).getByText('example.org')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    const reopened = await openSettings();
    await user.click(within(reopened).getByRole('button', { name: 'Search' }));
    expect(await within(row(reopened, 'Only these sites')).findByText('example.org')).toBeInTheDocument();
  });

  it.each([
    ['Blocked sites', 'never'], ['Only these sites', 'only'], ['Preferred sites', 'prefer'],
  ] as const)('offers an explicit Add action for %s', async (label, key) => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.searchSettings = { never: [], only_on: false, only: [], prefer: [], beta: true };
    const { fake } = renderKb({ world });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    const group = row(dialog, label);
    await user.click(await within(group).findByRole('button', { name: 'Add site' }));
    await user.type(within(group).getByRole('textbox'), 'https://www.Example.org/evidence');
    await user.click(within(group).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(lastPut(fake.calls)?.[key]).toEqual(['example.org']));
    expect(within(group).getByText('example.org')).toBeInTheDocument();
    expect(fake.calls.filter((c) => c.method === 'PUT' && c.path === '/kb/settings/search')).toHaveLength(1);
  });

  it('keeps the switch click when a typed site starts a slow autosave on blur', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.searchSettings = { never: [], only_on: false, only: [], prefer: [], beta: true };
    const { fake, services } = renderKb({ world });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    const only = row(dialog, 'Only these sites');
    await user.click(await within(only).findByRole('button', { name: 'Add site' }));
    await user.type(within(only).getByRole('textbox'), 'example.org');
    const request = fake.requestMock.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    fake.requestMock.mockImplementation(async (req) => {
      if (req.method === 'PUT' && req.path === '/kb/settings/search') await held;
      return request(req);
    });
    try {
      const toggle = within(only).getByRole('switch', { name: 'Only these sites' });
      await user.click(toggle);
      expect(toggle).toBeChecked();
      expect(fake.requestMock.mock.calls.filter(([req]) => req.method === 'PUT' && req.path === '/kb/settings/search')).toHaveLength(1);
    } finally {
      release();
    }
    await waitFor(async () => expect(await services.client.call('GET /kb/settings/search')).toEqual({ never: [], only_on: true, only: ['example.org'], prefer: [], beta: true }));
  });

  it('does not let an older read undo a confirmed save', async () => {
    const world = chatWorld();
    world.searchSettings = { never: [], only_on: false, only: [], prefer: [], beta: true };
    const { fake, services } = renderKb({ world });
    const store = searchSettingsStore(services.client);
    await waitFor(() => expect(store.getState().rules).not.toBeNull());
    const request = fake.requestMock.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    fake.requestMock.mockImplementation(async (req) => {
      const reply = await request(req);
      if (req.method === 'GET' && req.path === '/kb/settings/search') { entered(); await held; }
      return reply;
    });
    let loading!: Promise<void>;
    act(() => { loading = store.getState().load(); });
    await started;
    try {
      await act(async () => { await store.getState().save({ never: [], only_on: true, only: ['example.org'], prefer: [], beta: true }); });
    } finally {
      release();
    }
    await act(async () => { await loading; });
    expect(store.getState().rules).toEqual({ never: [], only_on: true, only: ['example.org'], prefer: [], beta: true });
  });

  it('is found by «Find a setting»', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const dialog = await openSettings();
    await user.type(within(dialog).getByRole('searchbox', { name: 'Find a setting' }), 'blocked sites');
    expect(await within(dialog).findByRole('group', { name: 'Blocked sites' })).toBeInTheDocument();
  });

  it('keeps Only and Prefer behind a persisted Beta switch without deleting their lists', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.searchSettings = {
      never: ['pinterest.com'], only_on: true, only: ['arxiv.org'], prefer: ['acm.org'], beta: false,
    };
    const { fake } = renderKb({ world });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    const beta = row(dialog, 'Beta search features');
    expect(within(beta).getByRole('switch', { name: 'Beta search features' })).not.toBeChecked();
    expect(within(beta).getByText('When off, these rules are paused for new searches. Your lists are kept.')).toBeInTheDocument();
    expect(row(dialog, 'Blocked sites')).toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: 'Only these sites' })).toBeNull();
    expect(within(dialog).queryByRole('group', { name: 'Preferred sites' })).toBeNull();

    await user.click(within(beta).getByRole('switch', { name: 'Beta search features' }));
    await waitFor(() => expect(lastPut(fake.calls)).toEqual({
      never: ['pinterest.com'], only_on: true, only: ['arxiv.org'], prefer: ['acm.org'], beta: true,
    }));
    expect(await within(dialog).findByRole('group', { name: 'Only these sites' })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: 'Preferred sites' })).toBeInTheDocument();

    await user.click(within(beta).getByRole('switch', { name: 'Beta search features' }));
    await waitFor(() => expect(lastPut(fake.calls)?.beta).toBe(false));
    expect(lastPut(fake.calls)?.only).toEqual(['arxiv.org']);
    expect(lastPut(fake.calls)?.prefer).toEqual(['acm.org']);
    expect(within(dialog).queryByRole('group', { name: 'Only these sites' })).toBeNull();
    expect(within(dialog).queryByRole('group', { name: 'Preferred sites' })).toBeNull();
  });

  it('Find a setting leads Only and Prefer to Beta while it is off', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.searchSettings = { never: [], only_on: false, only: [], prefer: [], beta: false };
    renderKb({ world });
    const dialog = await openSettings();
    await user.type(within(dialog).getByRole('searchbox', { name: 'Find a setting' }), 'prefer');
    expect(await within(dialog).findByRole('group', { name: 'Beta search features' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: 'Preferred sites' })).toBeNull();
    await user.click(within(dialog).getByRole('switch', { name: 'Beta search features' }));
    expect(await within(dialog).findByRole('group', { name: 'Preferred sites' })).toBeInTheDocument();
  });
});
