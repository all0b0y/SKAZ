import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';

// N7 · «Search & sources» from the message field: per chat, starting from Settings → Search.

type Call = { method: string; path: string; body?: unknown };
const rulesCalls = (calls: Call[]) => calls.filter((c) => c.path.includes('/search-rules')).map((c) => [c.method, c.path, c.body ?? null]);

async function openChat() {
  const user = userEvent.setup();
  const world = chatWorld();
  world.searchSettings = { never: ['pinterest.com', 'quora.com'], only_on: false, only: [], prefer: ['arxiv.org'] };
  const view = renderKb({ world });
  await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Compare regularisation/ }));
  const composer = await screen.findByTestId('composer');
  return { user, composer, ...view };
}

describe('Search & sources panel in the message field (N7)', () => {
  it('starts from Settings; Never sites from Settings can’t be removed; Save keeps the chat’s changes', async () => {
    const { user, composer, fake } = await openChat();
    const button = await within(composer).findByRole('button', { name: 'Search rules for this chat' });
    expect(button).not.toHaveClass('is-active');
    await user.click(button);
    const panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    expect(within(panel).queryByText('changed')).toBeNull();
    const never = within(panel).getByRole('list', { name: 'Never search' });
    expect(within(never).getByText('pinterest.com')).toBeInTheDocument();
    expect(within(never).queryByRole('button', { name: 'Remove pinterest.com' })).toBeNull();
    expect(within(within(panel).getByRole('list', { name: 'Prefer' })).getByText('arxiv.org')).toBeInTheDocument();

    // Only these sites for this chat, plus its own blocked site.
    await user.click(within(panel).getByRole('switch', { name: 'Web · only these sites' }));
    const only = within(panel).getByRole('region', { name: 'Web · only these sites' });
    await user.click(within(only).getByRole('button', { name: 'Add site' }));
    await user.type(within(only).getByRole('textbox', { name: 'Add to only these sites' }), 'semanticscholar.org{Enter}');
    const neverGroup = within(panel).getByRole('region', { name: 'Never search' });
    await user.click(within(neverGroup).getByRole('button', { name: 'Add site' }));
    await user.type(within(neverGroup).getByRole('textbox', { name: 'Add to never search' }), 'habr.com{Enter}');
    expect(within(panel).getByText('changed')).toBeInTheDocument();

    // Library: only one material.
    await user.click(within(panel).getByRole('radio', { name: 'Only these' }));
    await user.click(within(panel).getByRole('button', { name: 'Add material' }));
    await user.type(within(panel).getByRole('textbox', { name: 'Find a material or wiki page' }), 'Lecture 8');
    await user.click(await within(panel).findByRole('button', { name: /^Lecture 8 — entropy$/ }));
    expect(within(within(panel).getByRole('list', { name: 'Only these sources' })).getByText('Lecture 8 — entropy')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(composer).queryByRole('dialog')).toBeNull());
    const put = rulesCalls(fake.calls).find(([m]) => m === 'PUT');
    expect(put).toEqual(['PUT', '/kb/chats/c3/search-rules', {
      web: { never: ['habr.com'], only_on: true, only: ['semanticscholar.org'], prefer: ['arxiv.org'] },
      sources_only: true, sources: ['m1'], excluded: [], as_global: false,
    }]);
    // The button says the chat differs from Settings.
    expect(await within(composer).findByRole('button', { name: 'Search rules for this chat: Only these · 2' })).toHaveTextContent('Only these · 2');
  });

  it('Save as global writes the web lists into Settings; Reset to Settings clears the chat', async () => {
    const { user, composer, fake } = await openChat();
    await user.click(await within(composer).findByRole('button', { name: 'Search rules for this chat' }));
    let panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    const prefer = within(panel).getByRole('region', { name: 'Prefer' });
    await user.click(within(prefer).getByRole('button', { name: 'Add site' }));
    await user.type(within(prefer).getByRole('textbox', { name: 'Add to prefer' }), 'aclanthology.org{Enter}');
    await user.click(within(panel).getByRole('button', { name: 'Save as global' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PUT', path: '/kb/chats/c3/search-rules',
      body: expect.objectContaining({ as_global: true, web: expect.objectContaining({ prefer: ['arxiv.org', 'aclanthology.org'] }) }),
    })));
    await waitFor(() => expect(within(composer).queryByRole('dialog')).toBeNull());
    // Settings now hold the list; the chat follows Settings (no label).
    expect(within(composer).getByRole('button', { name: 'Search rules for this chat' })).toBeInTheDocument();

    await user.click(within(composer).getByRole('button', { name: 'Search rules for this chat' }));
    panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    expect(within(within(panel).getByRole('list', { name: 'Prefer' })).getByText('aclanthology.org')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Reset to Settings' }));
    await waitFor(() => expect(rulesCalls(fake.calls).some(([m]) => m === 'DELETE')).toBe(true));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(within(composer).queryByRole('dialog')).toBeNull());
  });
});
