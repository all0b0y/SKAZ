import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';

async function openPage(id: string) {
  const r = renderKb({ world: docWorld() });
  await screen.findByRole('navigation', { name: 'Sections' });
  act(() => r.services.ui.getState().openDocument({ type: 'page', id }));
  const doc = await screen.findByRole('complementary', { name: 'Document' });
  return { ...r, doc };
}

describe('Wiki page (v7–v8, decisions 20–22)', () => {
  it('shows type, title, folder tags, meta and sections with statement labels of their own shape', async () => {
    const { doc } = await openPage('p-entropy');
    expect(await within(doc).findByRole('heading', { level: 2, name: 'Entropy' })).toBeInTheDocument();
    expect(within(doc).getByText('Concept')).toBeInTheDocument();
    for (const name of ['Physics', 'Information theory', 'Machine learning']) expect(within(doc).getByText(name)).toBeInTheDocument();
    expect(within(doc).getByText(/3 folders · 3 sources · updated/)).toBeInTheDocument();
    for (const label of ['From sources', 'Connection — agent inference', 'My note', 'Edited by you']) {
      expect(within(doc).getAllByText(label).length).toBeGreaterThan(0);
    }
    // Labels are not colour only: each carries its own marker for its kind.
    expect(doc.querySelector('[data-claim="connection"] [data-icon="graph"]')).not.toBeNull();
    // Citation wikilinks are not printed as text: the source is a footnote number (v42 A).
    expect(within(doc).queryByText(/\[\[Materials/)).not.toBeInTheDocument();
    expect(doc.querySelector('.kb-block__cites .kb-chip')).toBeNull();
    const marks = Array.from(doc.querySelectorAll('.kb-block__cites .kb-cn'));
    expect(marks.map((m) => m.getAttribute('aria-label'))).toEqual(['Source 1: Lecture 8 — entropy', 'Source 2: Textbook', 'Source 3: Lecture 5']);
    // The page ends with its sources, each once.
    const sources = within(doc).getByRole('group', { name: 'Sources' });
    expect(within(sources).getAllByRole('button').map((b) => b.textContent)).toEqual(['1Lecture 8 — entropy', '2Textbook', '3Lecture 5']);
    // Related and Mentioned in.
    expect(within(doc).getByRole('heading', { name: 'Related' })).toBeInTheDocument();
    expect(within(doc).getByRole('heading', { name: 'Mentioned in' })).toBeInTheDocument();
  });

  it('collapses a section and opens it again', async () => {
    const user = userEvent.setup();
    const { doc } = await openPage('p-entropy');
    const toggle = await within(doc).findByRole('button', { name: /In materials/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(doc).queryByText(/A measure of disorder/)).not.toBeInTheDocument();
    await user.click(toggle);
    expect(within(doc).getByText(/A measure of disorder/)).toBeInTheDocument();
  });

  it('a source number opens the material at that fragment with exactly the checked quote marked', async () => {
    const user = userEvent.setup();
    const { doc } = await openPage('p-entropy');
    await user.click((await within(doc).findAllByRole('button', { name: 'Source 1: Lecture 8 — entropy' }))[0]!);
    const pop = await screen.findByRole('dialog', { name: 'Lecture 8 — entropy' });
    expect(within(pop).getByText('S equals k times the log of W')).toBeInTheDocument();
    await user.click(within(pop).getByRole('button', { name: 'Open at quote, 08:12' }));
    expect(await within(doc).findByRole('heading', { level: 2, name: 'Lecture 8 — entropy' })).toBeInTheDocument();
    const mark = await waitFor(() => {
      const el = doc.querySelector('mark.kb-quote');
      if (!el) throw new Error('no quote yet');
      return el;
    });
    expect(mark).toHaveTextContent('S equals k times the log of W');
    // A citation is checked against the original words: the original is shown, not the translation.
    expect(within(doc).getByRole('radio', { name: 'Original' })).toHaveAttribute('aria-checked', 'true');
    expect(mark.closest('[data-seg]')).toHaveAttribute('data-seg', '1');
  });

  it('✎ makes an agent block yours ("Edited by you"); re-check asks the agent', async () => {
    const user = userEvent.setup();
    const { doc, fake } = await openPage('p-entropy');
    const block = (await within(doc).findByText(/Boltzmann’s and Shannon’s formulas/)).closest('[data-block-id]') as HTMLElement;
    await user.click(within(block).getByRole('button', { name: 'Edit block' }));
    const box = within(block).getByRole('textbox', { name: 'Block text' });
    expect(within(block).getByText(/becomes yours/)).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, 'Both formulas share one form.');
    await user.click(within(block).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(block).getByText('Edited by you')).toBeInTheDocument());
    expect(fake.calls.some((c) => c.method === 'PUT' && c.path === '/kb/wiki/pages/p-entropy/blocks/b5')).toBe(true);
    await user.click(within(block).getByRole('button', { name: /Ask the agent to re-check/ }));
    await waitFor(() => expect(fake.calls.some((c) => c.path === '/kb/wiki/pages/p-entropy/blocks/b5/recheck')).toBe(true));
  });

  it('“My note” adds your own note; your note can be deleted', async () => {
    const user = userEvent.setup();
    const { doc, fake } = await openPage('p-entropy');
    await user.click(await within(doc).findByRole('button', { name: 'My note' }));
    await user.type(within(doc).getByRole('textbox', { name: 'Block text' }), 'Ask about this at the seminar.');
    await user.click(within(doc).getByRole('button', { name: 'Save' }));
    expect(await within(doc).findByText('Ask about this at the seminar.')).toBeInTheDocument();
    expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/kb/wiki/pages/p-entropy/blocks')?.body).toEqual({ text: 'Ask about this at the seminar.' });
    const note = within(doc).getByText('Ask about this at the seminar.').closest('[data-block-id]') as HTMLElement;
    await user.click(within(note).getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(within(doc).queryByText('Ask about this at the seminar.')).not.toBeInTheDocument());
  });

  it('an analysis says it is not a source; Related chips open other pages', async () => {
    const user = userEvent.setup();
    const { doc } = await openPage('p-entropy');
    await user.click((await within(doc).findAllByRole('button', { name: 'Wiki page: Entropy across all folders' }))[0]!);
    expect(await within(doc).findByRole('heading', { level: 2, name: 'Entropy across all folders' })).toBeInTheDocument();
    expect(within(doc).getByRole('note')).toHaveTextContent('Not a source');
    expect(within(doc).getByText('Analysis')).toBeInTheDocument();
  });

  it('the side panel Wiki lists sections with counts and opens a page', async () => {
    const user = userEvent.setup();
    renderKb({ world: docWorld(), prefs: { section: 'wiki' } });
    const side = await screen.findByRole('region', { name: 'Wiki' });
    const concepts = await within(side).findByRole('button', { name: /Concepts/ });
    expect(concepts).toHaveTextContent('22');
    await user.click(concepts);
    await user.click(within(side).getByRole('button', { name: 'Entropy' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Entropy' })).toBeInTheDocument();
    await user.click(within(side).getByRole('button', { name: 'Wiki' }));
    expect(within(side).getByRole('heading', { name: 'Recently opened' })).toBeInTheDocument();
  });
});
