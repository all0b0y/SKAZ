import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { u3State } from '../test/fakeBridge';
import { addedLabel } from './AllMaterials';
import { fileItem, pasteItem, wikiDefault } from './addItems';

async function ready() {
  const r = renderKb({ state: u3State(), prefs: { section: 'materials' } });
  await waitFor(() => expect(screen.getByTestId('add-material')).not.toHaveAttribute('aria-disabled'));
  return r;
}

describe('All materials (v11, decision 25)', () => {
  it('opens over the centre as a table with type, name, folder, added and the wiki state', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByTestId('all-materials'));
    const center = await screen.findByRole('region', { name: 'All materials' });
    const table = await within(center).findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['', 'Name', 'Folder', 'Added', 'Wiki']);
    const row = within(table).getByRole('button', { name: 'Lecture 8 — entropy' }).closest('tr')!;
    expect(row).toHaveTextContent('Physics');
    expect(row).toHaveTextContent('In wiki');
    expect(within(table).getByRole('button', { name: 'Pasted text: problems' }).closest('tr')).toHaveTextContent('Not in wiki');
    expect(within(table).getByRole('button', { name: 'Lecture 5 — ML' }).closest('tr')).toHaveTextContent('Adding…');
    expect(within(table).getByRole('button', { name: 'habr.com/ru/articles/870112' }).closest('tr')).toHaveTextContent('Error');
    // The chat is hidden, not unmounted, while "All materials" holds the centre.
    expect(screen.queryByRole('region', { name: 'Chat' })).not.toBeInTheDocument();
  });

  it('filters by type and folder, sorts, switches to cards, opens a material on the right', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByTestId('all-materials'));
    const center = await screen.findByRole('region', { name: 'All materials' });
    await within(center).findByRole('table');
    await user.click(within(center).getByRole('radio', { name: 'Documents' }));
    expect(within(center).getAllByRole('row')).toHaveLength(2);
    await user.click(within(center).getByRole('radio', { name: 'All' }));
    await user.selectOptions(within(center).getByRole('combobox', { name: 'Folder' }), 'ml');
    expect(within(center).getAllByRole('row')).toHaveLength(4);
    await user.selectOptions(within(center).getByRole('combobox', { name: 'Sort' }), 'name');
    const names = within(center).getAllByRole('row').slice(1).map((r) => r.querySelector('.kb-amt__open')!.textContent);
    expect(names).toEqual([...names].sort((a, b) => a!.localeCompare(b!)));
    await user.click(within(center).getByRole('radio', { name: 'Cards' }));
    expect(within(center).getByRole('list', { name: 'Materials' })).toBeInTheDocument();
    await user.click(within(center).getByRole('button', { name: /Cross-entropy explained/ }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Cross-entropy explained' })).toBeInTheDocument();
    await user.click(within(center).getByRole('button', { name: 'Close all materials' }));
    expect(screen.queryByRole('region', { name: 'All materials' })).not.toBeInTheDocument();
  });

  it('says "today", "yesterday", else a short date', () => {
    const now = new Date('2026-10-15T15:00:00');
    expect(addedLabel('2026-10-15T08:00:00', now)).toBe('today');
    expect(addedLabel('2026-10-14T08:00:00', now)).toBe('yesterday');
    expect(addedLabel('2026-10-11T08:00:00', now)).toBe('11 Oct');
  });
});

