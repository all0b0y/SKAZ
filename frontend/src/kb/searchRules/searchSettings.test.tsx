import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';
import { siteOf, sitesShort } from './sites';

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
    world.searchSettings = { never: ['pinterest.com'], only_on: false, only: ['arxiv.org'], prefer: [] };
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
      method: 'PUT', path: '/kb/settings/search', body: { never: ['pinterest.com', 'quora.com'], only_on: false, only: ['arxiv.org'], prefer: [] },
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

  it('is found by «Find a setting»', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const dialog = await openSettings();
    await user.type(within(dialog).getByRole('searchbox', { name: 'Find a setting' }), 'blocked sites');
    expect(await within(dialog).findByRole('group', { name: 'Blocked sites' })).toBeInTheDocument();
  });
});
