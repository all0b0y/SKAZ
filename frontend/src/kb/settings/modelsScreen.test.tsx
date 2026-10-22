import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';

// Models screen v2 (confirmed 2026-10-20): grouped by purpose; the wiki model and the recognition
// check are one picker button like the message field's; each agent remembers its last model and
// reasoning, in the wiki and in the message field.

async function openModels() {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Models/ }));
  return dialog;
}
const row = (dialog: HTMLElement, name: string) => within(dialog).getByRole('group', { name });

describe('Models screen v2', () => {
  it('groups rows by purpose: Chats, Wiki, Recordings', async () => {
    renderKb({ world: chatWorld() });
    const dialog = await openModels();
    const region = dialog.querySelector('.kb-settings__content') as HTMLElement;
    expect(Array.from(region.querySelectorAll('.kb-sgroup__title')).map((h) => h.textContent)).toEqual(['Chats', 'Wiki', 'Recordings']);
    const rows = Array.from(region.querySelectorAll('.kb-srow')).map((r) => r.getAttribute('data-row'));
    expect(rows).toEqual(['default-agent', 'chat-model', 'picker-models', 'wiki-model', 'wiki-budget', 'decisions', 'recognition-check']);
    expect(row(dialog, 'Wiki model')).toBeInTheDocument();
    expect(row(dialog, 'Chat model')).toBeInTheDocument();
  });

  it('like the mock-up: Models in the picker is one Edit models… button on the label line, no count', async () => {
    renderKb({ world: chatWorld() });
    const dialog = await openModels();
    const picker = row(dialog, 'Models in the picker');
    const control = picker.querySelector('.kb-srow__control') as HTMLElement;
    expect(within(control).getByRole('button', { name: 'Edit models…' })).toBeInTheDocument();
    expect(control.textContent).toBe('Edit models…');
    expect(picker).not.toHaveTextContent(/ shown/);
  });

  it('like the mock-up: agent marks in Default agent; Chat model on one line with its mark', async () => {
    renderKb({ world: chatWorld() });
    const dialog = await openModels();
    const def = row(dialog, 'Default agent');
    for (const engine of ['codex', 'claude_code', 'hermes']) {
      expect(def.querySelector(`[role="radio"] [data-engine="${engine}"]`)).not.toBeNull();
    }
    const chat = row(dialog, 'Chat model');
    expect(chat.querySelector('.kb-srow__control [data-engine="claude_code"]')).not.toBeNull();
    expect(within(chat).getByText('Opus 5.5 · Medium')).toBeInTheDocument();
  });

  it('wiki model: one picker; another agent shows its last choice and gets it back with its reasoning', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.wiki = { ...world.wiki, wiki_engine: 'codex', wiki_model: 'gpt-5.6-luna-mini', wiki_effort: 'high',
      wiki_remembered: { codex: { model: 'gpt-5.6-luna-mini', effort: 'high' }, claude_code: { model: 'claude-sonnet-5-5', effort: 'low' } } };
    const { fake } = renderKb({ world });
    const dialog = await openModels();
    const wiki = row(dialog, 'Wiki model');
    const button = await within(wiki).findByRole('button', { name: 'Wiki model: Codex, GPT-5.6-luna-mini, High' });
    await user.click(button);
    const menu = await screen.findByRole('menu', { name: 'Wiki model' });
    const claude = within(menu).getByRole('group', { name: 'Claude Code' });
    expect(claude).toHaveTextContent('last: Sonnet 5.5');
    // Reasoning lives at the bottom of the same menu, for the chosen model.
    await user.click(within(menu).getByRole('radio', { name: 'Medium' }));
    await waitFor(() => expect(fake.world.wiki.wiki_effort).toBe('medium'));
    await user.click(within(claude).getByRole('menuitemradio', { name: 'Sonnet 5.5' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PUT', path: '/kb/settings/wiki', body: { wiki_engine: 'claude_code', wiki_model: 'claude-sonnet-5-5', wiki_effort: 'low' },
    })));
    expect(await within(wiki).findByRole('button', { name: 'Wiki model: Claude Code, Sonnet 5.5, Low' })).toBeInTheDocument();
    expect(fake.calls.filter((c) => c.path === '/kb/agents/default')).toHaveLength(0);
  });

  it('a remembered model the agent no longer lists: a warning under the label, nothing replaced', async () => {
    const world = chatWorld();
    world.wiki = { ...world.wiki, wiki_engine: 'codex', wiki_model: 'gpt-gone', wiki_effort: null,
      wiki_remembered: { codex: { model: 'gpt-gone', effort: null } } };
    renderKb({ world });
    const dialog = await openModels();
    const wiki = row(dialog, 'Wiki model');
    const text = wiki.querySelector('.kb-srow__text') as HTMLElement;
    expect(await within(text).findByRole('alert')).toHaveTextContent('gpt-gone is no longer in Codex’s list. Wiki jobs wait until you choose another');
    expect(world.wiki.wiki_model).toBe('gpt-gone');
  });

  it('recognition check: the same picker with “Same as wiki model” and “Off” on top', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const dialog = await openModels();
    const rec = row(dialog, 'Recognition check');
    await user.click(await within(rec).findByRole('button', { name: /^Recognition check: Same as wiki model/ }));
    const menu = await screen.findByRole('menu', { name: 'Recognition check' });
    const top = within(menu).getAllByRole('menuitemradio').slice(0, 2).map((i) => i.textContent);
    expect(top).toEqual(['Same as wiki model', 'Off']);
    await user.click(within(within(menu).getByRole('group', { name: 'Codex' })).getByRole('menuitemradio', { name: 'GPT-5.6-luna-mini' }));
    await waitFor(() => expect(fake.world.recognition).toEqual({ engine: 'codex', model: 'gpt-5.6-luna-mini', effort: 'medium' }));
    await user.click(await within(rec).findByRole('button', { name: /^Recognition check: Codex, GPT-5.6-luna-mini/ }));
    await user.click(within(await screen.findByRole('menu', { name: 'Recognition check' })).getByRole('menuitemradio', { name: 'Off' }));
    await waitFor(() => expect(fake.world.recognition).toEqual({ engine: 'off', model: null, effort: null }));
    expect(within(rec).getByText('Recordings go to the wiki as recognised.')).toBeInTheDocument();
  });
});