describe('+ Material (v11, decisions 15–16)', () => {
  it('decides link vs text and the wiki default without the UI', () => {
    expect(pasteItem('https://youtu.be/x')).toMatchObject({ type: 'link', classifying: true });
    expect(pasteItem('  some notes\nmore  ')).toMatchObject({ type: 'text', text: 'some notes\nmore' });
    expect(pasteItem('   ')).toBeNull();
    expect(fileItem('/a/b/lecture.MP4', 'lecture.MP4', 10)).toMatchObject({ kind: 'speech', video: true });
    expect(fileItem('/a/b.pdf', 'b.pdf', 10)).toMatchObject({ kind: 'document' });
    const text = pasteItem('notes')!;
    const link = pasteItem('https://example.org')!;
    expect(wikiDefault([text], { files: true, text: false })).toBe(false);
    expect(wikiDefault([text, link], { files: true, text: false })).toBe(true);
  });

  it('a pasted link is classified; a video link asks the spoken language and translation; Add sends an import', async () => {
    const user = userEvent.setup();
    const { fake } = await ready();
    await user.click(screen.getByTestId('add-material'));
    const dialog = await screen.findByRole('dialog', { name: 'Add material' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Link or any text' }), 'https://www.youtube.com/watch?v=abc{Enter}');
    expect(await within(dialog).findByText('Seminar on entropy')).toBeInTheDocument();
    expect(within(dialog).getByText(/youtube\.com · Video · 1 h 04 min/)).toBeInTheDocument();
    // Last-used folder by default (decision 16), wiki on for links (decision 15).
    expect(within(dialog).getByRole('combobox', { name: 'Folder' })).toHaveValue('phys');
    expect(within(dialog).getByRole('switch', { name: 'Add to wiki after processing' })).toBeChecked();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Spoken language' }), 'en');
    await user.click(within(dialog).getByRole('switch', { name: 'Translate' }));
    expect(within(dialog).getByText('Translate into Russian')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add material' })).not.toBeInTheDocument());
    expect(fake.calls.find((c) => c.path === '/kb/imports')?.body).toEqual({
      url: 'https://www.youtube.com/watch?v=abc', folder_id: 'phys', translate: true, language: 'en',
    });
  });

  it('pasted text goes to the wiki only when asked; switching it on adds it once ready', async () => {
    const user = userEvent.setup();
    const { fake } = await ready();
    await user.click(screen.getByTestId('add-material'));
    const dialog = await screen.findByRole('dialog', { name: 'Add material' });
    const box = within(dialog).getByRole('textbox', { name: 'Link or any text' });
    fireEvent.change(box, { target: { value: 'Seminar notes: the log makes entropy additive.' } });
    await user.click(within(dialog).getByRole('button', { name: 'Add to list' }));
    const wikiSwitch = within(dialog).getByRole('switch', { name: 'Add to wiki after processing' });
    expect(wikiSwitch).not.toBeChecked();
    expect(within(dialog).queryByRole('combobox', { name: 'Spoken language' })).not.toBeInTheDocument();
    await user.click(wikiSwitch);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Folder' }), 'math');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add material' })).not.toBeInTheDocument());
    expect(fake.calls.find((c) => c.path === '/kb/materials/text')?.body).toEqual({ text: 'Seminar notes: the log makes entropy additive.', folder_id: 'math' });
    await waitFor(() => expect(fake.calls.some((c) => /^\/kb\/materials\/m-new\d+\/ingest$/.test(c.path))).toBe(true));
  });

  it('dropped files are listed with their type; one that fails stays with the reason', async () => {
    const user = userEvent.setup();
    const { fake, services } = await ready();
    services.bridge.droppedMediaFile = (file: File) => ({ path: `/Users/me/${file.name}`, name: file.name, url: `skaz-media://${file.name}` });
    await user.click(screen.getByTestId('add-material'));
    const dialog = await screen.findByRole('dialog', { name: 'Add material' });
    const files = [new File(['x'], 'lecture9.m4a', { type: 'audio/mp4' }), new File(['y'], 'notes.pdf', { type: 'application/pdf' })];
    fireEvent.drop(within(dialog).getByTestId('drop-zone'), { dataTransfer: { files, getData: () => '' } });
    expect(within(dialog).getByText('lecture9.m4a')).toBeInTheDocument();
    expect(within(dialog).getByText(/^Audio · 1 B$/)).toBeInTheDocument();
    expect(within(dialog).getByText(/^PDF · 1 B$/)).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Spoken language' })).toBeInTheDocument();
    const original = fake.bridge.request;
    fake.bridge.request = (async (req) => (req.path === '/kb/materials/file'
      ? { ok: false, status: 422, detail: 'This file type can’t be read.' }
      : original(req))) as typeof original;
    await user.click(within(dialog).getByRole('button', { name: 'Add 2' }));
    expect(await within(dialog).findByText('This file type can’t be read.')).toBeInTheDocument();
    expect(within(dialog).queryByText('lecture9.m4a')).not.toBeInTheDocument();
    expect(within(dialog).getByText('notes.pdf')).toBeInTheDocument();
  });

  it('the side panel "Add material" opens the same window', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Add material' }));
    expect(await screen.findByRole('dialog', { name: 'Add material' })).toBeInTheDocument();
    act(() => undefined);
  });
});
