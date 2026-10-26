import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { accountsWorld } from '../test/fixtures';
import { agentUpdate, emptyAgentUpdates } from '../test/fakeAgentUpdates';
import type { FakeWorld } from '../test/fakeKb';
import type { KbAgentUpdate } from '../../api/kb/types.gen';

// U1 (2026-10-26): SKAZ checks for newer agent versions by itself and offers them on the agent's card
// in Settings → Accounts & keys; a dot on Settings and on Accounts & keys until seen; no popups.

const openAccounts = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Accounts & keys/ }));
  return dialog;
};
const row = (dialog: HTMLElement, label: string) => within(dialog).getByRole('group', { name: label });

function withUpdate(patch: Partial<KbAgentUpdate>, engine: KbAgentUpdate['engine'] = 'codex'): FakeWorld {
  const world = accountsWorld();
  const updates = emptyAgentUpdates();
  updates.agents = updates.agents.map((a) => (a.engine === engine ? agentUpdate(engine, patch) : a));
  updates.unseen = updates.agents.some((a) => a.unseen);
  updates.checked_at = new Date(Date.now() - 5 * 60_000).toISOString();
  world.agentUpdates = updates;
  return world;
}

const OFFER: Partial<KbAgentUpdate> = { channel: 'npm', installed: '0.160.0', latest: '0.164.0', available: true, unseen: true };

afterEach(() => { vi.restoreAllMocks(); });

