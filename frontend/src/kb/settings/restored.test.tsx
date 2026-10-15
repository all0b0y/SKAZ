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
