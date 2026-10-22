import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbAgent } from '../../api/kb/types.gen';
import { renderKb } from '../test/renderKb';
import { chatWorld, providersOf } from '../test/fixtures';

// The model picker and "Edit models…" (0.3.1 K2/K4, decisions Q10/Q15): Favorites on top, agents →
// provider sections → models with human names, hidden ones behind "+ N hidden" and in search.

type Model = KbAgent['models'][number];
const model = (id: string, provider: string, providerLabel: string, name: string, extra: Partial<Model> = {}): Model => ({
  id, label: `${providerLabel} · ${id}`, efforts: [], default_effort: null, provider, provider_label: providerLabel, name, tag: null,
  visible: true, default_visible: true, favorite: false, ...extra,
});

function world() {
  const w = chatWorld();
  const hermes = w.agents.agents.find((a) => a.id === 'hermes')!;
  const models = [
    model('openai-codex:gpt-6.1-sol', 'openai-codex', 'ChatGPT or Codex subscription', 'GPT-6.1-sol'),
    model('openai-codex:gpt-6.1-sol-fast', 'openai-codex', 'ChatGPT or Codex subscription', 'GPT-6.1-sol', { tag: 'Fast' }),
    model('openrouter:deepseek-v4', 'openrouter', 'OpenRouter', 'DeepSeek V4'),
    model('openrouter:kimi-k3', 'openrouter', 'OpenRouter', 'Kimi K3', { visible: false, default_visible: false }),
  ];
  Object.assign(hermes, { state: 'ready', installed: true, signed_in: true, version: '0.22.2', reason: null, action: null, models,
    providers: providersOf(models) });
  w.agents.favorites = [{ engine: 'hermes', model: 'openrouter:deepseek-v4' }];
  hermes.models[2]!.favorite = true;
  return w;
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await within(screen.getByRole('region', { name: 'Chats' })).findByRole('button', { name: /Why is there a logarithm/ }));
  await user.click(await screen.findByTestId('agent-picker'));
  return screen.findByRole('menu', { name: 'Agent and model' });
}

