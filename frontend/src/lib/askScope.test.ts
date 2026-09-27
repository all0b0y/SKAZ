import { beforeEach, expect, it, vi } from 'vitest';
import { ApiClient } from '../api/client';
import type { Session } from '../api/types';
import { askScope } from './askScope';
import { saveGroups } from './sessionGroups';

const sessions: Session[] = ['a', 'b', 'c'].map((id) => ({
  id, title: id, created_at: '2026-01-01', status: 'stopped', duration_ms: 0, mode: 'legacy',
}));
beforeEach(() => localStorage.clear());
const api = () => new ApiClient(window.skaz);

it('does not send explicit member ids for Session or All', async () => {
  expect(await askScope(api(), 'session', 'a', sessions)).toEqual({ search_scope: 'session' });
  expect(await askScope(api(), 'all', 'a', sessions)).toEqual({ search_scope: 'all' });
});

it('reads current local group membership on each submission', async () => {
  const client = api();
  vi.spyOn(client, 'getStorageLayout').mockResolvedValue({ enabled: false, revision: 0, pending: null,
    data: { version: 1, groups: [], membership: {} } });
  saveGroups({ version: 1, groups: [{ id: 'g', name: 'Group', tag: '' }], membership: { a: 'g', b: 'g', c: null } });
  expect(await askScope(client, 'group', 'a', sessions)).toEqual({ search_scope: 'group', group_session_ids: ['a', 'b'] });
  saveGroups({ version: 1, groups: [{ id: 'g', name: 'Group', tag: '' }], membership: { a: 'g', b: null, c: 'g' } });
  expect(await askScope(client, 'group', 'a', sessions)).toEqual({ search_scope: 'group', group_session_ids: ['a', 'c'] });
  await expect(askScope(client, 'group', 'b', sessions)).rejects.toThrow('no group');
});

it('never sends local group membership when backend owns managed groups', async () => {
  const client = api();
  vi.spyOn(client, 'getStorageLayout').mockResolvedValue({ enabled: true, revision: 3, pending: null,
    data: { version: 1, groups: [], membership: {} } });
  expect(await askScope(client, 'group', 'a', sessions)).toEqual({ search_scope: 'group' });
});
