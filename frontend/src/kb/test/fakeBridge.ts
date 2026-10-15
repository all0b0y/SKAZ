// In-memory stand-in for the preload bridge on the /kb routes. A fake on the external seam for
// component tests only — it proves the UI's handling of answers, not the backend's behaviour.
import { vi } from 'vitest';
import type { BridgeRequest, JsonResponse } from '../../api/bridge';
import type { KbFolder, KbLibrary, KbMaterialSummary, KbNotification } from '../../api/kb/types.gen';
import { fakeDictate, handleB2, type FakeB2State } from './fakeB2';
import { handleU3, u3World, type U3World } from './u3World';

export interface FakeKbState {
  library: KbLibrary;
  folders: KbFolder[];
  materials: KbMaterialSummary[];
  notifications: KbNotification[];
  /** Package-2 world of the U3 screens (API-B2 shapes); when set it answers first. */
  u3?: U3World;
}

/** A ready library served entirely by the U3 world (pages, corrections, graph, recordings…). */
export function u3State(): FakeKbState {
  return { ...readyState(), u3: u3World() };
}

export function material(id: string, title: string, folderId: string, createdAt: string,
  kind: KbMaterialSummary['kind'] = 'recording'): KbMaterialSummary {
  return { id, title, kind, status: 'ready', folder_id: folderId, languages: ['en'], created_at: createdAt, fragment_count: 3 };
}

export function readyState(): FakeKbState {
  return {
    library: { state: 'ready', root: '/Users/me/Documents/SKAZ', suggested_root: '/Users/me/Documents/SKAZ', reason: null, library_id: 'lib1' },
    folders: [
      { id: 'inbox', name: 'Inbox', system: true, material_count: 1, created_at: '2026-10-01T10:00:00Z' },
      { id: 'phys', name: 'Physics', system: false, material_count: 2, created_at: '2026-10-02T10:00:00Z' },
    ],
    materials: [
      material('m1', 'Lecture 8 — entropy', 'phys', '2026-10-12T10:05:00Z'),
      material('m2', 'Textbook: Information theory, ch. 2', 'phys', '2026-10-11T09:00:00Z', 'pdf'),
      material('m3', 'Pasted text: problems', 'inbox', '2026-10-13T08:00:00Z', 'text'),
    ],
    notifications: [
      { id: 'n1', kind: 'conflict', title: 'Conflict in “Entropy”', body: '', payload: {}, requires_action: true, created_at: '2026-10-13T10:00:00Z', dismissed_at: null },
      { id: 'n2', kind: 'note_ready', title: 'Note ready', body: '', payload: {}, requires_action: false, created_at: '2026-10-13T09:00:00Z', dismissed_at: '2026-10-13T09:30:00Z' },
    ],
  };
}

export function notConfiguredState(): FakeKbState {
  return {
    library: { state: 'not_configured', root: null, suggested_root: '/Users/me/Documents/SKAZ', reason: null, library_id: null },
    folders: [], materials: [], notifications: [],
  };
}

const ok = <T,>(data: T, status = 200): JsonResponse<T> => ({ ok: true, status, data });
const fail = (status: number, detail: string): JsonResponse<never> => ({ ok: false, status, detail });
const key = (name: string) => name.normalize('NFC').toLocaleLowerCase();

/**
 * `b2`: the package-2 world (chats, feed, search, live settings, agents — fakeB2.ts). Without it
 * those routes answer like an old backend that doesn't have them yet.
 */
