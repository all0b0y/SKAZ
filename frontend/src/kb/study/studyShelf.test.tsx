import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HttpMethod } from '../../api/bridge';
import { serveFake, type FakeWorld } from '../test/fakeKb';
import { baseWorld } from '../test/fakeBridge';
import { studyWorld } from '../test/fixtures';
import { renderKb, storedPrefs } from '../test/renderKb';

// N4-7, N4-8, F6: Study has its own rail section; decks and tests are listed apart from the wiki's pages,
// archived items are hidden in a fold, a learned deck only gets an "Archive suggested" prompt, and deleting
// one says the mistake history goes too. The fake stands on the HTTP seam;
// backend/tests/knowledge/test_s0_study_separation.py owns the rules themselves.

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
  const rendered = renderKb({ world, prefs: { section: 'study' } });
  const side = await screen.findByRole('region', { name: 'Study' });
  await within(side).findByRole('heading', { name: 'Study', level: 2 });
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

describe('Study section in the rail and side panel', () => {
  it('switches from Wiki to Study via the rail item, persists the section, and keeps Study out of Wiki', async () => {
    const user = userEvent.setup();
    renderKb({ world: worldWithTests(), prefs: { section: 'wiki' } });
    const wikiSide = await screen.findByRole('region', { name: 'Wiki' });
    await within(wikiSide).findByRole('heading', { name: 'Sections', level: 3 });
    expect(within(wikiSide).queryByRole('heading', { name: 'Study' })).not.toBeInTheDocument();
    expect(within(wikiSide).queryByRole('button', { name: /^Decks/ })).not.toBeInTheDocument();
    expect(within(wikiSide).queryByRole('button', { name: /^Tests/ })).not.toBeInTheDocument();

    const rail = screen.getByRole('navigation', { name: 'Sections' });
    const studyBtn = within(rail).getByRole('button', { name: /^Study/ });
    await user.click(studyBtn);

    const side = await screen.findByRole('region', { name: 'Study' });
    expect(studyBtn).toHaveAttribute('aria-current', 'page');
    expect(storedPrefs().section).toBe('study');
    expect(await within(side).findByRole('button', { name: 'Thermodynamics' })).toBeInTheDocument();
    expect(within(side).getByRole('button', { name: 'Second law check' })).toBeInTheDocument();
  });

  it('shows decks and tests open under Study, with no archived test in the active lists', async () => {
    const { side, user } = await studyPanel();
    expect(await within(side).findByRole('button', { name: 'Thermodynamics' })).toBeInTheDocument();
    expect(within(side).getByRole('button', { name: 'Second law check' })).toBeInTheDocument();
    expect(within(side).queryByRole('button', { name: 'Old midterm' })).not.toBeInTheDocument();

    const decksFold = within(side).getByRole('button', { name: /^Decks\s*1$/ });
    const testsFold = within(side).getByRole('button', { name: /^Tests\s*1$/ });
    const archivedFold = within(side).getByRole('button', { name: /^Archived\s*1$/ });
    expect(decksFold).toHaveAttribute('aria-expanded', 'true');
    expect(testsFold).toHaveAttribute('aria-expanded', 'true');
    expect(archivedFold).toHaveAttribute('aria-expanded', 'false');

    await user.click(decksFold);
    expect(decksFold).toHaveAttribute('aria-expanded', 'false');
    const decksBody = document.getElementById(decksFold.getAttribute('aria-controls')!)!;
    expect(decksBody.querySelector('.kb-fold__in')).toHaveAttribute('inert');
  });

  it('shows empty states when no decks or tests are saved yet', async () => {
    const { side } = await studyPanel(baseWorld());
    expect(await within(side).findByText('No decks yet')).toBeInTheDocument();
    expect(within(side).getByText('No tests yet')).toBeInTheDocument();
    expect(within(side).getByText(/Concepts and terms stay in the wiki/)).toBeInTheDocument();
  });

  it('an archived test shows why it was archived and is brought back from its fold to the active list', async () => {
    const { side, user, fake } = await studyPanel();
    await user.click(await within(side).findByRole('button', { name: /^Archived\s*1$/ }));
    expect(within(side).getByText('Auto-archived after 60 days')).toBeInTheDocument();
    await user.click(await within(side).findByRole('button', { name: 'Bring back Old midterm' }));
    expect(await within(side).findByRole('button', { name: 'Old midterm' })).toBeInTheDocument();
    expect(within(side).queryByRole('button', { name: /^Archived/ })).not.toBeInTheDocument();
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/study-library/p-old/unarchive')).toBe(true);
  });

  it('a learned deck left alone gets an "Archive suggested" prompt; Not now quiets it and nothing is archived', async () => {
    const world = worldWithTests();
    world.studyShelf!['p-deck'] = { opened_at: '2026-01-01T10:00:00Z', archived_at: null, archived_by: null, suggest_archive: true };
    const { side, user, fake } = await studyPanel(world);
    expect(await within(side).findByText('Archive suggested')).toBeInTheDocument();
    const hint = await within(side).findByText(/All learned and not opened for a long time/);
    await user.click(within(side).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(hint).not.toBeInTheDocument());
    expect(within(side).getByRole('button', { name: 'Thermodynamics' })).toBeInTheDocument();
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/study-library/p-deck/keep')).toBe(true);
  });

  it('Archive on the suggestion moves the deck to the Archived fold as archived by you', async () => {
    const world = worldWithTests();
    world.studyShelf!['p-deck'] = { opened_at: '2026-01-01T10:00:00Z', archived_at: null, archived_by: null, suggest_archive: true };
    const { side, user } = await studyPanel(world);
    await within(side).findByText('Archive suggested');
    await user.click(within(side).getByRole('button', { name: 'Archive' }));
    const archivedFold = await within(side).findByRole('button', { name: /^Archived\s*2$/ });
    expect(within(side).queryByRole('button', { name: 'Thermodynamics' })).not.toBeInTheDocument();
    await user.click(archivedFold);
    expect(within(side).getByText('Archived by you')).toBeInTheDocument();
  });

  it('opening a deck or test page marks the row current and tells the backend', async () => {
    const { side, user, fake } = await studyPanel();
    const testBtn = await within(side).findByRole('button', { name: 'Second law check' });
    await user.click(testBtn);
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/study-library/p-test/opened')).toBe(true));
    expect(testBtn).toHaveAttribute('aria-current', 'true');
    const deckBtn = within(side).getByRole('button', { name: 'Thermodynamics' });
    await user.click(deckBtn);
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/kb/study-library/p-deck/opened')).toBe(true));
    expect(deckBtn).toHaveAttribute('aria-current', 'true');
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

