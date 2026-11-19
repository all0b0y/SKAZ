import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { NativeIntakeApi, TrustedMaterialSelection } from '../../../api/bridge';
import { LOCAL_VIDEO_AUDIO_ONLY_NOTICE } from '../../materials/addItems';
import { chatWorld } from '../../test/fixtures';
import { renderKb } from '../../test/renderKb';
import { ITEMS_MIME } from '../../ui/listSelection/dnd';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function diskSelection(name: string): TrustedMaterialSelection {
  return {
    selectionId: name, path: `/native/${name}`, name, size: 4, ext: 'docx', formatId: 'docx',
    category: 'docx', route: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    source: 'drop', nativePreviewable: false,
  };
}

function speechSelection(name: string, source: 'drop' | 'picker' = 'drop'): TrustedMaterialSelection {
  const ext = name.split('.').at(-1)!.toLowerCase();
  return {
    ...diskSelection(name), ext, formatId: ext, source, category: 'speech', route: 'speech',
    mimeType: ext === 'wav' ? 'audio/wav' : 'video/mp4',
  };
}

function nativeBridge() {
  const bridge = {
    chooseMaterialFiles: vi.fn<NativeIntakeApi['chooseMaterialFiles']>().mockResolvedValue({ accepted: [], rejected: [] }),
    droppedMaterialFiles: vi.fn<NativeIntakeApi['droppedMaterialFiles']>().mockImplementation(async ([file]) =>
      ({ accepted: [diskSelection(file!.name)], rejected: [] })),
    validateClipboardImage: vi.fn<NativeIntakeApi['validateClipboardImage']>().mockResolvedValue({
      ok: true, selection: { selectionId: 'clip', name: 'Screenshot.png', size: 4, formatId: 'png', mimeType: 'image/png',
        source: 'clipboard', nativePreviewable: true },
    }),
    importSelection: vi.fn<NativeIntakeApi['importSelection']>().mockImplementation(async ({ selectionId }) => ({
      ok: true, status: 201, data: { material: { id: selectionId, status: 'ready' } },
    })),
    imagePreview: vi.fn<NativeIntakeApi['imagePreview']>().mockResolvedValue({
      ok: true, status: 200, data: { bytes: new Uint8Array([0]), mimeType: 'image/png' },
    }),
  } satisfies NativeIntakeApi;
  return bridge;
}

const dropData = (...names: string[]) => ({ types: ['Files'], files: names.map((name) => new File(['test'], name)) });
const conversation = () => screen.getByRole('log', { name: 'Conversation' });
const editor = () => screen.getByRole('textbox', { name: 'Message' });
const row = () => screen.getByRole('list', { name: 'Draft attachments' });
const outbound = (calls: Array<{ method: string; path: string }>) =>
  calls.filter(({ method, path }) => method === 'POST' && /\/messages$/.test(path));

async function openA(user: ReturnType<typeof userEvent.setup>) {
  const side = screen.getByRole('region', { name: 'Chats' });
  await user.click(await within(side).findByRole('button', { name: /Why is there a logarithm/ }));
  return side;
}

async function pickFiles(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Add a file, link or text' }));
  await user.click(within(await screen.findByRole('menu', { name: 'Add to the question' })).getByRole('menuitem', { name: 'File…' }));
}

const videoPrompt = (name: string) => screen.findByRole('group', { name: `Import audio from ${name}` });
const speechAdded = (id: string) => ({ ok: true, status: 201, data: { material_id: id, status: 'ready' } }) as const;