describe('Message field remembers each agent’s last model and reasoning', () => {
  it('a new chat starts from the default agent’s last choice; picking one in New chat is remembered', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    const claude = world.agents.agents.find((a) => a.id === 'claude_code')!;
    claude.last_choice = { model: 'claude-sonnet-5-5', effort: 'high' };
    const { fake } = renderKb({ world });
    const picker = await screen.findByTestId('agent-picker');
    expect(picker).toHaveAccessibleName('Agent and model: Claude Code, Sonnet 5.5');
    expect(screen.getByRole('button', { name: 'Effort: High' })).toBeInTheDocument();
    await user.click(picker);
    const menu = await screen.findByRole('menu', { name: 'Agent and model' });
    await user.click(within(within(menu).getByRole('group', { name: 'Codex' })).getByRole('menuitemradio', { name: 'GPT-5.6-luna-mini' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PUT', path: '/kb/chats/last-choice', body: { engine: 'codex', model: 'gpt-5.6-luna-mini', effort: 'medium' },
    })));
    expect(fake.world.agents.agents.find((a) => a.id === 'codex')!.last_choice).toEqual({ model: 'gpt-5.6-luna-mini', effort: 'medium' });
  });

  it('switching to another agent in the message field brings back that agent’s reasoning', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.agents.agents.find((a) => a.id === 'codex')!.last_choice = { model: 'gpt-5.6-luna', effort: 'low' };
    renderKb({ world });
    await user.click(await screen.findByTestId('agent-picker'));
    const menu = await screen.findByRole('menu', { name: 'Agent and model' });
    expect(within(menu).getByRole('group', { name: 'Codex' })).toHaveTextContent('last: GPT-5.6-luna');
    await user.click(within(within(menu).getByRole('group', { name: 'Codex' })).getByRole('menuitemradio', { name: 'GPT-5.6-luna' }));
    expect(await screen.findByRole('button', { name: 'Effort: Low' })).toBeInTheDocument();
  });
});
