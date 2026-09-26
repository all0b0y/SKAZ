import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { BridgeRequest, JsonResponse } from '../../api/bridge';

let Panel: typeof import('./StorageRootPanel')['StorageRootPanel'];
let requests: BridgeRequest[];
let current: { root: string | null; suggested_root: string; managed: boolean; change_locked: boolean; mode: string };
let choose: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
let handler: (req: BridgeRequest) => Promise<JsonResponse<unknown>>;

beforeEach(async () => {
  vi.resetModules();
  requests = [];
  current = { root: null, suggested_root: '/fixture/Documents/SKAZ', managed: false, change_locked: false, mode: 'markdown_projection' };
  choose = vi.fn().mockResolvedValue('/fixture/chosen');
  handler = async (req) => {
    if (req.method === 'PUT') current = { ...current, root: (req.body as { root: string | null }).root };
    return { ok: true, status: 200, data: { ...current } };
  };
  window.audiohelper = { ...window.audiohelper, chooseStorageRoot: choose,
    request: async <T,>(req: BridgeRequest): Promise<JsonResponse<T>> => {
      requests.push(req);
      if (req.path === '/storage/layout') return { ok: true, status: 200,
        data: { enabled: false, revision: 0, pending: null, data: { version: 1, groups: [], membership: {} } } as T };
      return await handler(req) as JsonResponse<T>;
    },
  };
  Panel = (await import('./StorageRootPanel')).StorageRootPanel;
});

it('reads only on mount and saves the selected folder only after confirmation, with readback', async () => {
  const user = userEvent.setup();
  render(<Panel capturing={false} />);
  expect(await screen.findByText('Markdown projection is off.')).toBeVisible();
  expect(screen.getByText(/only Markdown is saved here/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Choose folder…' }));
  expect(screen.getByText('/fixture/chosen')).toBeVisible();
  expect(requests.filter((r) => r.path === '/storage/root')).toEqual([{ method: 'GET', path: '/storage/root' }]);
  await user.click(screen.getByRole('button', { name: 'Confirm Markdown root' }));
  expect(await screen.findByText('Markdown root saved.')).toBeVisible();
  expect(requests.filter((r) => r.path === '/storage/root')).toEqual([
    { method: 'GET', path: '/storage/root' },
    { method: 'PUT', path: '/storage/root', body: { root: '/fixture/chosen', expected_root: null } },
    { method: 'GET', path: '/storage/root' },
  ]);
});

it('cancels the native chooser and the suggested root without any write', async () => {
  const user = userEvent.setup();
  choose.mockResolvedValue(null);
  render(<Panel capturing={false} />);
  await screen.findByText('Markdown projection is off.');
  await user.click(screen.getByRole('button', { name: 'Choose folder…' }));
  expect(screen.queryByRole('button', { name: 'Confirm Markdown root' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Use Documents/SKAZ' }));
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(requests.every((r) => r.method === 'GET')).toBe(true);
});

it('requires read-only reconciliation after an unknown PUT outcome and hides raw errors', async () => {
  const user = userEvent.setup();
  handler = async (req) => {
    if (req.method === 'PUT') {
      current.root = '/fixture/chosen';
      throw new Error('/private/secret-path');
    }
    return { ok: true, status: 200, data: { ...current } };
  };
  render(<Panel capturing={false} />);
  await screen.findByText('Markdown projection is off.');
  await user.click(screen.getByRole('button', { name: 'Choose folder…' }));
  await user.click(screen.getByRole('button', { name: 'Confirm Markdown root' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Saving was not confirmed');
  expect(screen.queryByText(/secret-path/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Choose folder…' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Check current root' }));
  expect(await screen.findByText('/fixture/chosen')).toBeVisible();
  expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
});

it.each(['used', 'managed', 'capturing'])('disables selection when %s', async (reason) => {
  current.change_locked = reason !== 'capturing';
  current.managed = reason === 'managed';
  render(<Panel capturing={reason === 'capturing'} />);
  await screen.findByText('Markdown projection is off.');
  expect(screen.getByRole('button', { name: 'Choose folder…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Use Documents/SKAZ' })).toBeDisabled();
  expect(requests.every((r) => r.method === 'GET')).toBe(true);
});

it('ignores a chooser result after leaving the panel', async () => {
  const user = userEvent.setup();
  let resolve!: (value: string) => void;
  choose.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
  const first = render(<Panel capturing={false} />);
  await screen.findByText('Markdown projection is off.');
  await user.click(screen.getByRole('button', { name: 'Choose folder…' }));
  first.unmount();
  render(<Panel capturing={false} />);
  resolve('/fixture/stale');
  await waitFor(() => expect(screen.getByText('Markdown projection is off.')).toBeVisible());
  expect(screen.queryByText('/fixture/stale')).not.toBeInTheDocument();
  expect(requests.every((r) => r.method === 'GET')).toBe(true);
});
