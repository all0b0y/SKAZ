import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { accountsWorld, chatWorld } from '../test/fixtures';

// Settings → Accounts & keys → Hermes providers, v3 (confirmed 2026-10-21, accounts-v3.html):
// one line of chips without numbers (dot = status), a window per provider (order, checked, Check,
// Sign in again / Replace key, Remove with what Hermes uses instead), several named keys with
// "Use this key", and the whole catalogue behind "Add provider". Keys and sign-ins go to Hermes in
// Terminal, never through SKAZ.

const openAccounts = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Accounts & keys/ }));
  return { dialog, block: await within(dialog).findByTestId('hermes-providers') };
};

const chips = (block: HTMLElement) => within(within(block).getByRole('list', { name: 'Hermes providers' })).getAllByRole('listitem');

describe('Settings → Accounts & keys → Hermes providers (v3)', () => {
  it('shows the providers as chips in Hermes’ order, without numbers; the dot is the status; Add provider is last', async () => {
    const world = accountsWorld();
    world.hermesProviders.providers[0]!.credentials[0]!.state = 'signed_out';
    renderKb({ world });
    const { block } = await openAccounts();
    await within(block).findByRole('button', { name: /ChatGPT/ });
    const items = chips(block);
    expect(items.map((li) => li.textContent?.trim())).toEqual(['ChatGPT', 'OpenRouter', 'Add provider']);
    expect(within(block).getByRole('button', { name: 'ChatGPT · needs sign-in' }).querySelector('.kb-hchip__dot'))
      .toHaveAttribute('data-tone', 'err');
    expect(within(block).getByRole('button', { name: 'OpenRouter · some keys wait or fail' }).querySelector('.kb-hchip__dot'))
      .toHaveAttribute('data-tone', 'warn');
    expect(block).not.toHaveTextContent(/\b[12]\b/); // no numbers on the chips
    expect(within(block).queryByLabelText(/key/i, { selector: 'input' })).not.toBeInTheDocument();
  });

  it('a signed-out provider’s window: warning, order, Check, Sign in again… first, Remove asks inside saying what Hermes uses instead', async () => {
    const user = userEvent.setup();
    const world = accountsWorld();
    world.hermesProviders.providers[0]!.credentials[0]!.state = 'signed_out';
    const { fake } = renderKb({ world });
    const { block } = await openAccounts();
    await user.click(await within(block).findByRole('button', { name: /^ChatGPT/ }));
    const win = await screen.findByRole('dialog', { name: 'ChatGPT' });
    expect(win).toHaveTextContent('Hermes provider · tried 1st of 2');
    expect(within(win).getByRole('note')).toHaveTextContent('The sign-in has expired. Hermes skips ChatGPT and uses OpenRouter until you sign in again.');
    expect(within(win).getByText('you@example.com')).toBeInTheDocument();
    expect(within(win).getByText('Signed out')).toBeInTheDocument();
    expect(within(win).getByText('Tried 1st')).toBeInTheDocument();
    expect(within(win).getByText('Checked')).toBeInTheDocument();

    await user.click(within(win).getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(fake.calls.filter((c) => c.path === '/kb/agents/hermes/providers').length).toBeGreaterThan(1));

    const signIn = within(win).getByRole('button', { name: 'Sign in again…' });
    expect(signIn.className).toContain('kb-btn--fill');
    await user.click(signIn);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/kb/agents/hermes/providers/openai-codex/credentials/c0dex1/sign-in' })));
    expect(await within(win).findByText('Finish in Terminal.')).toBeInTheDocument();

    await user.click(within(win).getByRole('button', { name: 'Remove…' }));
    const confirm = within(win).getByRole('group', { name: 'Remove ChatGPT from Hermes?' });
    expect(confirm).toHaveTextContent('Hermes forgets this sign-in. Chats on Hermes then use OpenRouter (tried 2nd). Your ChatGPT account itself is not changed.');
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/kb/agents/hermes/providers/openai-codex' })));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ChatGPT' })).not.toBeInTheDocument());
    await waitFor(() => expect(within(block).queryByRole('button', { name: /^ChatGPT/ })).not.toBeInTheDocument());
  });

  it('Try it later opens Hermes’ provider order in Terminal', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: accountsWorld() });
    const { block } = await openAccounts();
    await user.click(await within(block).findByRole('button', { name: /^ChatGPT/ }));
    const win = await screen.findByRole('dialog', { name: 'ChatGPT' });
    await user.click(within(win).getByRole('button', { name: 'Try it later' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/hermes/providers/order' })));
  });

  it('several API keys: the one in use is marked; Use this key moves a key first; ⋯ has Replace key… and Remove; no Rename', async () => {
    const user = userEvent.setup();
    const world = accountsWorld();
    world.hermesProviders.providers[1]!.credentials[2]!.state = 'ready'; // Spare works again
    const { fake } = renderKb({ world });
    const { block } = await openAccounts();
    await user.click(await within(block).findByRole('button', { name: /^OpenRouter/ }));
    const win = await screen.findByRole('dialog', { name: 'OpenRouter' });
    expect(win).toHaveTextContent('Hermes provider · API keys');
    const group = within(win).getByRole('radiogroup', { name: 'Key in use' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(within(win).getByText(/Limit until/)).toBeInTheDocument();
    expect(within(win).getByText('In use')).toBeInTheDocument();
    expect(win).toHaveTextContent('Hermes uses the chosen key first. When it hits its limit or stops working, Hermes moves to the next ready key by itself and comes back later.');
    expect(within(win).queryByRole('button', { name: 'Replace key…' })).not.toBeInTheDocument(); // per key, in ⋯
    expect(within(win).getByRole('button', { name: 'Remove provider…' })).toBeInTheDocument();

    await user.click(within(win).getByRole('button', { name: 'Use this key' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/kb/agents/hermes/providers/openrouter/credentials/or0003/priority', body: { priority: 0 } })));

    await user.click(within(win).getByRole('button', { name: 'More for Personal' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Replace key…', 'Remove…']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Replace key…' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/kb/agents/hermes/providers/openrouter/credentials/or0001/sign-in' })));

    await user.click(within(win).getByRole('button', { name: 'More for Work' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove…' }));
    const confirm = within(win).getByRole('group', { name: 'Remove the key “Work” from Hermes?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'DELETE', path: '/kb/agents/hermes/providers/openrouter/credentials/or0002' })));
  });

  it('Add another key…: a name in SKAZ, the key in Terminal', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: accountsWorld() });
    const { block } = await openAccounts();
    await user.click(await within(block).findByRole('button', { name: /^OpenRouter/ }));
    const win = await screen.findByRole('dialog', { name: 'OpenRouter' });
    await user.click(within(win).getByRole('button', { name: 'Add another key…' }));
    expect(within(win).getByText('Paste it in Terminal — SKAZ never sees it')).toBeInTheDocument();
    await user.type(within(win).getByRole('textbox', { name: 'Name' }), 'Team');
    await user.click(within(win).getByRole('button', { name: 'Add in Terminal…' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/kb/agents/hermes/providers/openrouter/keys', body: { label: 'Team' } })));
    expect(await within(win).findByText('Finish in Terminal.')).toBeInTheDocument();
    expect(within(win).getByRole('status')).toHaveTextContent('SKAZ checks as soon as Terminal finishes.');
  });

  it('Add provider: the whole catalogue with tabs and search, ✓ on added ones; a pick opens Terminal, the chip spins, then one line says it is ready', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: accountsWorld() });
    const { block } = await openAccounts();
    await user.click(await within(block).findByRole('button', { name: 'Add provider' }));
    const add = await screen.findByRole('dialog', { name: 'Add a provider to Hermes' });
    expect(within(add).getByRole('searchbox', { name: 'Find a provider' })).toHaveAttribute('placeholder', 'Find a provider — 45 in Hermes');
    const items = () => within(add).getAllByRole('button').filter((b) => b.classList.contains('kb-addprovider__item'));
    expect(items()).toHaveLength(45);
    expect(items().find((b) => b.dataset.provider === 'openrouter')).toHaveAccessibleName('OpenRouter, added');
    await user.click(within(add).getByRole('button', { name: 'Cloud' }));
    expect(items().map((b) => b.dataset.provider)).toEqual(['bedrock', 'vertex', 'azure-foundry']);
    await user.click(within(add).getByRole('button', { name: 'All' }));
    await user.type(within(add).getByRole('searchbox', { name: 'Find a provider' }), 'kimi');
    expect(items().map((b) => b.dataset.provider)).toEqual(['kimi-coding', 'kimi-coding-cn']);
    await user.click(items()[0]!);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/kb/agents/hermes/providers/add', body: { provider: 'kimi-coding', group: 'api_key' } })));
    const live = await within(block).findByRole('status');
    expect(live).toHaveTextContent('Finish in Terminal. Paste the Kimi / Moonshot key there — SKAZ never sees it. SKAZ checks as soon as Terminal finishes.');
    expect(within(block).getByText('Kimi / Moonshot').closest('.kb-hchip')).toHaveAttribute('data-adding', 'true');

    // Terminal finished: SKAZ reads the list again (here: the window gets focus) and says so in one line.
    fake.world.hermesProviders.terminal!.state = 'done';
    fake.world.hermesProviders.providers.push({ id: 'kimi-coding', name: 'Kimi / Moonshot', order: 2, free_tier: null, credentials: [
      { index: 1, id: 'k1m1', label: 'api-key-1', auth_type: 'api_key', priority: 0, state: 'ready', until: null, detail: null, current: true },
    ] });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(await within(block).findByText('Kimi / Moonshot added and ready. Hermes tries it 3rd.')).toBeInTheDocument();
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/hermes/check' })));
  });

  it('Other provider… opens Hermes’ credential manager', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: accountsWorld() });
    const { block } = await openAccounts();
    await user.click(await within(block).findByRole('button', { name: 'Add provider' }));
    const add = await screen.findByRole('dialog', { name: 'Add a provider to Hermes' });
    await user.click(within(add).getByRole('button', { name: 'Other provider…' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/hermes/providers/other' })));
  });

  it('says why when Hermes can’t list its providers', async () => {
    const world = accountsWorld();
    world.hermesProviders = { ...world.hermesProviders, state: 'unavailable', reason: 'Hermes didn’t list its providers.', providers: [] };
    renderKb({ world });
    const { block } = await openAccounts();
    expect(await within(block).findByRole('alert')).toHaveTextContent('Hermes didn’t list its providers.');
    expect(within(block).getByRole('button', { name: 'Add provider' })).toBeDisabled();
  });

  it('is not shown while Hermes is not installed (the agent row says what to do)', async () => {
    renderKb({ world: chatWorld() });
    await screen.findByRole('navigation', { name: 'Sections' });
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    await within(dialog).findByRole('group', { name: 'Hermes Agent' });
    expect(within(dialog).queryByTestId('hermes-providers')).not.toBeInTheDocument();
  });
});
