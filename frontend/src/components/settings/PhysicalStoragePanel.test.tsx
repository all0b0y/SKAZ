import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import type { BridgeRequest, JsonResponse } from '../../api/bridge';
import type { StorageLayout } from '../../api/client';
import { useStore } from '../../state/store';
import { SessionNavigator } from '../sessions/SessionNavigator';
import { PhysicalStoragePanel } from './PhysicalStoragePanel';

let view: StorageLayout;
let requests: BridgeRequest[];
let failWrite = false;
beforeEach(() => {
  localStorage.clear();
  failWrite = false;
  view = { enabled: true, revision: 0, pending: null, data: { version: 1, groups: [], membership: {} } };
  requests = [];
  useStore.setState({ sessions: [], activeSessionId: null, recorderState: 'idle' });
  window.audiohelper = { ...window.audiohelper,
    request: async <T,>(request: BridgeRequest): Promise<JsonResponse<T>> => {
      requests.push(request);
      if (request.method === 'PUT') {
        if (failWrite) throw new Error('/private/secret');
        const body = request.body as { data: StorageLayout['data']; expected_revision: number };
        expect(body.expected_revision).toBe(view.revision);
        view = { ...view, data: body.data, revision: view.revision + 1 };
      }
      if (request.method === 'POST') {
        view = { ...view, enabled: true, pending: null };
      }
      return { ok: true, status: 200, data: structuredClone(view) as T };
    },
  };
});

it('saves a physical group through IPC and readback, never browser storage', async () => {
  const user = userEvent.setup();
  render(<SessionNavigator />);
  await waitFor(() => expect(requests).toHaveLength(1));
  await user.click(screen.getByRole('button', { name: 'Create group' }));
  await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'Physics');
  await user.click(screen.getByRole('button', { name: 'Create' }));
  expect(await screen.findByRole('tab', { name: /Physics/ })).toBeVisible();
  expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
    'GET /storage/layout', 'PUT /storage/groups', 'GET /storage/layout',
  ]);
  expect(localStorage.getItem('audiohelper.session-groups.v1')).toBeNull();
});

it('does not announce a physical move or fall back to local prefs after unknown PUT outcome', async () => {
  const user = userEvent.setup();
  failWrite = true;
  render(<SessionNavigator />);
  await act(async () => {});
  await user.click(screen.getByRole('button', { name: 'Create group' }));
  await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'Not saved');
  await user.click(screen.getByRole('button', { name: 'Create' }));
  expect(screen.queryByRole('tab', { name: /Not saved/ })).not.toBeInTheDocument();
  expect(localStorage.getItem('audiohelper.session-groups.v1')).toBeNull();
  expect(screen.queryByText(/private\/secret/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Create' }));
  expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
});

it('requires explicit confirmation for enabling and only GETs on mount', async () => {
  view.enabled = false;
  const user = userEvent.setup();
  render(<PhysicalStoragePanel capturing={false} />);
  await user.click(await screen.findByRole('button', { name: 'Включить файловый режим…' }));
  expect(requests.every((r) => r.method === 'GET')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Подтвердить файловый режим' }));
  expect(await screen.findByText(/Файловый режим включён/)).toBeVisible();
  expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
    'GET /storage/layout', 'POST /storage/layout', 'GET /storage/layout',
  ]);
});

it('discloses pending deletion and resumes only on explicit click with readback', async () => {
  view.pending = { kind: 'delete', phase: 'cleanup' };
  const user = userEvent.setup();
  render(<PhysicalStoragePanel capturing={false} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('не отменяет удаление');
  expect(requests.every((r) => r.method === 'GET')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Продолжить восстановление' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
    'GET /storage/layout', 'POST /storage/recover', 'GET /storage/layout',
  ]);
});
