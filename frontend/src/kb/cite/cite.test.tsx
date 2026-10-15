// Sources as footnote numbers (v42 variant A): duplicates merged, numbers stable per answer/page,
// the popup shows the exact quote and opens the material at it.
import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KbCitation } from '../../api/kb/types.gen';
import { createServices, KbServicesProvider } from '../state/context';
import { openTarget } from '../state/document';
import { MotionProvider } from '../ui';
import { createFakeBridge } from '../test/fakeBridge';
import { chatWorld } from '../test/fixtures';
import { excerpt } from './fragments';
import { SourceMarks, SourcesProvider, SourcesRow } from './SourceMarks';
import { claimSources, indexSources } from './sources';

const doc = (id: string, title: string, seg: number, page: number, quote: string | null, available = true): KbCitation => ({
  material_id: id, seg, available, material_title: title, start_ms: null, end_ms: null, page, quote,
});
const rec = (id: string, title: string, seg: number, startMs: number, quote: string | null): KbCitation => ({
  material_id: id, seg, available: true, material_title: title, start_ms: startMs, end_ms: startMs + 4000, page: null, quote,
});

const SEMINAR = 'Seminar Assignment 2 - The Maplewood Boardroom Dilemma';
const A = doc('s1', SEMINAR, 1, 1, 'Your team acts as Senior Strategic Consultants.');
const G = doc('s1', SEMINAR, 2, 1, 'Maplewood Pension Fund, established in 2004, manages €400 million.');
const F = doc('s2', 'BlackRock Investment Stewardship Report 2025', 7, 14, 'In 2025 the firm withdrew from the initiative.');

function harness(ui: React.ReactNode) {
  return harnessWith(ui).services;
}

function harnessWith(ui: React.ReactNode) {
  const fake = createFakeBridge(chatWorld());
  const services = createServices(fake.bridge, null, { capture: null });
  render(<KbServicesProvider services={services}><MotionProvider>{ui}</MotionProvider></KbServicesProvider>);
  return { services, fake };
}

describe('Source numbering', () => {
  it('merges duplicates: seven identical citations of one document are one number with one quote', () => {
    const index = indexSources([G, G, G, A, A, A, A]);
    expect(index.list.map((e) => [e.n, e.key, e.quotes.length])).toEqual([[1, 's1', 2]]);
    const claim = claimSources([G, G, G, A, A, A, A], index);
    expect(claim).toHaveLength(1);
    expect(claim[0]!.quotes.map((q) => q.seg)).toEqual([2, 1]);
  });

  it('numbers documents in the order they first appear; the same document keeps its number', () => {
    const index = indexSources([A, F, G, A]);
    expect(index.list.map((e) => `${e.n}:${e.key}`)).toEqual(['1:s1', '2:s2']);
    // A later claim citing the second document first still shows 2 then 1.
    expect(claimSources([F, G], index).map((c) => c.entry.n)).toEqual([2, 1]);
    expect(claimSources([G], index)[0]!.quotes).toEqual([G]);
  });

  it('a removed source stays numbered but is marked unavailable', () => {
    const gone = doc('s3', 'Old notes', 1, 2, 'gone words', false);
    const index = indexSources([A, gone]);
    expect(index.byKey.get('s3')).toMatchObject({ n: 2, available: false });
  });
});

