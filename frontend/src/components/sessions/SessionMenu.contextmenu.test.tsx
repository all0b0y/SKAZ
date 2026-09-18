import { expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionList } from './SessionList';
import { useStore } from '../../state/store';
import type { Session } from '../../api/types';
import type { JsonResponse } from '../../api/bridge';

/**
 * One right click is one menu, in the session rail too.
 *
 * The rail's menu closes on a pointer press outside itself, and the browser
 * sends that press BEFORE the `contextmenu` that opens the next menu — so a
 * right click on a second group chip was spent closing the first menu and the
 * one the user asked for never appeared. The guard lives in the menu; this test
 * is here so the rail's copy of it cannot quietly regress on its own.
 */

const session = (id: string, title: string): Session => ({
  id, title, created_at: '2026-01-01T00:00:00Z', status: 'stopped',
  duration_ms: 1_000, mode: 'legacy',
});

beforeEach(() => {
  localStorage.clear();
  window.audiohelper = {
    ...window.audiohelper,
    request: async <T,>(): Promise<JsonResponse<T>> => ({ ok: true, status: 200,
      data: { enabled: false, revision: 0, pending: null,
        data: { version: 1, groups: [], membership: {} } } as T }),
  };
  useStore.setState({
    sessions: [session('s1', 'Лекция')],
    activeSessionId: 's1',
    recorderState: 'idle',
    newSession: vi.fn(async () => undefined),
    selectSession: vi.fn(async () => undefined),
    removeSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    backend: { phase: 'ready' },
  });
});

const makeGroup = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole('button', { name: 'Create group' }));
  await user.type(screen.getByRole('textbox', { name: 'Group name' }), name);
  await user.click(screen.getByRole('button', { name: 'Create' }));
  return screen.findByRole('tab', { name: new RegExp(name) });
};

it('moves the group menu to the second chip in one right click', async () => {
  const user = userEvent.setup();
  render(<SessionList onOpenSettings={vi.fn()} onOpenSearch={vi.fn()} />);
  const first = await makeGroup(user, 'Первая');
  const second = await makeGroup(user, 'Вторая');

  await user.pointer({ keys: '[MouseRight]', target: first });
  expect(await screen.findByRole('menu', { name: 'Group actions' })).toBeInTheDocument();

  // The second right click must open the second chip's menu, not be spent
  // dismissing the first one.
  await user.pointer({ keys: '[MouseRight]', target: second });
  expect(await screen.findByRole('menu', { name: 'Group actions' })).toBeInTheDocument();
  expect(screen.getAllByRole('menu')).toHaveLength(1);
});
