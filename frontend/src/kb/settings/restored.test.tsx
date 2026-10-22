import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { chatWorld } from '../test/fixtures';

// Capabilities the old interface had and the Knowledge Wiki settings restore (F2).

const openSettings = async () => {
  await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.keyDown(window, { key: ',', metaKey: true });
  return screen.findByRole('dialog', { name: 'Settings' });
};
const row = (dialog: HTMLElement, label: string) => within(dialog).getByRole('group', { name: label });

describe('Settings → Privacy → Activity log', () => {
  it('shows what ran, newest first, with no text — read-only from GET /logs; the logs folder opens from there', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.activity = {
      capacity: 256, dropped: 0,
      entries: [
        { sequence: 2, at_ms: Date.UTC(2026, 9, 15, 9, 41, 7), operation: 'kb_decision_file', provider: 'openrouter_jev', model: 'jev-1',
          attempt: 1, elapsed_ms: 1240, outcome: 'ok', status: 200, retrying: false, usage: { total_tokens: 310 } },
        { sequence: 1, at_ms: Date.UTC(2026, 9, 15, 9, 40, 0), operation: 'provider audio transcription', provider: 'openai', model: 'whisper-1',
          attempt: 2, elapsed_ms: 15_000, outcome: 'http_error', status: 503, retrying: true, usage: {} },
      ],
    };
    const { fake } = renderKb({ world });
    const openLogsFolder = vi.fn(async () => true);
    Object.assign(fake.bridge, { openLogsFolder });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: /Privacy/ }));
    const logRow = row(dialog, 'Activity log');
    expect(within(logRow).queryByText('Not connected yet')).not.toBeInTheDocument();
    await user.click(within(logRow).getByRole('button', { name: 'Show…' }));
    const log = await screen.findByRole('dialog', { name: 'Activity log' });
    const items = await within(log).findAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Newest first, as the backend sends it; technical facts only.
    expect(items[0]).toHaveTextContent('kb_decision_file');
    expect(items[0]).toHaveTextContent('openrouter_jev · jev-1');
    expect(items[0]).toHaveTextContent('ok');
    expect(items[0]).toHaveTextContent('1.2 s');
    expect(items[1]).toHaveTextContent('http_error · 503');
    expect(items[1]).toHaveTextContent('attempt 2, retrying');
    expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'GET', path: '/logs' }));
    // Read-only: nothing in the window writes.
    expect(within(log).queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(within(log).getByRole('button', { name: 'Open logs folder' }));
    expect(openLogsFolder).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing ran yet, and when the log cannot be read', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.activity = { capacity: 256, dropped: 0, entries: [] };
    const { fake } = renderKb({ world });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: /Privacy/ }));
    await user.click(within(row(dialog, 'Activity log')).getByRole('button', { name: 'Show…' }));
    const log = await screen.findByRole('dialog', { name: 'Activity log' });
    expect(await within(log).findByText('Nothing has run yet.')).toBeInTheDocument();
    // No folder button without the desktop bridge method.
    expect(within(log).queryByRole('button', { name: 'Open logs folder' })).not.toBeInTheDocument();
    fake.world.failures['GET /logs'] = { status: 500, detail: 'Internal Server Error' };
    await user.click(within(log).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(within(log).getByRole('alert')).toHaveTextContent('Couldn’t read the activity log'));
  });
});

describe('Settings → Accounts & keys → Codex: sign out (SKAZ’s own Codex sign-in)', () => {
  // Accounts & keys v3: Sign out… lives in ⋯ next to Check and asks first (accountsAgents.test.tsx).
  const signOut = async (user: ReturnType<typeof userEvent.setup>, codex: HTMLElement) => {
    await user.click(await within(codex).findByRole('button', { name: 'More for Codex' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out…' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Sign out of Codex?' })).getByRole('button', { name: 'Sign out' }));
  };

  it('a signed-in Codex offers Sign out in ⋯; it signs out through /kb/agents/codex/logout and says what it removed', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: chatWorld() });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: /Accounts & keys/ }));
    const codex = row(dialog, 'Codex');
    expect(await within(codex).findByText(/Connected/)).toBeInTheDocument();
    await signOut(user, codex);
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/kb/agents/codex/logout' })));
    expect(await within(codex).findByText('Not signed in')).toBeInTheDocument();
    expect(within(codex).getByRole('status')).toHaveTextContent('Signed out of Codex in SKAZ. Codex in other apps stays signed in.');
    expect(within(codex).queryByRole('button', { name: 'More for Codex' })).not.toBeInTheDocument();
    expect(within(codex).getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('a refused sign-out is said, and Codex stays as it was', async () => {
    const user = userEvent.setup();
    const world = chatWorld();
    world.failures['POST /kb/agents/codex/logout'] = { status: 409, detail: 'SKAZ couldn’t sign out of Codex: Check the Codex connection first' };
    renderKb({ world });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: /Accounts & keys/ }));
    const codex = row(dialog, 'Codex');
    await signOut(user, codex);
    expect(await within(codex).findByRole('alert')).toHaveTextContent('Check the Codex connection first');
    expect(within(codex).getByText(/Connected/)).toBeInTheDocument();
  });
});

describe('Settings → Recording & speech → the speech model on this computer: delete', () => {
  const readyWorld = () => {
    const world = chatWorld();
    world.speech.local_model = { model: 'small', state: 'ready', progress: null, reason: null, size_bytes: 484_000_000 };
    return world;
  };

  it('asks first with the size, then deletes only after confirming; the row says what was freed', async () => {
    const user = userEvent.setup();
    const { fake } = renderKb({ world: readyWorld() });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: /Recording & speech/ }));
    const model = row(dialog, 'Speech model on this computer');
    expect(await within(model).findByText('Whisper small · about 484 MB')).toBeInTheDocument();
    await user.click(within(model).getByRole('button', { name: 'Delete…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete the speech model?' });
    expect(confirm).toHaveTextContent('Whisper small (about 484 MB)');
    expect(confirm).toHaveTextContent('Recognition on this computer won’t work until you download it again');
    // Cancel deletes nothing.
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(model).getByRole('button', { name: 'Delete…' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete the speech model?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/kb/settings/speech/local-model' })));
    expect(await within(model).findByRole('status')).toHaveTextContent('Deleted · 484 MB freed');
    expect(within(model).getByText('Not downloaded')).toBeInTheDocument();
    expect(within(model).queryByRole('button', { name: 'Delete…' })).not.toBeInTheDocument();
  });

  it('a busy model is not deleted and the reason is shown; nothing to delete offers no button', async () => {
    const user = userEvent.setup();
    const world = readyWorld();
    world.failures['DELETE /kb/settings/speech/local-model'] = { status: 409, detail: 'The speech model is in use or still downloading. Try again when it is free.' };
    renderKb({ world });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: /Recording & speech/ }));
    const model = row(dialog, 'Speech model on this computer');
    await user.click(await within(model).findByRole('button', { name: 'Delete…' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete the speech model?' })).getByRole('button', { name: 'Delete' }));
    expect(await within(model).findByRole('alert')).toHaveTextContent('in use or still downloading');
    expect(within(model).getByText('Whisper small · about 484 MB')).toBeInTheDocument();
  });

  it('a model that is not downloaded has nothing to delete', async () => {
    const user = userEvent.setup();
    renderKb({ world: chatWorld() });
    const dialog = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: /Recording & speech/ }));
    const model = row(dialog, 'Speech model on this computer');
    expect(await within(model).findByText('Not downloaded')).toBeInTheDocument();
    expect(within(model).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });
});
