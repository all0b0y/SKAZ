import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';

// N7 · «Search & sources» from the message field: per chat, starting from Settings → Search.

type Call = { method: string; path: string; body?: unknown };
const rulesCalls = (calls: Call[]) => calls.filter((c) => c.path.includes('/search-rules')).map((c) => [c.method, c.path, c.body ?? null]);

async function openChat() {
  const user = userEvent.setup();
  const world = chatWorld();
  world.searchSettings = { never: ['pinterest.com', 'quora.com'], only_on: false, only: [], prefer: ['arxiv.org'], beta: true };
  const view = renderKb({ world });
  await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Compare regularisation/ }));
  const composer = await screen.findByTestId('composer');
  return { user, composer, ...view };
}

describe('Search & sources panel in the message field (N7)', () => {
  it('includes the site still being typed when Save is clicked without Enter', async () => {
    const { user, composer, fake } = await openChat();
    const button = () => within(composer).getByRole('button', { name: /^Search rules for this chat/ });
    await user.click(button());
    const panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    await user.click(within(panel).getByRole('switch', { name: 'Web · only these sites' }));
    const only = within(panel).getByRole('region', { name: 'Web · only these sites' });
    await user.click(within(only).getByRole('button', { name: 'Add site' }));
    await user.type(within(only).getByRole('textbox', { name: 'Add to only these sites' }), 'https://www.Example.org/evidence');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PUT', path: '/kb/chats/c3/search-rules',
      body: expect.objectContaining({ web: expect.objectContaining({ only_on: true, only: ['example.org'] }) }),
    })));
    await user.click(button());
    const reopened = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    expect(within(within(reopened).getByRole('list', { name: 'Only these sites' })).getByText('example.org')).toBeInTheDocument();
    expect(fake.calls.some((c) => c.method === 'POST' && c.path.endsWith('/messages'))).toBe(false);
  });

  it.each(['Save', 'Save as global'])('keeps an invalid pending site visible instead of discarding it on %s', async (save) => {
    const { user, composer, fake } = await openChat();
    await user.click(within(composer).getByRole('button', { name: /^Search rules for this chat/ }));
    const panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    const only = within(panel).getByRole('region', { name: 'Web · only these sites' });
    await user.click(within(only).getByRole('button', { name: 'Add site' }));
    await user.type(within(only).getByRole('textbox', { name: 'Add to only these sites' }), 'not a site');
    await user.click(within(panel).getByRole('button', { name: save }));
    expect(panel).toBeInTheDocument();
    expect(within(only).getByRole('alert')).toHaveTextContent('Write it like example.com.');
    expect(within(only).getByRole('textbox')).toHaveValue('not a site');
    expect(fake.calls.some((c) => c.method === 'PUT' && c.path.includes('/search'))).toBe(false);
  });

  it('configures a new chat before it exists and sends its rules with the first question', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.hold = true;
    world.searchSettings = { never: [], only_on: false, only: [], prefer: [], beta: true };
    const { fake } = renderKb({ world });
    const composer = await screen.findByTestId('composer');
    await user.click(await within(composer).findByRole('button', { name: 'Search rules for this chat' }));
    const panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    await user.click(within(panel).getByRole('radio', { name: 'Only these' }));
    await user.click(within(panel).getByRole('button', { name: 'Add material' }));
    await user.type(within(panel).getByRole('textbox', { name: 'Find a material or wiki page' }), 'Lecture 8');
    await user.click(await within(panel).findByRole('button', { name: /^Lecture 8 — entropy$/ }));
    await user.click(within(panel).getByRole('switch', { name: 'Web · only these sites' }));
    const only = within(panel).getByRole('region', { name: 'Web · only these sites' });
    await user.click(within(only).getByRole('button', { name: 'Add site' }));
    await user.type(within(only).getByRole('textbox', { name: 'Add to only these sites' }), 'example.org{Enter}');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(composer).queryByRole('dialog')).toBeNull());
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/kb/chats')).toHaveLength(0);
    await user.type(within(composer).getByRole('textbox', { name: 'Message' }), 'Read my chosen material{Enter}');
    await waitFor(() => expect(fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages'))).toHaveLength(1));
    const created = fake.calls.find((c) => c.method === 'POST' && c.path === '/kb/chats')!;
    expect(created.body).toEqual(expect.objectContaining({ search_rules: {
      web: { never: [], only_on: true, only: ['example.org'], prefer: [] },
      sources_only: true, sources: ['m1'], excluded: [], as_global: false,
    } }));
    expect(await within(composer).findByRole('button', { name: 'Search rules for this chat: Only these · 2' })).toBeInTheDocument();
    await user.click(within(composer).getByRole('button', { name: 'Search rules for this chat: Only these · 2' }));
    const saved = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    expect(within(within(saved).getByRole('list', { name: 'Only these sources' })).getByText('Lecture 8 — entropy')).toBeInTheDocument();
    expect(within(within(saved).getByRole('list', { name: 'Only these sites' })).getByText('example.org')).toBeInTheDocument();
  });

  it('discards unsaved New chat choices and resets saved draft choices without creating a chat', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const composer = await screen.findByTestId('composer');
    const button = () => within(composer).getByRole('button', { name: /^Search rules for this chat/ });
    await user.click(button());
    let panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    await user.click(within(panel).getByRole('radio', { name: 'Only these' }));
    await user.keyboard('{Escape}');
    await user.click(button());
    panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    expect(within(panel).getByRole('radio', { name: 'All sources' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(panel).getByRole('radio', { name: 'Only these' }));
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await user.click(button());
    panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    expect(within(panel).getByRole('radio', { name: 'Only these' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(panel).getByRole('button', { name: 'Reset to Settings' }));
    await waitFor(() => expect(within(panel).getByRole('radio', { name: 'All sources' })).toHaveAttribute('aria-checked', 'true'));
    await user.keyboard('{Escape}');
    expect(button()).toHaveAccessibleName('Search rules for this chat');
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/chats')).toBe(false);
    expect(fake.calls.some((c) => c.method === 'PUT' && c.path === '/kb/settings/search')).toBe(false);
  });

  it('closes on an outside pointer down, but not on clicks inside or on its globe button', async () => {
    const { user, composer } = await openChat();
    const button = () => within(composer).getByRole('button', { name: /^Search rules for this chat/ });
    await user.click(button());
    const panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    await user.click(panel);
    expect(panel).toBeInTheDocument();
    await user.click(button());
    expect(within(composer).queryByRole('dialog', { name: 'Search and sources for this chat' })).toBeNull();

    await user.click(button());
    await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    await user.click(within(composer).getByRole('textbox', { name: 'Message' }));
    await waitFor(() => expect(within(composer).queryByRole('dialog', { name: 'Search and sources for this chat' })).toBeNull());
  });

  it('retains draft rules after a refused create and retries them only on the next send', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.hold = true;
    const { fake, services } = renderKb({ world });
    const request = fake.requestMock.getMockImplementation()!;
    let refuse = true;
    fake.requestMock.mockImplementation(async (req) => {
      if (refuse && req.method === 'POST' && req.path === '/kb/chats') {
        refuse = false;
        fake.calls.push(req);
        return { ok: false, status: 503, detail: 'Controlled creation failure' };
      }
      return request(req);
    });
    const composer = await screen.findByTestId('composer');
    await user.click(await within(composer).findByRole('button', { name: 'Search rules for this chat' }));
    const panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    await user.click(within(panel).getByRole('radio', { name: 'Only these' }));
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    const draft = services.chats.getState().draftSearchRules;
    const message = within(composer).getByRole('textbox', { name: 'Message' });
    await user.type(message, 'A controlled retry{Enter}');
    await screen.findAllByText('Controlled creation failure');
    expect(services.chats.getState().currentId).toBeNull();
    expect(services.chats.getState().draftSearchRules).toBe(draft);
    expect(fake.calls.some((c) => c.path.endsWith('/messages') && c.method === 'POST')).toBe(false);
    await user.type(message, '{Enter}');
    await waitFor(() => expect(fake.calls.filter((c) => c.path.endsWith('/messages') && c.method === 'POST')).toHaveLength(1));
    const creates = fake.calls.filter((c) => c.method === 'POST' && c.path === '/kb/chats');
    expect(creates).toHaveLength(2);
    expect(creates[1]!.body).toEqual(creates[0]!.body);
    expect(services.chats.getState().draftSearchRules).toBeNull();
    expect(await within(composer).findByRole('button', { name: 'Search rules for this chat: Only these · 0' })).toBeInTheDocument();
  });

  it('a Save that leaves the web lists alone sends no web lists: the chat keeps following Settings (Q1 n78 M-8)', async () => {
    const { user, composer, fake } = await openChat();
    await user.click(await within(composer).findByRole('button', { name: 'Search rules for this chat' }));
    const panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    await user.click(within(panel).getByRole('radio', { name: 'Only these' }));
    await user.click(within(panel).getByRole('button', { name: 'Add material' }));
    await user.type(within(panel).getByRole('textbox', { name: 'Find a material or wiki page' }), 'Lecture 8');
    await user.click(await within(panel).findByRole('button', { name: /^Lecture 8 — entropy$/ }));
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(composer).queryByRole('dialog')).toBeNull());
    const put = rulesCalls(fake.calls).find(([m]) => m === 'PUT');
    expect(put?.[2]).toEqual({ web: null, sources_only: true, sources: ['m1'], excluded: [], as_global: false });
  });

  it('a change in Settings → Search reloads the chat’s rules (no stale lists pinned on the chat)', async () => {
    const { fake } = await openChat();
    const { searchSettingsChanged } = await import('./sites');
    const gets = () => rulesCalls(fake.calls).filter(([m]) => m === 'GET').length;
    await waitFor(() => expect(gets()).toBeGreaterThan(0));
    const before = gets();
    searchSettingsChanged();
    await waitFor(() => expect(rulesCalls(fake.calls).filter(([m]) => m === 'GET').length).toBeGreaterThan(before));
  });

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

  it('Beta off shows only Library and Never, hides inactive labels and preserves hidden chat values on Save', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.searchSettings = { never: ['pinterest.com'], only_on: true, only: ['arxiv.org'], prefer: ['acm.org'], beta: false };
    world.chatSearchRules = {
      c3: {
        web: { never: ['habr.com'], only_on: true, only: ['semanticscholar.org'], prefer: ['ieee.org'] },
        sources_only: false, sources: [], excluded: [], everywhere_once: false,
      },
    };
    const { fake } = renderKb({ world });
    await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Compare regularisation/ }));
    const composer = await screen.findByTestId('composer');
    const button = await within(composer).findByRole('button', { name: 'Search rules for this chat: Changed' });
    await user.click(button);
    const panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    expect(within(panel).getByRole('region', { name: 'Library' })).toBeInTheDocument();
    expect(within(panel).getByRole('region', { name: 'Never search' })).toBeInTheDocument();
    expect(within(panel).queryByRole('region', { name: 'Web · only these sites' })).toBeNull();
    expect(within(panel).queryByRole('region', { name: 'Prefer' })).toBeNull();

    const never = within(panel).getByRole('region', { name: 'Never search' });
    await user.click(within(never).getByRole('button', { name: 'Add site' }));
    await user.type(within(never).getByRole('textbox', { name: 'Add to never search' }), 'quora.com{Enter}');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(composer).queryByRole('dialog')).toBeNull());
    const put = rulesCalls(fake.calls).find(([method]) => method === 'PUT');
    expect(put?.[2]).toEqual(expect.objectContaining({ web: {
      never: ['habr.com', 'quora.com'], only_on: true, only: ['semanticscholar.org'], prefer: ['ieee.org'],
    } }));
    expect(within(composer).getByRole('button', { name: 'Search rules for this chat: Changed' })).toBeInTheDocument();
  });

  it('keeps unsaved Only and Prefer edits in an open new-chat panel across Beta toggles', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.searchSettings = { never: [], only_on: false, only: [], prefer: [], beta: true };
    renderKb({ world });
    const composer = await screen.findByTestId('composer');
    await user.click(await within(composer).findByRole('button', { name: 'Search rules for this chat' }));
    let panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    const prefer = within(panel).getByRole('region', { name: 'Prefer' });
    await user.click(within(prefer).getByRole('button', { name: 'Add site' }));
    await user.type(within(prefer).getByRole('textbox', { name: 'Add to prefer' }), 'acm.org{Enter}');

    const beta = async (on: boolean) => {
      fireEvent.keyDown(window, { key: ',', metaKey: true });
      const settings = await screen.findByRole('dialog', { name: 'Settings' });
      await user.click(within(settings).getByRole('button', { name: 'Search' }));
      const toggle = await within(settings).findByRole('switch', { name: 'Beta search features' });
      await user.click(toggle);
      await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', String(on)));
      await user.click(within(settings).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    };

    await beta(false);
    panel = within(composer).getByRole('dialog', { name: 'Search and sources for this chat' });
    expect(within(panel).queryByRole('region', { name: 'Prefer' })).toBeNull();
    expect(within(panel).queryByRole('region', { name: 'Web · only these sites' })).toBeNull();
    await beta(true);
    panel = within(composer).getByRole('dialog', { name: 'Search and sources for this chat' });
    expect(within(within(panel).getByRole('list', { name: 'Prefer' })).getByText('acm.org')).toBeInTheDocument();
  });

  it('new-chat Save as global and Reset at Beta off preserve both hidden scopes', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.searchSettings = { never: ['pinterest.com'], only_on: true, only: ['arxiv.org'], prefer: ['acm.org'], beta: true };
    const { fake, services } = renderKb({ world });
    const composer = await screen.findByTestId('composer');
    await user.click(await within(composer).findByRole('button', { name: 'Search rules for this chat' }));
    let panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    const only = within(panel).getByRole('region', { name: 'Web · only these sites' });
    expect(within(only).getByRole('switch', { name: 'Web · only these sites' })).toBeChecked();
    await user.click(within(only).getByRole('button', { name: 'Add site' }));
    await user.type(within(only).getByRole('textbox', { name: 'Add to only these sites' }), 'semanticscholar.org{Enter}');
    const prefer = within(panel).getByRole('region', { name: 'Prefer' });
    await user.click(within(prefer).getByRole('button', { name: 'Add site' }));
    await user.type(within(prefer).getByRole('textbox', { name: 'Add to prefer' }), 'ieee.org{Enter}');
    const never = within(panel).getByRole('region', { name: 'Never search' });
    await user.click(within(never).getByRole('button', { name: 'Add site' }));
    await user.type(within(never).getByRole('textbox', { name: 'Add to never search' }), 'habr.com{Enter}');
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(composer).queryByRole('dialog')).toBeNull());

    fireEvent.keyDown(window, { key: ',', metaKey: true });
    const settings = await screen.findByRole('dialog', { name: 'Settings' });
    await user.click(within(settings).getByRole('button', { name: 'Search' }));
    const beta = await within(settings).findByRole('switch', { name: 'Beta search features' });
    await user.click(beta);
    await waitFor(() => expect(beta).not.toBeChecked());
    await user.click(within(settings).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    await user.click(within(composer).getByRole('button', { name: 'Search rules for this chat: Changed' }));
    panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    const blocked = within(panel).getByRole('region', { name: 'Never search' });
    await user.click(within(blocked).getByRole('button', { name: 'Add site' }));
    await user.type(within(blocked).getByRole('textbox', { name: 'Add to never search' }), 'quora.com{Enter}');
    await user.click(within(panel).getByRole('button', { name: 'Save as global' }));
    await waitFor(() => expect(within(composer).queryByRole('dialog')).toBeNull());

    expect(await services.client.call('GET /kb/settings/search')).toEqual({
      never: ['pinterest.com', 'habr.com', 'quora.com'], only_on: true, only: ['arxiv.org'], prefer: ['acm.org'], beta: false,
    });
    expect(services.chats.getState().draftSearchRules?.web).toEqual({
      never: [], only_on: true, only: ['arxiv.org', 'semanticscholar.org'], prefer: ['acm.org', 'ieee.org'],
    });
    const settingsPut = [...fake.calls].reverse().find((c) => c.method === 'PUT' && c.path === '/kb/settings/search');
    expect(settingsPut?.body).toEqual(expect.objectContaining({ only: ['arxiv.org'], prefer: ['acm.org'] }));

    await user.click(within(composer).getByRole('button', { name: 'Search rules for this chat' }));
    panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    await user.click(within(panel).getByRole('button', { name: 'Reset to Settings' }));
    await waitFor(() => expect(services.chats.getState().draftSearchRules?.web?.never).toEqual([]));
    expect(services.chats.getState().draftSearchRules?.web).toEqual({
      never: [], only_on: true, only: ['arxiv.org', 'semanticscholar.org'], prefer: ['acm.org', 'ieee.org'],
    });
  });

  it('keeps Only these sources mounted (dimmed in All sources) and switches to Only these when picking a material', async () => {
    const { user, composer } = await openChat();
    await user.click(await within(composer).findByRole('button', { name: 'Search rules for this chat' }));
    const panel = await within(composer).findByRole('dialog', { name: 'Search and sources for this chat' });
    const library = within(panel).getByRole('region', { name: 'Library' });
    const list = within(library).getByRole('list', { name: 'Only these sources' });
    expect(list).toHaveClass('is-dim');
    expect(library.querySelector('.kb-spanel__note--slot')).toHaveTextContent(
      'Exclude a material from the chat overview, or pick «Only these».',
    );

    // Picking a material directly from All sources switches to Only these and undims the list.
    await user.click(within(list).getByRole('button', { name: 'Add material' }));
    await user.type(within(list).getByRole('textbox', { name: 'Find a material or wiki page' }), 'Lecture 8');
    await user.click(await within(list).findByRole('button', { name: /^Lecture 8 — entropy$/ }));
    expect(within(library).getByRole('radio', { name: 'Only these' })).toHaveAttribute('aria-checked', 'true');
    expect(list).not.toHaveClass('is-dim');
    expect(within(list).getByText('Lecture 8 — entropy')).toBeInTheDocument();
    expect(library.querySelector('.kb-spanel__note--slot')).toHaveTextContent(
      'The agent gets only these from your library. Statements without one of them are counted under the answer.',
    );

    // Switching back to All sources dims the list without unmounting it or dropping the chosen material.
    await user.click(within(library).getByRole('radio', { name: 'All sources' }));
    expect(list).toHaveClass('is-dim');
    expect(within(list).getByText('Lecture 8 — entropy')).toBeInTheDocument();
  });
});
