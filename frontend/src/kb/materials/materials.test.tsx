import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import { materialWiki } from '../test/fakeKb';
import { addedLabel } from './AllMaterials';
import { fileItem, itemMeta, NOT_A_LINK, pasteItem, speechBlock, wikiDefault, type LinkItem } from './addItems';
import type { KbKeys, KbSpeechSettings } from '../../api/kb/types.gen';

async function ready() {
  const r = renderKb({ world: docWorld(), prefs: { section: 'materials' } });
  await waitFor(() => expect(screen.getByTestId('add-material')).not.toHaveAttribute('aria-disabled'));
  return r;
}

describe('All materials (v11, decision 25)', () => {
  it('opens over the centre as a table with type, name, folder, added and the wiki state', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByTestId('all-materials'));
    const center = await screen.findByRole('region', { name: 'All materials' });
    // A grid since 0.3.1 F2: rows are selectable (aria-multiselectable / aria-selected).
    const table = await within(center).findByRole('grid');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['', '', 'Name', 'Folder', 'Added', 'Wiki']);
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
    await within(center).findByRole('grid');
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

  it('queues every material whose wiki job failed again with one "Retry failed" (H2)', async () => {
    const user = userEvent.setup();
    const world = docWorld();
    const pasted = world.materials.find((m) => m.id === 'm-txt')!;
    pasted.wiki = materialWiki('failed', { error: 'The agent stopped.' });
    pasted.wiki_state = 'failed';
    renderKb({ world, prefs: { section: 'materials' } });
    await user.click(await screen.findByTestId('all-materials'));
    const center = await screen.findByRole('region', { name: 'All materials' });
    const table = await within(center).findByRole('grid');
    const row = () => within(table).getByRole('button', { name: 'Pasted text: problems' }).closest('tr')!;
    expect(row()).toHaveTextContent('Error');
    // The unreadable link can't be fixed by the wiki: it isn't counted.
    await user.click(within(center).getByRole('button', { name: 'Retry failed (1)' }));
    await waitFor(() => expect(row()).toHaveTextContent('Queued'));
    expect(within(center).queryByRole('button', { name: /Retry failed/ })).not.toBeInTheDocument();
  });

  it('selects rows and queues the eligible ones, then moves and deletes through the shared actions (FEAT-2)', async () => {
    const user = userEvent.setup();
    const r = renderKb({ world: docWorld(), prefs: { section: 'materials' } });
    await user.click(await screen.findByTestId('all-materials'));
    const center = await screen.findByRole('region', { name: 'All materials' });
    const grid = await within(center).findByRole('grid');
    const row = (name: string) => within(grid).getByRole('button', { name }).closest('tr')!;
    await user.click(row('Lecture 8 — entropy').querySelector('[data-sel-box]')!);
    await user.click(row('Pasted text: problems').querySelector('[data-sel-box]')!);
    await user.click(within(screen.getByRole('toolbar', { name: '2 selected' })).getByRole('button', { name: /Move to…/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Machine learning/ }));
    await waitFor(() => expect(r.fake.calls.filter((c) => c.method === 'PATCH' && c.path.startsWith('/kb/materials/'))).toHaveLength(2));
    await waitFor(() => expect(row('Pasted text: problems')).toHaveAttribute('aria-selected', 'false'));
    await user.click(row('Lecture 8 — entropy').querySelector('[data-sel-box]')!);
    await user.click(row('Pasted text: problems').querySelector('[data-sel-box]')!);
    await user.click(within(screen.getByRole('toolbar', { name: '2 selected' })).getByRole('button', { name: /Add to wiki · 1/ }));
    await waitFor(() => expect(r.fake.calls.filter((c) => c.method === 'POST' && /\/ingest$/.test(c.path))).toHaveLength(1));
    await waitFor(() => expect(row('Lecture 8 — entropy')).toHaveAttribute('aria-selected', 'false'));
    // The queued text is now processing; delete the other, selectable material.
    await user.click(row('Lecture 8 — entropy').querySelector('[data-sel-box]')!);
    await user.click(within(screen.getByRole('toolbar', { name: '1 selected' })).getByRole('button', { name: /Delete/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete 1 material?' });
    await user.click(await within(confirm).findByRole('button', { name: 'Delete 1' }));
    await waitFor(() => expect(r.fake.calls.some((c) => c.method === 'DELETE' && c.path === '/kb/materials/m-lec8')).toBe(true));
  });

  it('select all picks every eligible shown row, and Ask puts them in the message as mentions', async () => {
    const user = userEvent.setup();
    const r = renderKb({ world: docWorld(), prefs: { section: 'materials' } });
    await user.click(await screen.findByTestId('all-materials'));
    const center = await screen.findByRole('region', { name: 'All materials' });
    const grid = await within(center).findByRole('grid');
    await user.click(within(center).getByRole('checkbox', { name: 'Select all' }));
    const eligible = within(grid).getAllByRole('row').slice(1).filter((row) => !row.querySelector('.is-off-limits'));
    expect(within(center).getByRole('toolbar', { name: `${eligible.length} selected` })).toBeInTheDocument();
    expect(eligible.every((row) => row.getAttribute('aria-selected') === 'true')).toBe(true);
    const pushed: unknown[] = [];
    const off = r.services.composer.subscribe((s) => pushed.push(s));
    await user.click(within(center).getByRole('button', { name: /Ask in chat/ }));
    off();
    expect(pushed.length).toBeGreaterThan(0);
    await waitFor(() => expect(center.querySelector('[data-selecting]')).not.toBeInTheDocument());
  });

  it('dropping material rows on a folder moves them there (FEAT-2)', async () => {
    const r = renderKb({ world: docWorld(), prefs: { section: 'materials' } });
    const folder = await screen.findByRole('button', { name: /^Physics/ });
    const store: Record<string, string> = { 'application/x-skaz-items': JSON.stringify([{ type: 'material', id: 'm-txt', title: 'Pasted text: problems' }]) };
    const dataTransfer = { types: Object.keys(store), getData: (t: string) => store[t] ?? '', setData: () => undefined, dropEffect: 'none' };
    fireEvent.dragOver(folder, { dataTransfer });
    expect(folder).toHaveClass('is-drop');
    fireEvent.drop(folder, { dataTransfer });
    await waitFor(() => expect(r.fake.calls.some((c) => c.method === 'PATCH' && c.path === '/kb/materials/m-txt')).toBe(true));
  });

  it.each(['move', 'delete'] as const)('keeps only failed materials selected after a partial %s (merged FEAT-2)', async (action) => {
    const user = userEvent.setup();
    const { fake } = await ready();
    fake.world.failures[`${action === 'move' ? 'PATCH' : 'DELETE'} /kb/materials/m-txt`] = { status: 409, detail: 'This material is busy.' };
    await user.click(screen.getByTestId('all-materials'));
    const center = await screen.findByRole('region', { name: 'All materials' });
    const grid = await within(center).findByRole('grid');
    const row = (name: string) => within(grid).getByRole('button', { name }).closest('tr')!;
    await user.click(row('Pasted text: problems').querySelector('[data-sel-box]')!);
    await user.click(row('Cross-entropy explained').querySelector('[data-sel-box]')!);
    const bar = screen.getByRole('toolbar', { name: '2 selected' });
    if (action === 'move') {
      await user.click(within(bar).getByRole('button', { name: /Move to…/ }));
      await user.click(await screen.findByRole('menuitem', { name: /Physics/ }));
    } else {
      await user.click(within(bar).getByRole('button', { name: /Delete/ }));
      const confirm = await screen.findByRole('dialog', { name: 'Delete 2 materials?' });
      await user.click(await within(confirm).findByRole('button', { name: 'Delete 2' }));
    }
    expect(await screen.findByTestId('toast')).toHaveTextContent('skipped 1');
    await waitFor(() => expect(row('Pasted text: problems')).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('toolbar', { name: '1 selected' })).toBeInTheDocument();
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
    expect(within(dialog).getByText('YouTube · 1:04:00')).toBeInTheDocument();
    // Last-used folder by default (decision 16), wiki on for links with a ready agent (decision 15, QA B4).
    expect(within(dialog).queryByTestId('add-wiki-no-agent')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Folder' })).toHaveValue('phys');
    expect(within(dialog).getByRole('switch', { name: 'Add to wiki after processing' })).toBeChecked();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Spoken language' }), 'en');
    await user.click(within(dialog).getByRole('switch', { name: 'Translate' }));
    expect(within(dialog).getByText('Translate into Russian')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add material' })).not.toBeInTheDocument());
    expect(fake.calls.find((c) => c.path === '/kb/imports')?.body).toEqual({
      url: 'https://www.youtube.com/watch?v=abc', folder_id: 'phys', translate: true, language: 'en', to_wiki: true,
    });
  });

  it('a web link can be saved as the whole page (W-3): POST /kb/materials/web; a page SKAZ can’t fetch says Save as PDF', async () => {
    const user = userEvent.setup();
    const { fake } = await ready();
    await user.click(screen.getByTestId('add-material'));
    const dialog = await screen.findByRole('dialog', { name: 'Add material' });
    const box = within(dialog).getByRole('textbox', { name: 'Link or any text' });
    await user.type(box, 'https://habr.com/post/1{Enter}');
    const choice = await within(dialog).findByRole('radiogroup', { name: 'Save from the page' });
    expect(within(choice).getByRole('radio', { name: 'Article' })).toBeChecked();
    await user.click(within(choice).getByRole('radio', { name: 'Whole page' }));
    await user.type(box, 'https://news.example/signin-wall{Enter}');
    const second = (await within(dialog).findAllByRole('radiogroup', { name: 'Save from the page' }))[1]!;
    await user.click(within(second).getByRole('radio', { name: 'Whole page' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add 2' }));
    expect(await within(dialog).findByText(/Save the page as PDF and import it\./)).toBeInTheDocument();
    const web = fake.calls.filter((c) => c.path === '/kb/materials/web');
    expect(web.map((c) => c.body)).toEqual([
      { url: 'https://habr.com/post/1', folder_id: 'phys', to_wiki: true },
      { url: 'https://news.example/signin-wall', folder_id: 'phys', to_wiki: true },
    ]);
    expect(fake.calls.some((c) => c.path === '/kb/materials/link')).toBe(false);
  });

  it('pasted text goes to the wiki only when asked; the switch travels with the add request', async () => {
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
    expect(fake.calls.find((c) => c.path === '/kb/materials/text')?.body).toEqual({ text: 'Seminar notes: the log makes entropy additive.', folder_id: 'math', to_wiki: true });
    // The backend adds it once it is ready (AutoIngest honours the flag): no separate request.
    expect(fake.calls.some((c) => /\/ingest$/.test(c.path))).toBe(false);
  });

  it('a typed new folder name is created by Add itself and the materials land in it (0.3.1 F1)', async () => {
    const user = userEvent.setup();
    const { fake } = await ready();
    await user.click(screen.getByTestId('add-material'));
    const dialog = await screen.findByRole('dialog', { name: 'Add material' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Link or any text' }), { target: { value: 'Seminar notes on attention.' } });
    await user.click(within(dialog).getByRole('button', { name: 'Add to list' }));
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Folder' }), '__new');
    await user.type(within(dialog).getByRole('textbox', { name: 'New folder name' }), 'Психология 2026');
    // No Enter: the button says what one press does.
    await user.click(within(dialog).getByRole('button', { name: 'Create «Психология 2026» and add 1' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add material' })).not.toBeInTheDocument());
    const created = fake.calls.find((c) => c.method === 'POST' && c.path === '/kb/folders');
    expect(created?.body).toEqual({ name: 'Психология 2026' });
    const folder = fake.world.folders.find((f) => f.name === 'Психология 2026');
    expect(folder).toBeDefined();
    expect(fake.calls.find((c) => c.path === '/kb/materials/text')?.body).toMatchObject({ folder_id: folder!.id });
  });

  it('Enter in the new folder name makes the folder and selects it; a taken name offers the existing folder (0.3.1 F1)', async () => {
    const user = userEvent.setup();
    const { fake } = await ready();
    await user.click(screen.getByTestId('add-material'));
    const dialog = await screen.findByRole('dialog', { name: 'Add material' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Link or any text' }), { target: { value: 'Seminar notes on entropy.' } });
    await user.click(within(dialog).getByRole('button', { name: 'Add to list' }));
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Folder' }), '__new');
    const name = within(dialog).getByRole('textbox', { name: 'New folder name' });
    const existing = fake.world.folders.find((f) => !f.system)!;
    await user.type(name, existing.name.toLocaleUpperCase());
    expect(within(dialog).getByText('A folder with this name exists.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: `Add to «${existing.name}»` }));
    expect(within(dialog).getByRole('combobox', { name: 'Folder' })).toHaveValue(existing.id);
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Folder' }), '__new');
    await user.type(within(dialog).getByRole('textbox', { name: 'New folder name' }), 'Seminars{Enter}');
    const folder = await waitFor(() => fake.world.folders.find((f) => f.name === 'Seminars')!);
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Folder' })).toHaveValue(folder.id));
    expect(fake.calls.some((c) => c.path === '/kb/materials/text')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add material' })).not.toBeInTheDocument());
    expect(fake.calls.find((c) => c.path === '/kb/materials/text')?.body).toMatchObject({ folder_id: folder.id });
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/kb/folders')).toHaveLength(1);
  });

  it('with Settings adding files and links automatically, switching "Add to wiki" off is honoured (decision 15)', async () => {
    const user = userEvent.setup();
    const { fake } = await ready();
    await user.click(screen.getByTestId('add-material'));
    const dialog = await screen.findByRole('dialog', { name: 'Add material' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Link or any text' }), 'https://www.youtube.com/watch?v=abc{Enter}');
    expect(await within(dialog).findByText('Seminar on entropy')).toBeInTheDocument();
    const wikiSwitch = within(dialog).getByRole('switch', { name: 'Add to wiki after processing' });
    expect(wikiSwitch).toBeChecked();
    await user.click(wikiSwitch);
    expect(wikiSwitch).not.toBeChecked();
    expect(within(dialog).queryByText(/can’t hold it back/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add material' })).not.toBeInTheDocument());
    expect(fake.calls.find((c) => c.path === '/kb/imports')?.body).toMatchObject({ to_wiki: false });
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

  it('without a ready wiki agent "Add to wiki" starts off and says where to connect one (QA B4)', async () => {
    const user = userEvent.setup();
    const world = docWorld();
    world.agents.agents.find((a) => a.id === 'claude_code')!.state = 'not_installed';
    const r = renderKb({ world, prefs: { section: 'materials' } });
    await waitFor(() => expect(screen.getByTestId('add-material')).not.toHaveAttribute('aria-disabled'));
    await user.click(screen.getByTestId('add-material'));
    const dialog = await screen.findByRole('dialog', { name: 'Add material' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Link or any text' }), 'https://www.youtube.com/watch?v=abc{Enter}');
    expect(await within(dialog).findByText('Seminar on entropy')).toBeInTheDocument();
    expect(within(dialog).getByRole('switch', { name: 'Add to wiki after processing' })).not.toBeChecked();
    expect(within(dialog).getByTestId('add-wiki-no-agent')).toHaveTextContent('Connect an agent in Settings → Accounts & keys to add materials to the wiki.');
    await user.click(within(dialog).getByRole('button', { name: 'Open Accounts & keys' }));
    expect(r.services.ui.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'conn' });
  });

  it('audio and video say what they need before Add, per row, with the real Settings place (QA B6)', async () => {
    const user = userEvent.setup();
    const world = docWorld();
    world.speech = { ...world.speech, provider: 'soniox', cloud_consent: false };
    const r = renderKb({ world, prefs: { section: 'materials' } });
    r.services.bridge.droppedMediaFile = (file: File) => ({ path: `/Users/me/${file.name}`, name: file.name, url: `skaz-media://${file.name}` });
    await waitFor(() => expect(screen.getByTestId('add-material')).not.toHaveAttribute('aria-disabled'));
    await user.click(screen.getByTestId('add-material'));
    const dialog = await screen.findByRole('dialog', { name: 'Add material' });
    const files = [new File(['x'], 'talk.wav'), new File(['y'], 'clip.mov'), new File(['z'], 'notes.pdf')];
    fireEvent.drop(within(dialog).getByTestId('drop-zone'), { dataTransfer: { files, getData: () => '' } });
    const rows = await within(dialog).findAllByTestId('speech-block');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Importing sends the audio to Soniox. Turn on “Send audio to Soniox” in Settings → Recording & speech.');
    expect(within(dialog).getByRole('button', { name: 'Add 3' })).toBeDisabled();
    expect(within(dialog).queryByText(/Download it below/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Open Recording & speech' }));
    expect(r.services.ui.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'rec' });
    expect(r.fake.calls.some((c) => c.path === '/kb/imports')).toBe(false);
  });

  it('names the setting each provider needs: key, consent, the model on this computer', () => {
    const speech = (over: Partial<KbSpeechSettings>): KbSpeechSettings => ({
      provider: 'soniox', languages: [], translate_by_default: false, translation_language: 'en', cloud_consent: true,
      local_model: { model: 'small', state: 'ready', progress: null, reason: null, size_bytes: null }, ...over,
    });
    const keys = (soniox: boolean): KbKeys => ({ providers: [{ id: 'soniox', configured: soniox, checked_at: null, valid: null }] });
    expect(speechBlock(speech({}), keys(true))).toBeNull();
    expect(speechBlock(speech({}), keys(false))).toMatchObject({ section: 'conn', action: 'Open Accounts & keys', reason: 'Soniox has no API key. Add one in Settings → Accounts & keys.' });
    expect(speechBlock(speech({ cloud_consent: false }), keys(true))?.section).toBe('rec');
    const local = speech({ provider: 'local_whisper', cloud_consent: false, local_model: { model: 'small', state: 'missing', progress: null, reason: null, size_bytes: 1 } });
    expect(speechBlock(local, keys(false))).toMatchObject({ section: 'rec', reason: expect.stringMatching(/isn’t downloaded yet\. Download it in Settings → Recording & speech/) });
    expect(speechBlock(null, null)).toBeNull();
  });

  it('a dropped file SKAZ can’t read says so on its row and holds Add until it is removed (QA B2, B15)', async () => {
    const user = userEvent.setup();
    const { services } = await ready();
    services.bridge.droppedMediaFile = (file: File) => ({ path: `/Users/me/${file.name}`, name: file.name, url: `skaz-media://${file.name}` });
    await user.click(screen.getByTestId('add-material'));
    const dialog = await screen.findByRole('dialog', { name: 'Add material' });
    const files = [new File(['x'], 'doc.rtf'), new File(['y'], 'notes.md')];
    fireEvent.drop(within(dialog).getByTestId('drop-zone'), { dataTransfer: { files, getData: () => '' } });
    expect(within(dialog).getByText(/SKAZ can’t read this type/)).toHaveClass('is-error');
    expect(within(dialog).getByRole('button', { name: 'Add 2' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Remove doc.rtf' }));
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('Low: link labels once, bad addresses said so, failing links not counted, "None" when nothing was added, focus in the field (QA B14, B22–B24, B33)', async () => {
    expect(pasteItem('https://exa mple.com')).toMatchObject({ type: 'link', error: NOT_A_LINK });
    expect(pasteItem('https://example.com is where I read it\nand more')).toMatchObject({ type: 'text' });
    expect(pasteItem('ftp://example.com/x.pdf')).toMatchObject({ type: 'link', classifying: false, error: NOT_A_LINK });
    const yt = { ...pasteItem('https://youtu.be/x') as LinkItem, classifying: false };
    expect(itemMeta({ ...yt, info: { kind: 'video', url: 'u', domain: 'youtube.com', label: 'YouTube · 0:19', platform: 'youtube', video_id: 'x', title: 'T', duration_ms: 19_000, supported: true, note: null, embedded_video: null } }))
      .toBe('YouTube · 0:19');
    const user = userEvent.setup();
    const { fake } = await ready();
    await user.click(screen.getByTestId('add-material'));
    const dialog = await screen.findByRole('dialog', { name: 'Add material' });
    const box = within(dialog).getByRole('textbox', { name: 'Link or any text' });
    await waitFor(() => expect(box).toHaveFocus());
    await user.type(box, 'ftp://example.com/x.pdf{Enter}');
    expect(within(dialog).getByText(NOT_A_LINK)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'Seminar notes.' } });
    await user.click(within(dialog).getByRole('button', { name: 'Add to list' }));
    const original = fake.bridge.request;
    fake.bridge.request = (async (req) => (req.path === '/kb/materials/text'
      ? { ok: false, status: 503, detail: 'The library is busy.' } : original(req))) as typeof original;
    // The broken link is neither counted nor sent.
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByText('None of these were added.')).toBeInTheDocument();
    expect(within(dialog).getAllByText('The library is busy.')).toHaveLength(1);
    expect(fake.calls.some((c) => c.path === '/kb/materials/link' || c.path === '/kb/links/classify')).toBe(false);
  });

  it('the side panel "Add material" opens the same window', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Add material' }));
    expect(await screen.findByRole('dialog', { name: 'Add material' })).toBeInTheDocument();
    act(() => undefined);
  });
});

describe('Selecting several materials in the table (0.3.1 F2/F4/F5)', () => {
  async function table() {
    const user = userEvent.setup();
    const r = await ready();
    await user.click(screen.getByTestId('all-materials'));
    const center = await screen.findByRole('region', { name: 'All materials' });
    const grid = await within(center).findByRole('grid');
    const rowOf = (name: string) => within(grid).getByRole('button', { name }).closest('tr')!;
    return { ...r, user, center, grid, rowOf };
  }

  it('⌘-click selects without opening; the bar moves them with Undo back to their old folders', async () => {
    const { user, center, rowOf, fake, services } = await table();
    expect(within(center).getByRole('grid')).toHaveAttribute('aria-multiselectable', 'true');
    await user.keyboard('{Meta>}');
    await user.click(within(rowOf('Pasted text: problems')).getByRole('button', { name: 'Pasted text: problems' }));
    await user.click(within(rowOf('Cross-entropy explained')).getByRole('button', { name: 'Cross-entropy explained' }));
    await user.keyboard('{/Meta}');
    expect(rowOf('Pasted text: problems')).toHaveAttribute('aria-selected', 'true');
    expect(rowOf('Cross-entropy explained')).toHaveAttribute('aria-selected', 'true');
    expect(services.ui.getState().right).toBeNull();
    const bar = screen.getByRole('toolbar', { name: '2 selected' });
    expect(within(bar).getByRole('button', { name: /Add to wiki · 1/ })).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: /Move to…/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Physics/ }));
    expect(await screen.findByTestId('toast')).toHaveTextContent('Moved 2 materials to «Physics»');
    expect(fake.world.materials.find((m) => m.id === 'm-txt')!.folder_id).toBe('phys');
    expect(fake.world.materials.find((m) => m.id === 'm-ce')!.folder_id).toBe('phys');
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: /selected/ })).not.toBeInTheDocument());
    await user.click(within(screen.getByTestId('toast')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(fake.world.materials.find((m) => m.id === 'm-ce')!.folder_id).toBe('ml'));
    expect(fake.world.materials.find((m) => m.id === 'm-txt')!.folder_id).not.toBe('phys');
    expect(await screen.findByTestId('toast')).toHaveTextContent('Moved 2 materials back');
  });

  it('a material being added to the wiki can’t be selected and says why', async () => {
    const { user, rowOf } = await table();
    const row = rowOf('Lecture 5 — ML');
    expect(row.querySelector('[data-sel-box]')).toHaveAttribute('title', 'Being added to the wiki — wait until it’s done');
    await user.keyboard('{Meta>}');
    await user.click(within(row).getByRole('button', { name: 'Lecture 5 — ML' }));
    await user.keyboard('{/Meta}');
    expect(row).toHaveAttribute('aria-selected', 'false');
  });

  it('⌘⌫ asks once with the consequences, then deletes one by one and reports', async () => {
    const { user, rowOf, fake } = await table();
    await user.click(rowOf('Pasted text: problems').querySelector('[data-sel-box]')!);
    await user.click(rowOf('Cross-entropy explained').querySelector('[data-sel-box]')!);
    within(rowOf('Cross-entropy explained')).getByRole('button', { name: 'Cross-entropy explained' }).focus();
    await user.keyboard('{Meta>}{Backspace}{/Meta}');
    const dialog = await screen.findByRole('dialog', { name: 'Delete 2 materials?' });
    expect(dialog).toHaveTextContent('Nothing is removed before you press Delete.');
    // In the table's order (newest first).
    expect(dialog).toHaveTextContent('Cross-entropy explained and Pasted text: problems and their files');
    expect(fake.world.materials.some((m) => m.id === 'm-txt')).toBe(true);
    await user.click(await within(dialog).findByRole('button', { name: 'Delete 2' }));
    expect(await screen.findByTestId('toast')).toHaveTextContent('Deleted 2 materials');
    expect(fake.world.materials.some((m) => m.id === 'm-txt' || m.id === 'm-ce')).toBe(false);
    expect(fake.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/kb/materials/m-ce', '/kb/materials/m-txt']);
  });

  it('“Ask in chat” puts the selection into the message field as @-mentions', async () => {
    const { user, rowOf, services } = await table();
    await user.click(rowOf('Pasted text: problems').querySelector('[data-sel-box]')!);
    await user.click(rowOf('Cross-entropy explained').querySelector('[data-sel-box]')!);
    await user.click(within(screen.getByRole('toolbar', { name: '2 selected' })).getByRole('button', { name: /Ask in chat/ }));
    expect(services.ui.getState().center).toBe('chat');
    const input = await screen.findByTestId('message-input');
    await waitFor(() => expect([...input.querySelectorAll('.kb-token--mention')].map((t) => t.textContent)).toEqual(
      ['Cross-entropy explained', 'Pasted text: problems'].map((t) => expect.stringContaining(t)),
    ));
  });

  it('right-click opens the same actions for the row (and the selection it joins)', async () => {
    const { user, rowOf } = await table();
    fireEvent.contextMenu(within(rowOf('Pasted text: problems')).getByRole('button', { name: 'Pasted text: problems' }), { clientX: 200, clientY: 200 });
    const menu = await screen.findByRole('menu', { name: 'Material actions' });
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Move to…⌘⇧M', 'Ask in chat⌘↩', 'Add to wiki · 1', expect.stringMatching(/^Export \.md/),
      'Make cards from these', 'Make a test from these', 'Delete 1 material⌘⌫',
    ]);
    expect(rowOf('Pasted text: problems')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
  });

  it('⋯ Export .md writes the chosen materials into a folder from the chooser (POST /kb/export/items)', async () => {
    const user = userEvent.setup();
    const chooseExportFolder = vi.fn(async () => '/Users/me/Documents/Out');
    const { fake } = renderKb({ world: docWorld(), prefs: { section: 'materials' }, bridge: { chooseExportFolder } });
    await waitFor(() => expect(screen.getByTestId('add-material')).not.toHaveAttribute('aria-disabled'));
    await user.click(screen.getByTestId('all-materials'));
    const grid = await within(await screen.findByRole('region', { name: 'All materials' })).findByRole('grid');
    const rowOf = (name: string) => within(grid).getByRole('button', { name }).closest('tr')!;
    await user.click(rowOf('Pasted text: problems').querySelector('[data-sel-box]')!);
    await user.click(rowOf('Cross-entropy explained').querySelector('[data-sel-box]')!);
    await user.click(within(screen.getByRole('toolbar', { name: '2 selected' })).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Export \.md/ }));
    expect(await screen.findByTestId('toast')).toHaveTextContent('Exported 2 files to «Out»');
    expect(chooseExportFolder).toHaveBeenCalledTimes(1);
    expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/kb/export/items')?.body).toEqual({
      path: '/Users/me/Documents/Out', overwrite: false,
      items: [{ type: 'material', id: 'm-ce' }, { type: 'material', id: 'm-txt' }],
    });
  });
});
