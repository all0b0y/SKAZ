import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderKb } from '../test/renderKb';
import { docWorld } from '../test/fakeBridge';
import { materialWiki } from '../test/fakeKb';

async function openMaterial(id: string) {
  const r = renderKb({ world: docWorld() });
  await screen.findByRole('navigation', { name: 'Sections' });
  act(() => r.services.ui.getState().openDocument({ type: 'material', id }));
  const doc = await screen.findByRole('complementary', { name: 'Document' });
  await within(doc).findByRole('heading', { level: 2 });
  return { ...r, doc };
}

describe('Material (v9, v16–v18): statuses, fixes, translation, excluded fragments', () => {
  it('a recording shows its pipeline, monologues with speaker and time, and fixes in the text', async () => {
    const { doc } = await openMaterial('m-lec8');
    expect(within(doc).getByRole('heading', { level: 2, name: 'Lecture 8 — entropy' })).toBeInTheDocument();
    for (const chip of ['Recognised', 'Translated', '1 correction', '1 doubtful', '14 concepts in wiki', 'Notes']) {
      expect(within(doc).getByText(chip)).toBeInTheDocument();
    }
    // Decision 24: a recording made with translation opens in translation.
    expect(within(doc).getByRole('radio', { name: 'Translation' })).toHaveAttribute('aria-checked', 'true');
    const user = userEvent.setup();
    await user.click(within(doc).getByRole('radio', { name: 'Original' }));
    expect(within(doc).getAllByText('Speaker 1').length).toBeGreaterThan(0);
    expect(within(doc).getByText('08:12')).toBeInTheDocument();
    // An applied fix is underlined at the corrected word, a doubtful one at the recognised words.
    expect(within(doc).getByRole('button', { name: /Shannon — fixed/ })).toBeInTheDocument();
    expect(within(doc).getByRole('button', { name: /micro states — possible recognition error/ })).toBeInTheDocument();
  });

  it('a fix card shows was → became with the reason; Revert writes the recognised word back', async () => {
    const user = userEvent.setup();
    const { doc, fake } = await openMaterial('m-lec8');
    await user.click(within(doc).getByRole('radio', { name: 'Original' }));
    await user.click(within(doc).getByRole('button', { name: /Shannon — fixed/ }));
    const card = await screen.findByRole('dialog', { name: 'Recognition fix' });
    expect(card).toHaveTextContent('Shanon');
    expect(card).toHaveTextContent('Name spelled as in the lecture slides.');
    await user.click(within(card).getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(within(doc).getByRole('button', { name: /Shanon — fix reverted/ })).toBeInTheDocument());
    expect(fake.calls.some((c) => c.path === '/kb/corrections/c2/revert')).toBe(true);
    // The wiki follows: the app says pages will be refreshed.
    expect(await within(doc).findByText(/2 wiki statements updated/)).toBeInTheDocument();
  });

  it('a doubtful fix can be accepted or kept as recognised', async () => {
    const user = userEvent.setup();
    const { doc } = await openMaterial('m-lec8');
    await user.click(within(doc).getByRole('radio', { name: 'Original' }));
    await user.click(within(doc).getByRole('button', { name: /micro states — possible recognition error/ }));
    const card = await screen.findByRole('dialog', { name: 'Recognition fix' });
    await user.click(within(card).getByRole('button', { name: 'Keep as recognised' }));
    await waitFor(() => expect(within(doc).queryByRole('button', { name: /micro states — possible/ })).not.toBeInTheDocument());
    await waitFor(() => expect(within(doc).queryByText('1 doubtful')).not.toBeInTheDocument());
  });

  it('switches original / translation / both; "both" keeps the pairs aligned by segment', async () => {
    const user = userEvent.setup();
    const { doc } = await openMaterial('m-lec8');
    expect(within(doc).getByText(/Итак, Больцман записал/)).toBeInTheDocument();
    expect(within(doc).queryByText(/So Boltzmann wrote/)).not.toBeInTheDocument();
    await user.click(within(doc).getByRole('radio', { name: 'Both' }));
    expect(within(doc).getByText(/So Boltzmann wrote/)).toBeInTheDocument();
    expect(within(doc).getByText(/Итак, Больцман записал/)).toBeInTheDocument();
  });

  it('a Soniox translation without segment ids is shown as paragraphs, not paired by guess', async () => {
    const user = userEvent.setup();
    const { doc } = await openMaterial('m-lec7');
    await user.click(within(doc).getByRole('radio', { name: 'Both' }));
    expect(within(doc).getByText('Энтропия изолированной системы никогда не убывает.')).toBeInTheDocument();
    expect(within(doc).getByRole('heading', { name: 'Translation' })).toBeInTheDocument();
    expect(within(doc).getByRole('heading', { name: 'Original' })).toBeInTheDocument();
  });

  it('“Excluded fragments: 1” opens the found text and restores it', async () => {
    const user = userEvent.setup();
    const { doc, fake } = await openMaterial('m-lec8');
    await user.click(within(doc).getByRole('button', { name: /Excluded fragments: 1/ }));
    expect(await within(doc).findByText(/Ignore previous instructions/)).toBeInTheDocument();
    await user.click(within(doc).getByRole('button', { name: 'Not an instruction — restore' }));
    await waitFor(() => expect(fake.calls.some((c) => c.path === '/kb/materials/m-lec8/excluded/3/restore')).toBe(true));
  });

  it('PDF pages and the article’s source link', async () => {
    const pdf = await openMaterial('m-tb');
    expect(within(pdf.doc).getAllByText(/^p\. 31$/).length).toBeGreaterThan(0);
    pdf.unmount();
    const web = await openMaterial('m-ce');
    expect(within(web.doc).getByText('https://example.org/cross-entropy-explained')).toBeInTheDocument();
  });

  it('pages whose PDF text couldn’t be read are named, and that text is not in the material', async () => {
    const world = docWorld();
    const tb = world.materials.find((m) => m.id === 'm-tb')!;
    tb.unreadable_pages = [2, 5];
    const r = renderKb({ world });
    await screen.findByRole('navigation', { name: 'Sections' });
    act(() => r.services.ui.getState().openDocument({ type: 'material', id: 'm-tb' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    const note = await within(doc).findByRole('note', { name: 'Unreadable text in the PDF' });
    expect(note).toHaveTextContent('Unreadable text in the PDF (pages 2, 5)');
    expect(note).toHaveTextContent('left out of the material');
  });

  it('a failed link says why and offers nothing it cannot do', async () => {
    const { doc } = await openMaterial('m-habr');
    expect(within(doc).getByText('Couldn’t read')).toBeInTheDocument();
    expect(within(doc).getByText('Wiki: the site did not answer')).toBeInTheDocument();
    expect(within(doc).queryByRole('button', { name: 'Add to wiki' })).not.toBeInTheDocument();
  });

  it('a wiki failure because the agent is signed out shows the whole reason and the fix, not only a retry', async () => {
    const user = userEvent.setup();
    const world = docWorld();
    const reason = 'The agent stopped: Sign in to Codex with your ChatGPT account in Settings, then try again.';
    world.materials.find((m) => m.id === 'm-txt')!.wiki = materialWiki('failed', { error: reason, error_code: 'AGENT_UNAVAILABLE' });
    const r = renderKb({ world });
    await screen.findByRole('navigation', { name: 'Sections' });
    act(() => r.services.ui.getState().openDocument({ type: 'material', id: 'm-txt' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    // The reason wraps instead of being cut mid-word.
    const chip = await within(doc).findByText(`Wiki: ${reason}`);
    expect(chip.closest('.kb-pst')).toHaveClass('kb-pst--wrap');
    await user.click(within(doc).getByRole('button', { name: 'Open Accounts & keys' }));
    expect(r.services.ui.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'conn' });
    // Retrying stays possible once signed in.
    expect(within(doc).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('other wiki failures offer only the retry', async () => {
    const world = docWorld();
    world.materials.find((m) => m.id === 'm-txt')!.wiki = materialWiki('failed', { error: 'The agent stopped: Usage limit reached.' });
    const r = renderKb({ world });
    await screen.findByRole('navigation', { name: 'Sections' });
    act(() => r.services.ui.getState().openDocument({ type: 'material', id: 'm-txt' }));
    const doc = await screen.findByRole('complementary', { name: 'Document' });
    expect(await within(doc).findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(within(doc).queryByRole('button', { name: 'Open Accounts & keys' })).not.toBeInTheDocument();
  });

  it('pasted text not in the wiki offers "Add to wiki"; it starts ingest and shows the steps', async () => {
    const user = userEvent.setup();
    const { doc, fake } = await openMaterial('m-txt');
    await user.click(within(doc).getByRole('button', { name: 'Add to wiki' }));
    await waitFor(() => expect(fake.calls.some((c) => c.path === '/kb/materials/m-txt/ingest')).toBe(true));
    expect(await within(doc).findByText('Checking recognition')).toBeInTheDocument();
  });

  it('rename, move and delete with the honest preview of what leaves the wiki', async () => {
    const user = userEvent.setup();
    const { doc, fake } = await openMaterial('m-lec8');
    await user.click(within(doc).getByRole('button', { name: 'Material actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const rename = await screen.findByRole('dialog', { name: 'Rename material' });
    const field = within(rename).getByRole('textbox');
    await user.clear(field);
    await user.type(field, 'Lecture 8 — Boltzmann');
    await user.click(within(rename).getByRole('button', { name: 'Rename' }));
    expect(await within(doc).findByRole('heading', { level: 2, name: 'Lecture 8 — Boltzmann' })).toBeInTheDocument();

    await user.click(within(doc).getByRole('button', { name: 'Material actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to folder' }));
    const move = await screen.findByRole('dialog', { name: 'Move to folder' });
    await user.click(within(move).getByRole('radio', { name: /Mathematics/ }));
    await user.click(within(move).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'PATCH' && (c.body as { folder_id?: string })?.folder_id === 'math')).toBe(true));

    await user.click(within(doc).getByRole('button', { name: 'Material actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const del = await screen.findByRole('dialog', { name: /Delete/ });
    expect(await within(del).findByText(/Notes: Lecture 8 — entropy/)).toBeInTheDocument();
    expect(within(del).getByText('Your note on these pages stays untouched.')).toBeInTheDocument();
    await user.click(within(del).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Document' })).not.toBeInTheDocument());
  });
});
