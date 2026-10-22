import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { accountsWorld } from '../test/fixtures';

// Settings → Accounts & keys v3 (confirmed 2026-10-21): Sign out of every agent from ⋯ next to Check,
// with a confirmation saying what stops working; sign-in that checks itself (Codex opens the
// browser at once, Terminal sign-ins are checked as soon as Terminal finishes).

const openAccounts = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Accounts & keys/ }));
  return dialog;
};
const row = (dialog: HTMLElement, label: string) => within(dialog).getByRole('group', { name: label });

afterEach(() => { vi.restoreAllMocks(); });

describe('Settings → Accounts & keys → agents: Sign out from ⋯', () => {
  it('Codex: ⋯ → Sign out… asks first, says nothing in the library is deleted, then signs out of SKAZ’s Codex only', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: accountsWorld() });
    const dialog = await openAccounts();
    const codex = row(dialog, 'Codex');
    expect(await within(codex).findByText(/Connected/)).toBeInTheDocument();
    expect(within(codex).queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument(); // not a visible button
    await user.click(within(codex).getByRole('button', { name: 'More for Codex' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Sign out of Codex?' });
    expect(confirm).toHaveTextContent('Chats and wiki updates on Codex stop until you sign in again.');
    expect(confirm).toHaveTextContent('Nothing in your library is deleted.');
    expect(confirm).toHaveTextContent('Codex in other apps stays signed in.');
    expect(fake.calls.some((c) => c.path === '/kb/agents/codex/logout')).toBe(false);
    await user.click(within(confirm).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/codex/logout' })));
    expect(await within(codex).findByText('Not signed in')).toBeInTheDocument();
    expect(within(codex).getByRole('status')).toHaveTextContent('Signed out of Codex in SKAZ. Codex in other apps stays signed in.');
  });

  it('OpenCode signs out of SKAZ’s own OpenCode folder', async () => {
    const user = userEvent.setup();
    const world = accountsWorld();
    Object.assign(world.agents.agents.find((a) => a.id === 'opencode')!, { state: 'ready', signed_in: true, reason: null, action: null });
    const { fake } = renderKb({ world });
    const dialog = await openAccounts();
    const opencode = row(dialog, 'OpenCode');
    await user.click(await within(opencode).findByRole('button', { name: 'More for OpenCode' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Sign out of OpenCode?' });
    expect(confirm).toHaveTextContent('OpenCode outside SKAZ is not changed.');
    await user.click(within(confirm).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/opencode/logout' })));
    expect(await within(opencode).findByText('Not signed in')).toBeInTheDocument();
  });

  it('Claude Code’s ⋯ says why SKAZ doesn’t sign it out; Hermes’ ⋯ only checks again (its providers sign out one by one)', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: accountsWorld() });
    const dialog = await openAccounts();
    await user.click(await within(row(dialog, 'Claude Code')).findByRole('button', { name: 'More for Claude Code' }));
    const claudeItem = await screen.findByRole('menuitem', { name: /Sign out/ });
    expect(claudeItem).toHaveAttribute('aria-disabled', 'true');
    expect(claudeItem).toHaveTextContent('in Claude Code itself');
    fireEvent.keyDown(claudeItem, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    await user.click(within(row(dialog, 'Hermes Agent')).getByRole('button', { name: 'More for Hermes Agent' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Check again']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Check again' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/hermes/check' })));
  });

  it('a refused sign-out is said, and the agent stays as it was', async () => {
    const user = userEvent.setup();
    const world = accountsWorld();
    world.failures['POST /kb/agents/codex/logout'] = { status: 409, detail: 'SKAZ couldn’t sign out of Codex: Check the Codex connection first' };
    renderKb({ world });
    const dialog = await openAccounts();
    const codex = row(dialog, 'Codex');
    await user.click(await within(codex).findByRole('button', { name: 'More for Codex' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out…' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Sign out of Codex?' })).getByRole('button', { name: 'Sign out' }));
    expect(await within(codex).findByRole('alert')).toHaveTextContent('Check the Codex connection first');
    expect(within(codex).getByText(/Connected/)).toBeInTheDocument();
  });
});

describe('Settings → Accounts & keys → agents: sign-in that checks itself', () => {
  it('Codex opens the sign-in page the backend returned at once and checks as soon as the sign-in completes', async () => {
    const user = userEvent.setup();
    const world = accountsWorld();
    Object.assign(world.agents.agents.find((a) => a.id === 'codex')!, { state: 'signed_out', signed_in: false, action: 'login', reason: 'Sign in with ChatGPT to use Codex.' });
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const { fake } = renderKb({ world });
    const dialog = await openAccounts();
    const codex = row(dialog, 'Codex');
    await user.click(await within(codex).findByRole('checkbox'));
    await user.click(within(codex).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith('https://auth.openai.com/authorize?fake=1', '_blank', 'noopener'));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'GET', path: '/kb/agents/codex/sign-in' })));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/codex/check' })));
    expect(await within(codex).findByText('Signed in. Codex is connected.')).toBeInTheDocument();
    expect(within(codex).getByText(/Connected/)).toBeInTheDocument();
  });

  it('a Terminal sign-in says to finish in Terminal, and when Terminal stops with an error says so', async () => {
    const user = userEvent.setup();
    const world = accountsWorld();
    world.signIns = { opencode: 'waiting' };
    const { fake } = renderKb({ world });
    const dialog = await openAccounts();
    const opencode = row(dialog, 'OpenCode');
    await user.click(await within(opencode).findByRole('button', { name: 'Sign in' }));
    expect(await within(opencode).findByText(/Finish in Terminal/)).toHaveTextContent('SKAZ checks as soon as Terminal finishes.');
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'GET', path: '/kb/agents/opencode/sign-in' })));
    fake.world.signIns = { opencode: 'failed' };
    expect(await within(opencode).findByText('OpenCode stopped before it finished in Terminal. Try again.', {}, { timeout: 6000 })).toBeInTheDocument();
    expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/opencode/check' }));
  }, 10_000);
});
