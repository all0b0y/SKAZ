import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';

// Settings → Accounts & keys → Hermes providers (0.3.1 K1/K3, decisions Q2/Q3/Q13): numbered in
// Hermes' order, states per credential, Terminal for anything with a secret, a confirmed remove.

const openSettings = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  return screen.findByRole('dialog', { name: 'Settings' });
};

function hermesReady() {
  const world = chatWorld();
  const hermes = world.agents.agents.find((a) => a.id === 'hermes')!;
  Object.assign(hermes, { state: 'ready', installed: true, signed_in: true, version: '0.22.2', reason: null, action: null,
    first_run: { checked: true, note: '' } });
  return world;
}

describe('Settings → Accounts & keys → Hermes providers', () => {
  it('lists providers in the order Hermes tries them, each credential with its state', async () => {
    renderKb({ world: hermesReady() });
    const dialog = await openSettings();
    const block = await within(dialog).findByTestId('hermes-providers');
    const providers = await within(block).findAllByRole('listitem', { name: undefined });
    const pools = providers.filter((li) => li.classList.contains('kb-hprovider'));
    expect(pools.map((li) => li.getAttribute('data-provider'))).toEqual(['openai-codex', 'anthropic', 'nous']);
    expect(pools[0]).toHaveTextContent('Main');
    expect(within(pools[0]!).getByText(/Limit until/)).toBeInTheDocument();
    expect(within(pools[0]!).getByText('Ready')).toBeInTheDocument();
    expect(within(pools[1]!).getByText('Signed out')).toBeInTheDocument();
    expect(within(pools[1]!).getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    expect(pools[2]).toHaveTextContent('Free tier · Hermes-4-70B');
    // No key field anywhere: keys go to Hermes in Terminal.
    expect(within(block).queryByLabelText(/key/i, { selector: 'input' })).not.toBeInTheDocument();
  });

  it('Add provider… searches Hermes’ providers by group and opens Hermes in Terminal for the pick', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: hermesReady() });
    const dialog = await openSettings();
    const block = await within(dialog).findByTestId('hermes-providers');
    await user.click(within(block).getByRole('button', { name: 'Add provider…' }));
    const add = await screen.findByRole('dialog', { name: 'Add a provider to Hermes' });
    expect(within(add).getByRole('region', { name: 'Subscriptions · sign in in the browser' })).toBeInTheDocument();
    expect(within(add).getByRole('region', { name: 'API keys' })).toBeInTheDocument();
    expect(within(add).getByRole('region', { name: 'Cloud platforms · set up in Hermes' })).toBeInTheDocument();
    await user.type(within(add).getByRole('searchbox', { name: 'Find a provider' }), 'claude');
    const items = within(add).getAllByRole('button').filter((b) => b.classList.contains('kb-addprovider__item'));
    expect(items.map((b) => `${b.getAttribute('data-provider')}/${b.getAttribute('data-group')}`))
      .toEqual(['anthropic/subscription', 'anthropic/api_key']);
    await user.click(items[1]!);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/kb/agents/hermes/providers/add', body: { provider: 'anthropic', group: 'api_key' } })));
    expect(await within(block).findByText(/Paste the Anthropic API key there — SKAZ never sees it/)).toBeInTheDocument();
    expect(within(block).getByText('Finish in Terminal.').closest('[role="status"]')).toHaveTextContent('SKAZ opened Hermes to add Anthropic API.');
  });

  it('moves a credential, signs in again through Terminal and removes only after a confirmation', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: hermesReady() });
    const dialog = await openSettings();
    const block = await within(dialog).findByTestId('hermes-providers');
    await user.click(await within(block).findByRole('button', { name: 'More for second account' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/kb/agents/hermes/providers/openai-codex/credentials/c0dex2/priority', body: { priority: 0 } })));
    await waitFor(() => {
      const rows = block.querySelectorAll('[data-provider="openai-codex"] .kb-hcred');
      expect(rows[0]).toHaveAttribute('data-credential', 'c0dex2');
    });

    await user.click(within(block).getByRole('button', { name: 'Sign in again' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/kb/agents/hermes/providers/anthropic/credentials/a1b2c3/sign-in' })));

    await user.click(within(block).getByRole('button', { name: 'More for work key' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove this credential from Hermes?' });
    expect(confirm).toHaveTextContent('only credential');
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'DELETE', path: '/kb/agents/hermes/providers/anthropic/credentials/a1b2c3' })));
    await waitFor(() => expect(block.querySelector('[data-provider="anthropic"]')).toBeNull());
  });

  it('says why when Hermes can’t list its providers, and is absent while Hermes isn’t installed', async () => {
    const world = hermesReady();
    world.hermesProviders = { ...world.hermesProviders, state: 'unavailable', reason: 'Hermes didn’t list its providers.', providers: [] };
    renderKb({ world });
    const dialog = await openSettings();
    const block = await within(dialog).findByTestId('hermes-providers');
    expect(await within(block).findByRole('alert')).toHaveTextContent('Hermes didn’t list its providers.');
    expect(within(block).getByRole('button', { name: 'Add provider…' })).toBeDisabled();
  });

  it('is not shown while Hermes is not installed (the agent row says what to do)', async () => {
    renderKb({ world: chatWorld() });
    const dialog = await openSettings();
    await within(dialog).findByRole('group', { name: 'Hermes Agent' });
    expect(within(dialog).queryByTestId('hermes-providers')).not.toBeInTheDocument();
  });
});
