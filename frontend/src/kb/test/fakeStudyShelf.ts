// N4-7, N4-8 in the shared fake backend: saved decks and tests apart from the wiki's pages, in the shapes
// of the generated contract. A fake on the HTTP seam: it proves the UI's handling of these answers, not
// the rules (backend/tests/knowledge/test_s0_study_separation.py owns those).

import type { KbPage, KbStudyLibrary, KbStudyShelfEntry } from '../../api/kb/types.gen';
import type { FakeRoutes, FakeWorld } from './fakeKb';

export type FakeShelfRow = Pick<KbStudyShelfEntry, 'opened_at' | 'archived_at' | 'archived_by' | 'suggest_archive'>;

const isStudy = (page: KbPage): page is KbPage & { kind: 'deck' | 'test' } => page.kind === 'deck' || page.kind === 'test';

function entry(world: FakeWorld, page: KbPage & { kind: 'deck' | 'test' }): KbStudyShelfEntry {
  const row = world.studyShelf?.[page.id] ?? { opened_at: '2026-11-01T10:00:00Z', archived_at: null, archived_by: null, suggest_archive: false };
  return { page_id: page.id, kind: page.kind, title: page.title, folders: page.folders, ...row };
}

function library(world: FakeWorld): KbStudyLibrary {
  const all = world.pages.filter(isStudy).map((page) => entry(world, page));
  const shown = all.filter((item) => item.archived_at === null);
  return {
    decks: shown.filter((item) => item.kind === 'deck'),
    tests: shown.filter((item) => item.kind === 'test'),
    archived: all.filter((item) => item.archived_at !== null),
  };
}

export function studyShelfRoutes(fail: (status: number, detail: string) => never): FakeRoutes {
  const change = (world: FakeWorld, id: string, patch: Partial<FakeShelfRow>): KbStudyShelfEntry => {
    const page = world.pages.find((p) => p.id === id);
    if (!page || !isStudy(page)) fail(404, 'This page is not a deck or a test.');
    const before = entry(world, page as KbPage & { kind: 'deck' | 'test' });
    world.studyShelf = { ...world.studyShelf, [id]: {
      opened_at: before.opened_at, archived_at: before.archived_at, archived_by: before.archived_by,
      suggest_archive: before.suggest_archive, ...patch,
    } };
    return entry(world, page as KbPage & { kind: 'deck' | 'test' });
  };
  const back = { archived_at: null, archived_by: null, opened_at: '2026-11-09T10:00:00Z' };
  return {
    'GET /kb/study-library': [200, (w) => library(w)],
    'POST /kb/study-library/{page_id}/opened': [200, (w, { path }) => change(w, path.page_id, back)],
    'POST /kb/study-library/{page_id}/unarchive': [200, (w, { path }) => change(w, path.page_id, back)],
    'POST /kb/study-library/{page_id}/archive': [200, (w, { path }) =>
      change(w, path.page_id, { archived_at: '2026-11-09T10:00:00Z', archived_by: 'user', suggest_archive: false })],
    'POST /kb/study-library/{page_id}/keep': [200, (w, { path }) => change(w, path.page_id, { suggest_archive: false })],
    'GET /kb/study-library/{page_id}/delete-warning': [200, (w, { path }) => {
      const page = w.pages.find((p) => p.id === path.page_id);
      if (!page || !isStudy(page)) fail(404, 'This page is not a deck or a test.');
      return { text: `Its mistake history goes too: SKAZ can no longer build a test on your mistakes from this ${page!.kind}. This can't be undone.`, attempts: 0, reviews: 0 };
    }],
  };
}
