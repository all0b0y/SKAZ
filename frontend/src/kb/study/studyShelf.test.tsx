import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HttpMethod } from '../../api/bridge';
import { serveFake, type FakeWorld } from '../test/fakeKb';
import { studyWorld } from '../test/fixtures';
import { renderKb } from '../test/renderKb';

// N4-7, N4-8: decks and tests are listed apart from the wiki's pages, archived tests are hidden, a learned
// deck only gets a suggestion, and deleting one says the mistake history goes too. The fake stands on the
// HTTP seam; backend/tests/knowledge/test_s0_study_separation.py owns the rules themselves.

const call = (w: FakeWorld, method: HttpMethod, path: string) => serveFake(w, { method, path });

function worldWithTests(): FakeWorld {
  const w = studyWorld();
  const deck = w.pages.find((p) => p.id === 'p-deck')!;
  w.pages.push({ ...deck, id: 'p-test', kind: 'test', title: 'Second law check', blocks: [] });
  w.pages.push({ ...deck, id: 'p-old', kind: 'test', title: 'Old midterm', blocks: [] });
  w.studyShelf = {
    'p-old': { opened_at: '2026-01-01T10:00:00Z', archived_at: '2026-03-02T10:00:00Z', archived_by: 'auto', suggest_archive: false },
  };
  return w;
}

async function studyPanel(world = worldWithTests()) {
  const rendered = renderKb({ world, prefs: { section: 'wiki', wikiOpen: { concept: true, note: false, analysis: false, folder: false, deck: true, test: true } } });
  const side = await screen.findByRole('region', { name: 'Wiki' });
  await within(side).findByRole('heading', { name: 'Study', level: 3 });
  return { ...rendered, side, user: userEvent.setup() };
}

describe('Fake backend: the /kb/study-library routes', () => {
  it('lists decks and tests apart from the wiki pages, and answers 404 for a wiki page', () => {
    const w = worldWithTests();
    const listed = (call(w, 'GET', '/kb/study-library') as { data: { decks: Array<{ page_id: string }>; tests: Array<{ page_id: string }>; archived: Array<{ page_id: string }> } }).data;
    expect(listed.decks.map((d) => d.page_id)).toEqual(['p-deck']);
    expect(listed.tests.map((t) => t.page_id)).toEqual(['p-test']);
    expect(listed.archived.map((t) => t.page_id)).toEqual(['p-old']);
    const pages = (call(w, 'GET', '/kb/wiki/pages') as { data: Array<{ kind: string }> }).data;
    expect(pages.filter((p) => p.kind === 'deck' || p.kind === 'test')).toEqual([]);
    const concept = w.pages.find((p) => p.kind !== 'deck' && p.kind !== 'test')!;
    expect(call(w, 'POST', `/kb/study-library/${concept.id}/archive`)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('Study in the side panel', () => {
  it('shows decks and tests under Study, with no archived test in the lists', async () => {
    const { side } = await studyPanel();
    expect(await within(side).findByRole('button', { name: 'Thermodynamics' })).toBeInTheDocument();
    expect(within(side).getByRole('button', { name: 'Second law check' })).toBeInTheDocument();
    expect(within(side).queryByRole('button', { name: 'Old midterm' })).not.toBeInTheDocument();
    expect(within(side).getByRole('button', { name: /^Archived\s*1$/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('an archived test is brought back from its fold and is in the list again', async () => {
    const { side, user, fake } = await studyPanel();
    await user.click(await within(side).findByRole('button', { name: /^Archived\s*1$/ }));
    await user.click(await within(side).findByRole('button', { name: 'Bring back Old midterm' }));
    expect(await within(side).findByRole('button', { name: 'Old midterm' })).toBeInTheDocument();
    expect(within(side).queryByRole('button', { name: /^Archived/ })).not.toBeInTheDocument();
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/study-library/p-old/unarchive')).toBe(true);
  });

  it('a learned deck left alone only gets a suggestion; Not now quiets it and nothing is archived', async () => {
    const world = worldWithTests();
    world.studyShelf!['p-deck'] = { opened_at: '2026-01-01T10:00:00Z', archived_at: null, archived_by: null, suggest_archive: true };
    const { side, user } = await studyPanel(world);
    const hint = await within(side).findByText(/All learned and not opened for a long time/);
    await user.click(within(side).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(hint).not.toBeInTheDocument());
    expect(within(side).getByRole('button', { name: 'Thermodynamics' })).toBeInTheDocument();
  });

  it('Archive on the suggestion moves the deck to the fold', async () => {
    const world = worldWithTests();
    world.studyShelf!['p-deck'] = { opened_at: '2026-01-01T10:00:00Z', archived_at: null, archived_by: null, suggest_archive: true };
    const { side, user } = await studyPanel(world);
    await within(side).findByText(/All learned/);
    await user.click(within(side).getByRole('button', { name: 'Archive' }));
    expect(await within(side).findByRole('button', { name: /^Archived\s*2$/ })).toBeInTheDocument();
    expect(within(side).queryByRole('button', { name: 'Thermodynamics' })).not.toBeInTheDocument();
  });

  it('opening a deck or test page tells the backend, and a test page too', async () => {
    const { side, user, fake } = await studyPanel();
    await user.click(await within(side).findByRole('button', { name: 'Second law check' }));
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/study-library/p-test/opened')).toBe(true));
    await user.click(within(side).getByRole('button', { name: 'Thermodynamics' }));
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/study-library/p-deck/opened')).toBe(true));
  });

  it('the delete confirmation of a test says the mistake history goes too', async () => {
    const { side, user } = await studyPanel();
    await user.click(await within(side).findByRole('button', { name: 'Second law check' }));
    await user.click(await screen.findByRole('button', { name: /more|Page actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    const dialog = await screen.findByTestId('delete-page');
    expect(await within(dialog).findByText(/mistake history goes too/)).toBeInTheDocument();
  });
});
