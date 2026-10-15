// A whole fake backend for the browser smoke (scripts/kb-u2.smoke.spec.ts): the package-1 routes
// the window needs (library, folders, materials, pages) plus the package-2 world of fakeB2.ts.
// Pure — no test runner imports. A fake on the external seam: it shows the UI's handling of
// contract-shaped answers; the real backend is exercised by the Electron smoke (kb-shell).

import type { BridgeApi, BridgeRequest, JsonResponse } from '../../api/bridge';
import type { KbFolder, KbMaterialSummary, KbPage } from '../../api/kb/types.gen';
import { b2State, fakeDictate, FOLDERS, handleB2, iso, PAGES, type FakeB2State } from './fakeB2';

const ok = <T,>(data: T, status = 200): JsonResponse<T> => ({ ok: true, status, data });
const fail = (status: number, detail: string): JsonResponse<never> => ({ ok: false, status, detail });

export interface BrowserFake {
  b2: FakeB2State;
  bridge: Pick<BridgeApi, 'request'> & Partial<BridgeApi>;
}

export function createBrowserFake(b2: FakeB2State = b2State()): BrowserFake {
  const folders: KbFolder[] = [
    { id: 'inbox', name: 'Inbox', system: true, material_count: 1, created_at: iso(60 * 72) },
    { id: 'phys', name: FOLDERS.phys, system: false, material_count: 1, created_at: iso(60 * 70) },
    { id: 'info', name: FOLDERS.info, system: false, material_count: 1, created_at: iso(60 * 69) },
    { id: 'ml', name: FOLDERS.ml, system: false, material_count: 2, created_at: iso(60 * 68) },
  ];
  const summary = (id: string, title: string, kind: KbMaterialSummary['kind'], folder: string, minutesAgo: number): KbMaterialSummary => ({
    id, title, kind, status: 'ready', folder_id: folder, languages: ['en'], created_at: iso(minutesAgo), fragment_count: 3,
  });
  const materials: KbMaterialSummary[] = [
    summary('m1', 'Lecture 8 — entropy', 'recording', 'phys', 130),
    summary('m2', 'Textbook: Information theory, ch. 2', 'pdf', 'info', 60 * 27),
    summary('m4', 'Cross-entropy explained', 'web', 'ml', 70),
    summary('m5', 'Lecture 5 — classifiers', 'recording', 'ml', 60 * 50),
    summary('m3', 'Pasted text: problems', 'text', 'inbox', 60 * 5),
  ];
  const text: Record<string, string[]> = {
    m1: ['Boltzmann wrote entropy as S = k·ln W.', 'Why a logarithm? Because the entropies of two independent systems should add up.'],
    m5: ['A classifier outputs probabilities.', 'The cross-entropy loss punishes confident mistakes.', 'This is Shannon entropy applied to the model’s error.'],
  };
  const page = (id: string): KbPage | null => {
    const ref = Object.values(PAGES).find((p) => p.id === id) ?? (id.startsWith('p-') ? { id, kind: 'analysis' as const, title: 'Saved answer' } : null);
    if (!ref) return null;
    return {
      id: ref.id, kind: ref.kind, title: ref.title, original: null, aliases: [], folders: ['phys', 'info', 'ml'], sources: ['m1', 'm2'], language: 'en',
      blocks: [
        { id: 'b1', kind: 'from_source', owner: 'agent', marked: false, section: null, text: 'Entropy is a measure of the disorder of a system.', hash: 'h1', citations: [] },
        { id: 'b2', kind: 'from_source', owner: 'agent', marked: false, section: null, text: 'In information theory it is the average uncertainty of a random variable.', hash: 'h2', citations: [] },
      ],
    };
  };

  const request = async <T = unknown>(req: BridgeRequest): Promise<JsonResponse<T>> => {
    const { method, path } = req;
    const answer = ((): JsonResponse<unknown> => {
      if (method === 'GET' && path === '/kb/library') {
        return ok({ state: 'ready', root: '/Users/me/Documents/SKAZ', suggested_root: '/Users/me/Documents/SKAZ', reason: null, library_id: 'lib1' });
      }
      if (method === 'GET' && path === '/kb/folders') return ok(folders);
      if (method === 'GET' && path === '/kb/materials') {
        const folder = req.query?.folder_id;
        return ok(folder ? materials.filter((m) => m.folder_id === folder) : materials);
      }
      let m = /^\/kb\/materials\/([^/]+)$/.exec(path);
      if (method === 'GET' && m) {
        const found = materials.find((x) => x.id === decodeURIComponent(m![1]!));
        if (!found) return fail(404, 'Material not found.');
        const lines = text[found.id] ?? ['First paragraph of the source.', 'Second paragraph.'];
        return ok({
          ...found, origin: null,
          fragments: lines.map((t, i) => ({
            id: `${found.id}-${i + 1}`, seg: i + 1, text: t, start_ms: found.kind === 'recording' ? 2_600_000 + i * 20_000 : null,
            end_ms: null, speaker: found.kind === 'recording' ? 'Speaker 1' : null, page: found.kind === 'pdf' ? 31 : null, index: i,
          })),
        });
      }
      m = /^\/kb\/wiki\/pages\/([^/]+)$/.exec(path);
      if (method === 'GET' && m) {
        const p = page(decodeURIComponent(m[1]!));
        return p ? ok(p) : fail(404, 'Page not found.');
      }
      return handleB2(b2, req) ?? fail(404, `Not found: ${method} ${path}`);
    })();
    // A real round trip is never instant.
    await new Promise((r) => setTimeout(r, 30));
    return answer as JsonResponse<T>;
  };

  return {
    b2,
    bridge: {
      request,
      dictate: fakeDictate(b2),
      saveTextFile: async (file) => ({ saved: true, path: `/Users/me/Downloads/${file.suggested_name}` }),
      chooseMaterialFiles: async () => [{ path: '/Users/me/Downloads/paper.pdf', name: 'paper.pdf', size: 120_000 }],
      chooseStorageRoot: async () => '/Users/me/Notes',
    },
  };
}