export function createFakeBridge(initial: FakeKbState = readyState(), b2?: FakeB2State) {
  const state: FakeKbState = structuredClone(initial);
  let seq = 0;
  const calls: BridgeRequest[] = [];
  const request = vi.fn(async (req: BridgeRequest): Promise<JsonResponse<unknown>> => {
    calls.push(req);
    if (state.u3) {
      const answer = handleU3(state.u3, req);
      if (answer) return answer;
    }
    const { method, path } = req;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const needReady = () => (state.library.state === 'ready' ? null
      : fail(503, 'The library is not connected. Choose where to keep it.'));
    if (method === 'GET' && path === '/kb/library') return ok(state.library);
    if (method === 'POST' && path === '/kb/library') {
      const root = typeof body.path === 'string' && body.path ? `${body.path}/SKAZ` : state.library.suggested_root;
      state.library = { ...state.library, state: 'ready', root, library_id: 'lib-new', reason: null };
      if (!state.folders.some((f) => f.system)) {
        state.folders.push({ id: 'inbox', name: 'Inbox', system: true, material_count: 0, created_at: '2026-10-15T00:00:00Z' });
      }
      return ok(state.library);
    }
    if (method === 'POST' && path === '/kb/library/retry') return ok(state.library);
    if (b2) {
      if (path.startsWith('/kb/') && !['/kb/library', '/kb/folders'].some((p) => path.startsWith(p)) && !/^\/kb\/materials(\/[^/]+)?$/.test(path)) {
        const blocked = state.library.state === 'ready' || !/^\/kb\/(chats|notifications|search|mentions|materials|imports)/.test(path) ? null : needReady();
        if (blocked) return blocked;
      }
      const answer = handleB2(b2, req);
      if (answer) return answer;
    }
    if (path.startsWith('/kb/folders') || path.startsWith('/kb/materials') || path === '/kb/notifications') {
      const blocked = needReady();
      if (blocked) return blocked;
    }
    if (method === 'GET' && path === '/kb/folders') return ok(state.folders);
    if (method === 'POST' && path === '/kb/folders') {
      const name = String(body.name ?? '').trim();
      if (!name) return fail(422, 'Enter a name.');
      if (state.folders.some((f) => key(f.name) === key(name))) {
        return fail(409, 'An item with this name already exists. Choose another name.');
      }
      const folder: KbFolder = { id: `f${++seq}`, name, system: false, material_count: 0, created_at: '2026-10-15T00:00:00Z' };
      state.folders.push(folder);
      return ok(folder, 201);
    }
    const folderMatch = /^\/kb\/folders\/([^/]+)$/.exec(path);
    if (folderMatch) {
      const id = decodeURIComponent(folderMatch[1] ?? '');
      const folder = state.folders.find((f) => f.id === id);
      if (!folder) return fail(404, 'Folder not found.');
      if (method === 'PATCH') {
        const name = String(body.name ?? '').trim();
        if (folder.system) return fail(409, 'Inbox can’t be renamed.');
        if (state.folders.some((f) => f.id !== id && key(f.name) === key(name))) {
          return fail(409, 'An item with this name already exists. Choose another name.');
        }
        folder.name = name;
        return ok(folder);
      }
      if (method === 'DELETE') {
        if (folder.system) return fail(409, 'Inbox can’t be deleted.');
        if (state.materials.some((m) => m.folder_id === id)) {
          return fail(409, 'This folder still has materials. Move or delete them first.');
        }
        state.folders = state.folders.filter((f) => f.id !== id);
        return ok(null, 204);
      }
    }
    if (method === 'GET' && path === '/kb/materials') {
      const folderId = req.query?.folder_id;
      return ok(folderId ? state.materials.filter((m) => m.folder_id === folderId) : state.materials);
    }
    const matMatch = /^\/kb\/materials\/([^/]+)$/.exec(path);
    if (method === 'GET' && matMatch) {
      const found = state.materials.find((m) => m.id === decodeURIComponent(matMatch[1] ?? ''));
      if (!found) return fail(404, 'Material not found.');
      return ok({ ...found, origin: null, fragments: [
        { id: `${found.id}-1`, seg: 1, text: 'First paragraph of the source.', start_ms: 492_000, end_ms: 500_000, speaker: 'Speaker 1', page: null, index: null },
      ] });
    }
    if (method === 'GET' && path === '/kb/notifications') {
      return ok(req.query?.include_dismissed ? state.notifications : state.notifications.filter((n) => !n.dismissed_at));
    }
    return fail(0, `method/path not allowed: ${method} ${path}`);
  });
  let quitListener: (() => Promise<boolean>) | null = null;
  return {
    state,
    b2,
    calls,
    /** What the renderer answers when main asks it to save before quitting (null = no listener). */
    prepareQuit: async () => (quitListener ? quitListener() : null),
    /** The mock behind `bridge.request`, for one-off failures in a test. */
    requestMock: request,
    bridge: {
      request: request as unknown as <T = unknown>(req: BridgeRequest) => Promise<JsonResponse<T>>,
      chooseStorageRoot: vi.fn(async () => '/Users/me/Notes'),
      chooseMaterialFiles: vi.fn(async () => [{ path: '/Users/me/Downloads/paper.pdf', name: 'paper.pdf', size: 120_000 }]),
      saveTextFile: vi.fn(async (file: { suggested_name: string; text: string }) => ({ saved: true, path: `/Users/me/Downloads/${file.suggested_name}` })),
      ...(b2 ? { dictate: vi.fn(fakeDictate(b2)) } : {}),
      reportCaptureState: vi.fn(),
      onPrepareQuit: vi.fn((listener: () => Promise<boolean>) => {
        quitListener = listener;
        return () => { if (quitListener === listener) quitListener = null; };
      }),
    },
  };
}
