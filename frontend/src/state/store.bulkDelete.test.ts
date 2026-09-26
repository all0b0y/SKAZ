import { beforeEach, expect, it, vi } from 'vitest';
import type { BridgeApi, BridgeRequest, JsonResponse } from '../api/bridge';
import type { Session } from '../api/types';
import { useStore } from './store';

const session = (id: string): Session => ({
  id, title: id, created_at: '2026-09-25T00:00:00Z', status: 'stopped', duration_ms: 1_000, mode: 'legacy',
});

const bridge = window.audiohelper as unknown as Omit<BridgeApi, 'request'> & { request: ReturnType<typeof vi.fn> };

let failed: { id: string; reason: string }[] = [];

beforeEach(() => {
  failed = [];
  bridge.request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
    if (req.method === 'POST' && req.path === '/sessions/delete') {
      const ids = (req.body as { ids: string[] }).ids;
      const bad = new Set(failed.map((f) => f.id));
      return { ok: true, status: 200, data: { deleted: ids.filter((id) => !bad.has(id)), failed } };
    }
    if (req.method === 'GET' && /^\/sessions\/[^/]+$/.test(req.path)) {
      const id = req.path.split('/').at(-1)!;
      return { ok: true, status: 200, data: { session: session(id), segments: [], messages: [], notes: null } };
    }
    if (req.method === 'GET') return { ok: true, status: 200, data: { chunks: [], next_after_sequence: null, events: [] } };
    throw new Error(`unexpected ${req.method} ${req.path}`);
  });
  useStore.setState({
    sessions: ['a', 'b', 'c', 'd'].map(session), activeSessionId: 'b', detail: null, recorderState: 'idle',
  });
});

it('deletes several sessions in one request and drops only the deleted ones', async () => {
  failed = [{ id: 'c', reason: 'Markdown files need attention.' }];
  const result = await useStore.getState().removeSessions(['a', 'c']);
  expect(bridge.request).toHaveBeenCalledWith(expect.objectContaining({
    method: 'POST', path: '/sessions/delete', body: { ids: ['a', 'c'] } }));
  expect(result).toEqual({ deleted: ['a'], failed: [{ id: 'c', reason: 'Markdown files need attention.' }] });
  expect(useStore.getState().sessions.map((s) => s.id)).toEqual(['b', 'c', 'd']);
  expect(useStore.getState().activeSessionId).toBe('b');
});

it('opens the first remaining session when the active one is deleted', async () => {
  await useStore.getState().removeSessions(['a', 'b']);
  expect(useStore.getState().sessions.map((s) => s.id)).toEqual(['c', 'd']);
  expect(useStore.getState().activeSessionId).toBe('c');
});

it('never sends the capturing session', async () => {
  useStore.setState({ recorderState: 'paused' });
  const result = await useStore.getState().removeSessions(['a', 'b']);
  expect(bridge.request).toHaveBeenCalledWith(expect.objectContaining({ body: { ids: ['a'] } }));
  expect(result.deleted).toEqual(['a']);
  expect(useStore.getState().sessions.map((s) => s.id)).toEqual(['b', 'c', 'd']);
});