describe('attachments in the production chat', () => {
  it('drops over history, settles in the original draft after A → B, and retains it through close and reopen', async () => {
    const user = userEvent.setup();
    const nativeIntake = nativeBridge();
    const pending = deferred<Awaited<ReturnType<NativeIntakeApi['importSelection']>>>();
    nativeIntake.importSelection.mockReturnValueOnce(pending.promise);
    const { fake, services } = renderKb({ world: chatWorld(), bridge: { nativeIntake } });
    const side = await openA(user);
    await user.click(editor());
    await user.keyboard('Draft in A');

    const dataTransfer = dropData('notes.docx');
    fireEvent.dragOver(conversation(), { dataTransfer });
    expect(screen.getByText('Drop files to attach')).toBeVisible();
    fireEvent.drop(conversation(), { dataTransfer });
    expect(row()).toHaveTextContent('Preparing');
    await waitFor(() => expect(nativeIntake.importSelection).toHaveBeenCalledWith({
      selectionId: 'notes.docx', folderId: expect.any(String), toWiki: false,
    }));

    await user.click(within(side).getByRole('button', { name: /Transformer paper review/ }));
    await user.click(editor());
    await user.keyboard('Draft in B');
    await act(async () => pending.resolve({ ok: true, status: 201, data: { material: { id: 'notes', status: 'ready' } } }));
    expect(editor()).toHaveTextContent('Draft in B');
    expect(screen.queryByRole('list', { name: 'Draft attachments' })).toBeNull();
    expect(outbound(fake.calls)).toEqual([]);

    await user.click(screen.getByRole('tab', { name: /Why is there a logarithm/ }));
    expect(editor()).toHaveTextContent('Draft in A');
    expect(row()).toHaveTextContent('notes.docx');
    await user.click(screen.getByRole('button', { name: /Close tab: Why is there a logarithm/ }));
    act(() => services.chats.getState().reopenLastTab());
    expect(editor()).toHaveTextContent('Draft in A');
    expect(row()).toHaveTextContent('notes.docx');
  });

  it('holds only dropped videos in the originating draft through a switch and confirms each explicitly', async () => {
    const user = userEvent.setup();
    const nativeIntake = nativeBridge();
    const inspection = deferred<Awaited<ReturnType<NativeIntakeApi['droppedMaterialFiles']>>>();
    const importing = deferred<Awaited<ReturnType<NativeIntakeApi['importSelection']>>>();
    nativeIntake.droppedMaterialFiles.mockImplementation(async ([file]) => {
      if (file!.name === 'first.MP4') return inspection.promise;
      const selection = file!.name === 'notes.docx' ? diskSelection(file!.name) : speechSelection(file!.name);
      return { accepted: [selection], rejected: [] };
    });
    nativeIntake.importSelection.mockImplementation(async ({ selectionId }) => {
      if (selectionId === 'first.MP4') {
        expect(screen.getByText(LOCAL_VIDEO_AUDIO_ONLY_NOTICE)).toBeVisible();
        return importing.promise;
      }
      if (selectionId === 'recording.wav') return speechAdded(selectionId);
      return { ok: true, status: 201, data: { material: { id: selectionId, status: 'ready' } } };
    });
    const { fake, services } = renderKb({ world: chatWorld(), bridge: { nativeIntake } });
    const side = await openA(user);
    await user.click(editor());
    await user.keyboard('Draft in A');
    fireEvent.drop(conversation(), { dataTransfer: dropData('first.MP4', 'second.mp4', 'notes.docx', 'recording.wav') });
    await waitFor(() => expect(nativeIntake.importSelection.mock.calls.map(([request]) => request.selectionId))
      .toEqual(['notes.docx', 'recording.wav']));

    await user.click(within(side).getByRole('button', { name: /Transformer paper review/ }));
    await user.click(editor());
    await user.keyboard('Keep B');
    await act(async () => inspection.resolve({ accepted: [speechSelection('first.MP4')], rejected: [] }));
    expect(screen.queryByText(LOCAL_VIDEO_AUDIO_ONLY_NOTICE)).toBeNull();
    expect(screen.queryByRole('list', { name: 'Draft attachments' })).toBeNull();
    expect(nativeIntake.importSelection).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('tab', { name: /Why is there a logarithm/ }));
    const prompt = await videoPrompt('first.MP4');
    const proceed = within(prompt).getByRole('button', { name: 'Import audio' });
    expect(within(prompt).getByText(LOCAL_VIDEO_AUDIO_ONLY_NOTICE)).toBeVisible();
    expect(editor()).toHaveTextContent('Draft in A');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(outbound(fake.calls)).toEqual([]);
    expect(nativeIntake.importSelection).toHaveBeenCalledTimes(2);

    act(() => {
      fireEvent.click(proceed);
      fireEvent.click(proceed);
    });
    expect(nativeIntake.importSelection).toHaveBeenCalledTimes(3);
    expect(nativeIntake.importSelection).toHaveBeenLastCalledWith({ selectionId: 'first.MP4', folderId: 'inbox', toWiki: false });
    const next = await videoPrompt('second.mp4');
    fireEvent.click(within(next).getByRole('button', { name: 'Import audio' }), { detail: 2 });
    expect(nativeIntake.importSelection).toHaveBeenCalledTimes(3);
    await user.click(within(next).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(LOCAL_VIDEO_AUDIO_ONLY_NOTICE)).toBeNull();
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(outbound(fake.calls)).toEqual([]);

    await act(async () => importing.resolve(speechAdded('first-video')));
    const drafts = services.composer.getState().attachmentDrafts.getState();
    expect(drafts.getDraft('c1').attachments.map((item) => [item.materialId, item.state])).toEqual([
      ['first-video', 'ready'], ['notes.docx', 'ready'], ['recording.wav', 'ready'],
    ]);
    fireEvent.keyDown(editor(), { key: 'Enter', repeat: true });
    expect(outbound(fake.calls)).toEqual([]);
    expect(screen.getByRole('button', { name: 'Send' })).not.toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('tab', { name: /Transformer paper review/ }));
    expect(editor()).toHaveTextContent('Keep B');
    expect(screen.queryByRole('list', { name: 'Draft attachments' })).toBeNull();
  });

  it('holds native picker selections until the user imports audio or dismisses the disclosure', async () => {
    const user = userEvent.setup();
    const nativeIntake = nativeBridge();
    const picked = deferred<Awaited<ReturnType<NativeIntakeApi['chooseMaterialFiles']>>>();
    nativeIntake.chooseMaterialFiles.mockReturnValueOnce(picked.promise);
    nativeIntake.importSelection.mockResolvedValue(speechAdded('chosen-audio'));
    const { fake, services } = renderKb({ world: chatWorld(), bridge: { nativeIntake } });
    const side = await openA(user);
    await pickFiles(user);
    await user.click(within(side).getByRole('button', { name: /Transformer paper review/ }));
    await act(async () => picked.resolve({
      accepted: [speechSelection('skip.mp4', 'picker'), speechSelection('lecture.mp4', 'picker')], rejected: [],
    }));
    expect(nativeIntake.importSelection).not.toHaveBeenCalled();
    expect(screen.queryByText(LOCAL_VIDEO_AUDIO_ONLY_NOTICE)).toBeNull();
    await user.click(screen.getByRole('tab', { name: /Why is there a logarithm/ }));

    const cancel = within(await videoPrompt('skip.mp4')).getByRole('button', { name: 'Cancel' });
    cancel.focus();
    await user.keyboard('{Escape}');
    expect(nativeIntake.importSelection).not.toHaveBeenCalled();
    const confirm = within(await videoPrompt('lecture.mp4'));
    expect(confirm.getByText(LOCAL_VIDEO_AUDIO_ONLY_NOTICE)).toBeVisible();
    await user.click(confirm.getByRole('button', { name: 'Import audio' }));
    expect(nativeIntake.importSelection).toHaveBeenCalledExactlyOnceWith({
      selectionId: 'lecture.mp4', folderId: 'inbox', toWiki: false,
    });
    expect(nativeIntake.chooseMaterialFiles).toHaveBeenCalledTimes(1);
    expect(services.composer.getState().attachmentDrafts.getState().getDraft('c1').attachments)
      .toMatchObject([{ name: 'lecture.mp4', materialId: 'chosen-audio', state: 'ready' }]);
    expect(outbound(fake.calls)).toEqual([]);
  });

  it('preserves a failed file and its ready sibling when a video replacement is declined', async () => {
    const user = userEvent.setup();
    const nativeIntake = nativeBridge();
    nativeIntake.droppedMaterialFiles.mockResolvedValueOnce({ accepted: [], rejected: [] });
    nativeIntake.chooseMaterialFiles.mockResolvedValue({ accepted: [speechSelection('replacement.mp4', 'picker')], rejected: [] });
    nativeIntake.importSelection.mockResolvedValueOnce({ ok: true, status: 201, data: { material: { id: 'notes', status: 'ready' } } });
    nativeIntake.importSelection.mockResolvedValueOnce(speechAdded('replacement'));
    const { fake, services } = renderKb({ world: chatWorld(), bridge: { nativeIntake } });
    await openA(user);
    fireEvent.drop(conversation(), { dataTransfer: dropData('broken.docx', 'notes.docx') });
    await screen.findByText(/broken.docx: SKAZ couldn’t read/);
    const replace = async () => {
      await user.click(within(row()).getByRole('button', { name: 'View broken.docx' }));
      await user.click(within(screen.getByRole('dialog', { name: 'broken.docx' })).getByRole('button', { name: 'Replace broken.docx' }));
      return within(await videoPrompt('replacement.mp4'));
    };
    await user.click((await replace()).getByRole('button', { name: 'Cancel' }));
    expect(nativeIntake.importSelection).toHaveBeenCalledTimes(1);
    expect(row()).toHaveTextContent('broken.docx');
    expect(row()).toHaveTextContent('notes.docx');
    await user.click((await replace()).getByRole('button', { name: 'Import audio' }));
    expect(nativeIntake.importSelection).toHaveBeenCalledTimes(2);
    expect(nativeIntake.importSelection).toHaveBeenLastCalledWith({ selectionId: 'replacement.mp4', folderId: 'inbox', toWiki: false });
    expect(services.composer.getState().attachmentDrafts.getState().getDraft('c1').attachments.map((item) => item.materialId))
      .toEqual(['notes', 'replacement']);
    expect(outbound(fake.calls)).toEqual([]);
  });

  it('shows the same disclosure on the legacy picker and lets plain audio through normally', async () => {
    const user = userEvent.setup();
    const chooseMaterialFiles = vi.fn().mockResolvedValue([
      { path: '/fixture/legacy.MP4', name: 'legacy.MP4', size: 4 },
      { path: '/fixture/plain.wav', name: 'plain.wav', size: 4 },
    ]);
    const { fake } = renderKb({ world: chatWorld(), bridge: { chooseMaterialFiles } });
    await openA(user);
    await pickFiles(user);
    const prompt = within(await videoPrompt('legacy.MP4'));
    expect(prompt.getByText(LOCAL_VIDEO_AUDIO_ONLY_NOTICE)).toBeVisible();
    const speechImports = () => fake.calls.filter(({ method, path }) => method === 'POST' && path === '/kb/imports').map(({ body }) => body);
    expect(speechImports()).toEqual([expect.objectContaining({ path: '/fixture/plain.wav' })]);
    await user.click(prompt.getByRole('button', { name: 'Import audio' }));
    expect(speechImports()).toEqual([
      expect.objectContaining({ path: '/fixture/plain.wav' }),
      { path: '/fixture/legacy.MP4', folder_id: 'inbox', to_wiki: false },
    ]);
    expect(outbound(fake.calls)).toEqual([]);
  });

  it('keeps mixed and ordinary text, handles internal mentions, and lets a failed file be replaced before sending', async () => {
    const user = userEvent.setup();
    const nativeIntake = nativeBridge();
    nativeIntake.droppedMaterialFiles.mockResolvedValueOnce({ accepted: [], rejected: [] });
    nativeIntake.chooseMaterialFiles.mockResolvedValueOnce({ accepted: [diskSelection('fixed.docx')], rejected: [] });
    const { fake, services } = renderKb({ world: chatWorld(), bridge: { nativeIntake } });
    const side = await openA(user);
    fireEvent.drop(side, { dataTransfer: dropData('sidebar.docx') });
    fireEvent.drop(editor(), { dataTransfer: { types: [ITEMS_MIME, 'Files'], files: [],
      getData: () => JSON.stringify([{ type: 'material', id: 'm1' }]) } });
    expect(editor().querySelector('.kb-token--mention')).toBeTruthy();
    expect(nativeIntake.droppedMaterialFiles).not.toHaveBeenCalled();

    const image = new File(['test'], 'image.png', { type: 'image/png' });
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    Object.defineProperty(image, 'arrayBuffer', { value: async () => bytes });
    const data = (text: string, files: File[] = []) => ({ getData: () => text, items: [], files });
    fireEvent.paste(editor(), { clipboardData: data('ordinary text') });
    fireEvent.paste(editor(), { clipboardData: data('from a mixed paste', [image]) });
    expect(editor()).toHaveTextContent('ordinary text');
    expect(editor()).toHaveTextContent('from a mixed paste');
    await waitFor(() => expect(row()).toHaveTextContent('Screenshot.png'));
    expect(nativeIntake.validateClipboardImage).toHaveBeenCalledWith({ bytes, mimeType: 'image/png' });
    expect(nativeIntake.imagePreview).toHaveBeenCalledWith('clip');

    fireEvent.drop(editor(), { dataTransfer: dropData('unreadable.docx') });
    expect(await screen.findByText(/unreadable.docx: SKAZ couldn’t read/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(outbound(fake.calls)).toEqual([]);
    expect(row()).toHaveTextContent('Screenshot.png');

    await user.click(within(row()).getByRole('button', { name: 'View unreadable.docx' }));
    const dialog = screen.getByRole('dialog', { name: 'unreadable.docx' });
    await user.click(within(dialog).getByRole('button', { name: 'Replace unreadable.docx' }));
    await waitFor(() => expect(row()).toHaveTextContent('fixed.docx'));
    expect(row()).not.toHaveTextContent('unreadable.docx');
    await user.keyboard('{Escape}');
    expect(outbound(fake.calls)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(outbound(fake.calls)).toEqual([
      expect.objectContaining({ path: '/kb/chats/c1/messages', body: expect.objectContaining({ attachments: ['clip', 'fixed.docx'] }) }),
    ]));
    expect(services.composer.getState().attachmentDrafts.getState().getDraft('c1').attachments).toEqual([]);
  });

  it('keeps the original route through slow pasted text preparation and restores only A after a refused send', async () => {
    const user = userEvent.setup();
    const nativeIntake = nativeBridge();
    const { fake } = renderKb({ world: chatWorld(), bridge: { nativeIntake } });
    const side = await openA(user);
    const material = deferred<void>();
    const receipt = deferred<void>();
    const original = fake.bridge.request;
    const attempts: string[] = [];
    fake.bridge.request = async (req) => {
      if (req.method === 'POST' && req.path === '/kb/materials/text') await material.promise;
      if (req.method === 'POST' && /\/messages$/.test(req.path)) {
        attempts.push(req.path);
        if (attempts.length === 1) {
          await receipt.promise;
          return { ok: false, status: 409, detail: 'Fixture refused the send' };
        }
      }
      return original(req);
    };

    fireEvent.drop(conversation(), { dataTransfer: dropData('draft-a.docx') });
    await waitFor(() => expect(row()).not.toHaveTextContent('Preparing'));
    fireEvent.paste(editor(), { clipboardData: { getData: () => 'A'.repeat(2200), items: [], files: [] } });
    await user.click(editor());
    await user.keyboard('A asks{Enter}');
    expect(editor()).toBeEmptyDOMElement();
    expect(editor()).toHaveAttribute('aria-readonly', 'true');

    await user.click(within(side).getByRole('button', { name: /Transformer paper review/ }));
    await user.click(editor());
    await user.keyboard('Keep B');
    fireEvent.drop(conversation(), { dataTransfer: dropData('draft-b.docx') });
    await act(async () => material.resolve());
    await waitFor(() => expect(attempts).toEqual(['/kb/chats/c1/messages']));
    await user.click(screen.getByRole('tab', { name: /Why is there a logarithm/ }));
    const pasteAsText = within(row()).getByRole('button', { name: 'Paste as text' });
    expect(pasteAsText).toBeDisabled();
    fireEvent.click(pasteAsText);
    await user.click(within(row()).getByRole('button', { name: /Show the pasted text/ }));
    const preview = within(await screen.findByRole('dialog', { name: 'Pasted text' }));
    const wiki = preview.getByRole('checkbox', { name: 'In wiki' });
    expect(wiki).toBeDisabled();
    expect(wiki).not.toBeChecked();
    expect(preview.getByRole('button', { name: 'Paste as text' })).toBeDisabled();
    fireEvent.click(wiki);
    fireEvent.click(preview.getByRole('button', { name: 'Paste as text' }));
    expect(wiki).not.toBeChecked();
    expect(editor()).toBeEmptyDOMElement();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('tab', { name: /Transformer paper review/ }));
    await act(async () => receipt.resolve());
    expect(editor()).toHaveTextContent('Keep B');
    expect(row()).toHaveTextContent('draft-b.docx');
    expect(screen.queryByText('Fixture refused the send')).toBeNull();

    await user.click(screen.getByRole('tab', { name: /Why is there a logarithm/ }));
    expect(editor()).toHaveTextContent('A asks');
    expect(row()).toHaveTextContent('draft-a.docx');
    expect(screen.getByText('Fixture refused the send')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(outbound(fake.calls)).toHaveLength(1));
    expect(attempts).toEqual(['/kb/chats/c1/messages', '/kb/chats/c1/messages']);
    expect(outbound(fake.calls)[0]).toMatchObject({ body: { attachments: ['draft-a.docx', expect.stringMatching(/^m-new/)] } });
    expect(screen.queryByRole('list', { name: 'Draft attachments' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: /Transformer paper review/ }));
    expect(editor()).toHaveTextContent('Keep B');
    expect(row()).toHaveTextContent('draft-b.docx');
  });

  it('never redirects a stale drop or an in-flight new-chat creation, and drafts disappear with a fresh app', async () => {
    const user = userEvent.setup();
    const nativeIntake = nativeBridge();
    const { fake, services, unmount } = renderKb({ world: chatWorld(), bridge: { nativeIntake } });
    const side = await openA(user);
    const dataTransfer = dropData('stale.docx');
    fireEvent.dragOver(conversation(), { dataTransfer });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent(conversation(), new MouseEvent('dragleave', { bubbles: true, relatedTarget: side }));
    act(() => services.chats.getState().open('c6'));
    fireEvent.dragOver(conversation(), { dataTransfer });
    fireEvent.drop(conversation(), { dataTransfer });
    expect(nativeIntake.droppedMaterialFiles).not.toHaveBeenCalled();

    const original = fake.bridge.request;
    const creation = deferred<void>();
    let started = false;
    fake.bridge.request = async (req) => {
      if (req.method === 'POST' && req.path === '/kb/chats') {
        started = true;
        await creation.promise;
      }
      return original(req);
    };

    act(() => services.chats.getState().open(null));
    await user.click(editor());
    await user.keyboard('New question{Enter}');
    await waitFor(() => expect(started).toBe(true));
    act(() => services.chats.getState().open('c6'));
    await user.click(editor());
    await user.keyboard('Keep this draft');
    fireEvent.drop(conversation(), { dataTransfer: dropData('keep.docx') });
    await act(async () => creation.resolve());
    await waitFor(() => expect(outbound(fake.calls)).toHaveLength(1));
    expect(services.chats.getState().currentId).toBe('c6');
    expect(outbound(fake.calls)[0]?.path).not.toBe('/kb/chats/c6/messages');
    expect(editor()).toHaveTextContent('Keep this draft');
    expect(row()).toHaveTextContent('keep.docx');
    act(() => services.chats.getState().open(null));
    expect(editor()).toBeEmptyDOMElement();
    expect(screen.queryByRole('list', { name: 'Draft attachments' })).toBeNull();

    unmount();
    const fresh = renderKb({ world: chatWorld(), bridge: { nativeIntake }, keepStorage: true });
    act(() => fresh.services.chats.getState().open('c6'));
    expect(editor()).toBeEmptyDOMElement();
    expect(screen.queryByRole('list', { name: 'Draft attachments' })).toBeNull();
  });
});