describe('Model picker (K4)', () => {
  it('shows Favorites first, then each agent’s provider sections with human names; hidden models wait behind “+ N hidden”', async () => {
    const user = userEvent.setup();
    renderKb({ world: world() });
    const menu = await openPicker(user);
    const favorites = within(menu).getByRole('group', { name: 'Favorites' });
    expect(within(favorites).getByRole('menuitemradio', { name: 'DeepSeek V4' })).toBeInTheDocument();
    const hermes = within(menu).getByRole('group', { name: 'Hermes Agent' });
    const sections = Array.from(hermes.querySelectorAll('.kb-agentmenu__section')).map((s) => s.getAttribute('data-provider'));
    expect(sections).toEqual(['openai-codex', 'openrouter']);
    expect(within(hermes).getByRole('menuitem', { name: 'ChatGPT or Codex subscription' })).toBeInTheDocument();
    expect(within(hermes).getByRole('menuitemradio', { name: 'GPT-6.1-sol Fast' })).toBeInTheDocument();
    expect(within(hermes).queryByRole('menuitemradio', { name: /Kimi K3/ })).not.toBeInTheDocument();
    await user.click(within(hermes).getByRole('menuitem', { name: '+ 1 hidden' }));
    expect(within(hermes).getByRole('menuitemradio', { name: 'Kimi K3, hidden' })).toBeInTheDocument();
    // Codex and Claude Code are their own provider: no provider heading under them.
    const codex = within(menu).getByRole('group', { name: 'Codex' });
    expect(codex.querySelector('.kb-agentmenu__provider')).toBeNull();
  });

  it('search finds hidden models too (marked hidden) and a hidden one can still be chosen', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: world() });
    const menu = await openPicker(user);
    await user.type(within(menu).getByRole('searchbox', { name: 'Search models' }), 'kimi');
    const found = within(menu).getByRole('menuitemradio', { name: 'Kimi K3, hidden' });
    expect(within(menu).queryByRole('group', { name: 'Favorites' })).not.toBeInTheDocument();
    await user.click(found);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PATCH', path: '/kb/chats/c1', body: expect.objectContaining({ engine: 'hermes', model: 'openrouter:kimi-k3' }) })));
  });

  it('★ and ⇧Click star a model; the star is saved on the backend', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: world() });
    const menu = await openPicker(user);
    const codex = within(menu).getByRole('group', { name: 'Codex' });
    await user.click(within(codex).getByRole('button', { name: 'Add to favorites: GPT-5.6-luna (Codex)' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PATCH', path: '/kb/agents/models', body: { changes: [{ kind: 'favorite', engine: 'codex', model: 'gpt-5.6-luna', value: true }] } })));
    const favorites = within(menu).getByRole('group', { name: 'Favorites' });
    expect(within(favorites).getByRole('menuitemradio', { name: 'GPT-5.6-luna' })).toBeInTheDocument();
    // ⇧Click stars instead of choosing.
    const opus = within(within(menu).getByRole('group', { name: 'Claude Code' })).getByRole('menuitemradio', { name: 'Sonnet 5.5' });
    fireEvent.click(opus, { shiftKey: true });
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PATCH', path: '/kb/agents/models', body: { changes: [{ kind: 'favorite', engine: 'claude_code', model: 'claude-sonnet-5-5', value: true }] } })));
    expect(fake.calls.some((c) => c.method === 'PATCH' && c.path === '/kb/chats/c1')).toBe(false);
  });

  it('a hidden agent is left out of the picker unless it is the chat’s own', async () => {
    const user = userEvent.setup();
    const w = world();
    w.agents.agents.find((a) => a.id === 'codex')!.visible = false;
    renderKb({ world: w });
    const menu = await openPicker(user);
    expect(within(menu).queryByRole('group', { name: 'Codex' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('group', { name: 'Claude Code' })).toBeInTheDocument();
  });
});

describe('Edit models (K4)', () => {
  it('opens from the picker on the agent, toggles models, providers and agents, Show defaults / Hide all', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: world() });
    const menu = await openPicker(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Edit models…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit models' });
    const side = within(dialog).getByRole('navigation', { name: 'Agents and providers' });
    await user.click(within(within(side).getByRole('region', { name: 'Hermes Agent' })).getByRole('button', { name: /OpenRouter/ }));
    expect(within(dialog).getByRole('heading', { name: 'Hermes Agent · OpenRouter' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox', { name: /Kimi K3/ }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PATCH', path: '/kb/agents/models', body: { changes: [{ kind: 'model', engine: 'hermes', model: 'openrouter:kimi-k3', value: true }] } })));
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: /Kimi K3/ })).toBeChecked());
    await user.click(within(dialog).getByRole('button', { name: 'Hide all' }));
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: /DeepSeek V4/ })).not.toBeChecked());
    await user.click(within(dialog).getByRole('button', { name: 'Show defaults' }));
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: /DeepSeek V4/ })).toBeChecked());
    expect(within(dialog).getByRole('checkbox', { name: /Kimi K3/ })).not.toBeChecked();
    await user.click(within(side).getByRole('switch', { name: 'Show OpenRouter in the picker' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      body: { changes: [{ kind: 'provider', engine: 'hermes', provider: 'openrouter', value: false }] } })));
    // The default agent (Claude Code here) can't be hidden; another can.
    expect(within(side).getByRole('switch', { name: 'Show Claude Code in the picker' })).toBeDisabled();
    await user.click(within(side).getByRole('switch', { name: 'Show Codex in the picker' }));
    await waitFor(() => expect(fake.world.agents.agents.find((a) => a.id === 'codex')!.visible).toBe(false));
  });

  it('searches every model of every agent', async () => {
    const user = userEvent.setup();
    renderKb({ world: world() });
    const menu = await openPicker(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Edit models…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit models' });
    await user.type(within(dialog).getByRole('searchbox', { name: 'Find a model' }), 'sonnet');
    const rows = within(dialog).getAllByRole('checkbox');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closest('li')).toHaveTextContent('Claude Code');
  });

  it('opens from Settings → Models too', async () => {
    const user = userEvent.setup();
    renderKb({ world: world() });
    await screen.findByRole('navigation', { name: 'Sections' });
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    const settings = await screen.findByRole('dialog', { name: 'Settings' });
    await user.click(within(settings).getByRole('button', { name: /^Models$/ }));
    const row = within(settings).getByRole('group', { name: 'Models in the picker' });
    expect(row).not.toHaveTextContent(/ shown/); // models screen v2: just the button, no count
    await user.click(within(row).getByRole('button', { name: 'Edit models…' }));
    expect(await screen.findByRole('dialog', { name: 'Edit models' })).toBeInTheDocument();
  });
});