describe('Source marks and popup', () => {
  it('a claim shows one number per document; hover shows title, page and the exact quote', async () => {
    const user = userEvent.setup();
    const index = indexSources([G, G, A, F, A]);
    harness(
      <SourcesProvider index={index}>
        <p>The fund manages €400 million.<SourceMarks citations={[G, G, A, A]} /></p>
        <p>It withdrew.<SourceMarks citations={[F, A]} /></p>
      </SourcesProvider>,
    );
    const marks = screen.getAllByRole('button', { name: /^Source \d/ });
    expect(marks.map((m) => m.textContent)).toEqual(['1', '2', '1']);
    expect(marks[0]).toHaveAccessibleName(`Source 1: ${SEMINAR}`);
    expect(marks[1]).toHaveAccessibleName('Source 2: BlackRock Investment Stewardship Report 2025');
    // No chip runs in the text any more.
    expect(document.querySelector('.kb-chip')).toBeNull();

    await user.hover(marks[0]!);
    const pop = await screen.findByRole('dialog', { name: SEMINAR });
    expect(within(pop).getByText(SEMINAR)).toBeInTheDocument();
    const quotes = Array.from(pop.querySelectorAll('blockquote')).map((q) => q.textContent);
    expect(quotes).toEqual([G.quote, A.quote]);
    expect(within(pop).getAllByText('p. 1')).toHaveLength(2);
    expect(within(pop).getAllByRole('button', { name: /^Open at quote/ })).toHaveLength(2);
    await user.unhover(marks[0]!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('"Open at quote" opens the material at the fragment with the quote marked', async () => {
    const user = userEvent.setup();
    const services = harness(<p>Claim<SourceMarks citations={[G, A]} /></p>);
    await user.click(screen.getByRole('button', { name: /^Source 1/ }));
    const pop = await screen.findByRole('dialog', { name: SEMINAR });
    const opens = within(pop).getAllByRole('button', { name: /^Open at quote/ });
    await user.click(opens[1]!);
    expect(openTarget(services.ui.getState())).toEqual({ type: 'material', id: 's1', seg: 1, quote: A.quote });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('a recording shows ▶ and the time instead of a page', async () => {
    const user = userEvent.setup();
    harness(<p>Claim<SourceMarks citations={[rec('m5', 'Lecture 5', 3, 2_640_000, 'cross-entropy')]} /></p>);
    await user.hover(screen.getByRole('button', { name: 'Source 1: Lecture 5' }));
    const pop = await screen.findByRole('dialog', { name: 'Lecture 5' });
    expect(within(pop).getByText('44:00')).toBeInTheDocument();
    expect(within(pop).queryByText(/^p\./)).not.toBeInTheDocument();
    expect(pop.querySelector('[data-icon="play"]')).not.toBeNull();
  });

  it('a removed source: muted dashed number, the popup says it is gone and offers no opening', async () => {
    const user = userEvent.setup();
    harness(<p>Claim<SourceMarks citations={[doc('s3', 'Old notes', 1, 2, 'gone words', false)]} /></p>);
    const mark = screen.getByRole('button', { name: 'Source 1: Old notes (no longer available)' });
    expect(mark).toHaveClass('is-gone');
    await user.click(mark);
    const pop = await screen.findByRole('dialog', { name: 'Old notes' });
    expect(within(pop).getByText('This source is no longer available.')).toBeInTheDocument();
    expect(within(pop).queryByRole('button', { name: /Open at quote/ })).not.toBeInTheDocument();
  });

  it('keyboard: focus peeks, Enter pins and moves focus in, Escape closes and focus returns', async () => {
    const user = userEvent.setup();
    harness(<><button type="button">before</button><p>Claim<SourceMarks citations={[A]} /></p></>);
    await user.click(screen.getByRole('button', { name: 'before' }));
    await user.tab();
    const mark = screen.getByRole('button', { name: /^Source 1/ });
    expect(mark).toHaveFocus();
    expect(await screen.findByRole('dialog', { name: SEMINAR })).toBeInTheDocument();
    expect(mark).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Enter}');
    const pop = screen.getByRole('dialog', { name: SEMINAR });
    await waitFor(() => expect(within(pop).getByRole('button', { name: /^Open at quote/ })).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mark).toHaveFocus();
    expect(mark).toHaveAttribute('aria-expanded', 'false');
    // Escape also closes a peek without pinning.
    await user.tab({ shift: true });
    await user.tab();
    expect(await screen.findByRole('dialog', { name: SEMINAR })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('a click pins the popup: leaving the mark keeps it, an outside click closes it', async () => {
    const user = userEvent.setup();
    harness(<><p>Claim<SourceMarks citations={[A]} /></p><button type="button">elsewhere</button></>);
    const mark = screen.getByRole('button', { name: /^Source 1/ });
    await user.click(mark);
    await user.unhover(mark);
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    expect(screen.getByRole('dialog', { name: SEMINAR })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('the Sources row lists each document once with its number and opens all its quotes', async () => {
    const user = userEvent.setup();
    const index = indexSources([G, A, F, G]);
    harness(<SourcesRow index={index} />);
    const row = screen.getByRole('group', { name: 'Sources' });
    const items = within(row).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual([`1${SEMINAR}`, '2BlackRock Investment Stewardship Report 2025']);
    await user.click(items[0]!);
    const pop = await screen.findByRole('dialog', { name: SEMINAR });
    expect(pop.querySelectorAll('blockquote')).toHaveLength(2);
  });

  it('no exact words: the popup shows the cited fragment (read lazily, once per material), "Open at fragment"', async () => {
    const user = userEvent.setup();
    const bare = rec('m5', 'Lecture 5', 3, 2_640_000, null);
    const other = rec('m5', 'Lecture 5', 2, 2_620_000, null);
    const { services, fake } = harnessWith(<><p>One<SourceMarks citations={[bare]} /></p><p>Two<SourceMarks citations={[other]} /></p></>);
    const reads = () => fake.calls.filter((c) => c.method === 'GET' && c.path === '/kb/materials/m5').length;
    expect(reads()).toBe(0); // nothing is read before a popup opens
    const [first, second] = screen.getAllByRole('button', { name: 'Source 1: Lecture 5' });
    await user.hover(first!);
    const pop = await screen.findByRole('dialog', { name: 'Lecture 5' });
    expect(within(pop).getByText('Fragment')).toBeInTheDocument();
    expect(await within(pop).findByText('This is Shannon entropy applied to the model’s error.')).toBeInTheDocument();
    expect(pop.querySelector('blockquote')).toBeNull();
    await user.unhover(first!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.hover(second!);
    expect(await within(await screen.findByRole('dialog', { name: 'Lecture 5' })).findByText('The cross-entropy loss punishes confident mistakes.')).toBeInTheDocument();
    expect(reads()).toBe(1); // cached per material
    await user.click(second!);
    await user.click(within(screen.getByRole('dialog', { name: 'Lecture 5' })).getByRole('button', { name: 'Open at fragment, 43:40' }));
    expect(openTarget(services.ui.getState())).toEqual({ type: 'material', id: 'm5', seg: 2 });
  });

  it('no exact words and the fragment cannot be read: says so, still opens at the fragment', async () => {
    const user = userEvent.setup();
    harness(<p>Claim<SourceMarks citations={[rec('m5', 'Lecture 5', 99, 1000, null)]} /></p>);
    await user.click(screen.getByRole('button', { name: 'Source 1: Lecture 5' }));
    const pop = await screen.findByRole('dialog', { name: 'Lecture 5' });
    expect(await within(pop).findByText('The fragment’s text couldn’t be read.')).toBeInTheDocument();
    expect(within(pop).getByRole('button', { name: /^Open at fragment/ })).toBeInTheDocument();
  });

  it('a fragment excerpt is about 300 characters, cut at a word', () => {
    const long = 'word '.repeat(200);
    const cut = excerpt(long);
    expect(cut.length).toBeLessThanOrEqual(301);
    expect(cut.endsWith('word…')).toBe(true);
    expect(excerpt('  short\n text ')).toBe('short text');
  });
});