describe('Agent updates (U1)', () => {
  it('a dot on Settings until the offer is seen; Settings opens on Accounts & keys, which clears it', async () => {
    const { fake } = renderKb({ world: withUpdate(OFFER) });
    const settings = await screen.findByRole('button', { name: 'Settings, agent update available' });
    expect(within(settings).getByTestId('settings-update-dot')).toBeInTheDocument();
    fireEvent.click(settings);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('heading', { name: 'Accounts & keys' })).toBeInTheDocument();
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/updates/seen' })));
    await waitFor(() => expect(screen.queryByTestId('settings-update-dot')).not.toBeInTheDocument());
    // No popup and no Health problem: nothing else asks for attention.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('the card offers X → Y with what it touches, Update and Skip this version', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: withUpdate(OFFER) });
    const dialog = await openAccounts();
    const codex = row(dialog, 'Codex');
    expect(await within(codex).findByText('Update available · 0.160.0 → 0.164.0')).toBeInTheDocument();
    expect(within(codex).getByText('Updates Codex for this whole Mac, including Terminal.')).toBeInTheDocument();
    await user.click(within(codex).getByRole('button', { name: 'Skip this version' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/kb/agents/codex/update/skip', body: { version: '0.164.0' } })));
    await waitFor(() => expect(within(codex).queryByText(/Update available/)).not.toBeInTheDocument());
  });

  it('Update starts the agent’s own update; a busy agent says it updates after current work, with Cancel', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: withUpdate({ ...OFFER, busy: true }) });
    const dialog = await openAccounts();
    const codex = row(dialog, 'Codex');
    await user.click(await within(codex).findByRole('button', { name: 'Update after current work' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/codex/update' })));
    expect(await within(codex).findByText(/Updates after current work/)).toBeInTheDocument();
    await user.click(within(codex).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/codex/update/cancel' })));
    expect(await within(codex).findByRole('button', { name: 'Update after current work' })).toBeInTheDocument();
  });

  it('Hermes says its running services keep the old version', async () => {
    renderKb({ world: withUpdate({ channel: 'git', installed: '0.22.1', latest: '0.22.5', available: true }, 'hermes') });
    const dialog = await openAccounts();
    const hermes = row(dialog, 'Hermes Agent');
    expect(await within(hermes).findByText('Update available · 0.22.1 → 0.22.5')).toBeInTheDocument();
    expect(within(hermes).getByText(/Running Hermes services keep the old version until you restart them\./)).toBeInTheDocument();
  });

  it('a refused update shows its output and the exact Terminal command; a failed one offers Roll back where possible', async () => {
    const user = userEvent.setup();
    const world = withUpdate({ channel: 'brew', installed: '2.1.281', latest: '2.1.310', available: true, failure: {
      reason: 'Claude Code wasn’t updated: it is still 2.1.281.', command: 'brew upgrade claude-code',
      output: ['Claude is managed by Homebrew.'], previous: '2.1.281', rollback: 'none', docs_url: 'https://code.claude.com/docs/en/setup',
    } }, 'claude_code');
    const opencode = world.agentUpdates!.agents.find((a) => a.engine === 'opencode')!;
    Object.assign(opencode, { channel: 'curl', installed: '1.19.4', latest: '1.19.4', failure: {
      reason: 'This OpenCode version can’t be used.', command: 'opencode upgrade', output: [], previous: '1.17.18',
      rollback: 'skaz', docs_url: 'https://opencode.ai/docs/' } });
    const codex = world.agentUpdates!.agents.find((a) => a.engine === 'codex')!;
    Object.assign(codex, { channel: 'npm', installed: '0.164.0', latest: '0.164.0', failure: {
      reason: 'Bad.', command: 'npm install -g @openai/codex@latest', output: [], previous: '0.160.0',
      rollback: 'manual', docs_url: 'https://github.com/openai/codex/releases' } });
    Object.assign(world.agents.agents.find((a) => a.id === 'opencode')!, { installed: true });
    const { fake } = renderKb({ world });
    const dialog = await openAccounts();
    const claude = row(dialog, 'Claude Code');
    expect(await within(claude).findByRole('alert')).toHaveTextContent('Claude Code wasn’t updated: it is still 2.1.281.');
    expect(within(claude).getByLabelText('Claude Code update output')).toHaveTextContent('Claude is managed by Homebrew.');
    expect(within(claude).getByText('brew upgrade claude-code')).toBeInTheDocument();
    expect(within(claude).queryByRole('button', { name: /Roll back/ })).not.toBeInTheDocument();
    const codexRow = row(dialog, 'Codex');
    expect(within(codexRow).getByRole('link', { name: 'instructions' })).toHaveAttribute('href', 'https://github.com/openai/codex/releases');
    expect(within(codexRow).getByText(/Roll back manually to 0\.160\.0/)).toBeInTheDocument();
    const open = row(dialog, 'OpenCode');
    await user.click(within(open).getByRole('button', { name: 'Roll back to 1.17.18' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/opencode/update/rollback' })));
  });

  it('Roll back for Claude Code says it may update itself again; OpenCode’s does not', async () => {
    const world = withUpdate({ channel: 'native', installed: '2.1.310', latest: '2.1.310', failure: {
      reason: 'This Claude Code version can’t be used.', command: 'claude install 2.1.281', output: [], previous: '2.1.281',
      rollback: 'skaz', docs_url: 'https://code.claude.com/docs/en/setup',
    } }, 'claude_code');
    const opencode = world.agentUpdates!.agents.find((a) => a.engine === 'opencode')!;
    Object.assign(opencode, { channel: 'curl', installed: '1.19.4', latest: '1.19.4', failure: {
      reason: 'This OpenCode version can’t be used.', command: 'opencode upgrade', output: [], previous: '1.17.18',
      rollback: 'skaz', docs_url: 'https://opencode.ai/docs/' } });
    Object.assign(world.agents.agents.find((a) => a.id === 'opencode')!, { installed: true });
    renderKb({ world });
    const dialog = await openAccounts();
    const claude = row(dialog, 'Claude Code');
    expect(await within(claude).findByRole('button', { name: 'Roll back to 2.1.281' })).toBeInTheDocument();
    expect(within(claude).getByText('Claude Code may update itself again.')).toBeInTheDocument();
    const open = row(dialog, 'OpenCode');
    expect(within(open).getByRole('button', { name: 'Roll back to 1.17.18' })).toBeInTheDocument();
    expect(within(open).queryByText(/may update itself again/)).not.toBeInTheDocument();
  });

  it('one switch for automatic checks, "Last checked" and Check for updates', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: withUpdate({}) });
    const dialog = await openAccounts();
    const setting = row(dialog, 'Check for agent updates automatically');
    expect(await within(setting).findByText('Last checked: 5 min ago')).toBeInTheDocument();
    const toggle = within(setting).getByRole('switch', { name: 'Check for agent updates automatically' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({
      method: 'PUT', path: '/kb/agents/updates/settings', body: { auto: false } })));
    await user.click(within(setting).getByRole('button', { name: 'Check for updates' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/updates/check-now' })));
    expect(await within(setting).findByText('All installed agents are up to date.')).toBeInTheDocument();
    expect(within(setting).getByText('Last checked: just now')).toBeInTheDocument();
  });
});
