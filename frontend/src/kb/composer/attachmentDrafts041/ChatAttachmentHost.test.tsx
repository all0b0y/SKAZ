import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { kbBridgeHandlers } from '../../../../../electron/kbBridge';
import type { NativeIntakeApi, TrustedMaterialSelection } from '../../../api/bridge';
import type { KbVisualPreflightRequest, KbVisualPreflightResponse } from '../../../api/kb/types.gen';
import { LOCAL_VIDEO_AUDIO_ONLY_NOTICE } from '../../materials/addItems';
import { fragment } from '../../test/fakeKb';
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
  await user.click(screen.getByRole('button', { name: 'Add files or reference' }));
  await user.click(within(await screen.findByRole('listbox', { name: 'References' })).getByRole('option', { name: 'Add files…' }));
}

const videoPrompt = (name: string) => screen.findByRole('group', { name: `Import audio from ${name}` });
const speechAdded = (id: string) => ({ ok: true, status: 201, data: { material_id: id, status: 'ready' } }) as const;

describe('attachments in the production chat', () => {
  it.each([
    { source: 'clipboard', withoutCaption: true, hasText: false, document: 'none' },
    { source: 'picker', withoutCaption: true, hasText: false, document: 'none' },
    { source: 'drop', withoutCaption: true, hasText: false, document: 'none' },
    { source: 'clipboard', withoutCaption: false, hasText: false, document: 'none' },
    { source: 'picker', withoutCaption: false, hasText: false, document: 'default' },
    { source: 'drop', withoutCaption: false, hasText: false, document: 'opt-out' },
    { source: 'picker', withoutCaption: false, hasText: true, document: 'none' },
  ] as const)('sends the saved image from $source (without caption: $withoutCaption, text: $hasText, document: $document) with the intended wiki choices', async ({
    source, withoutCaption, hasText, document,
  }) => {
    const user = userEvent.setup();
    const nativeIntake = nativeBridge();
    const imageName = source === 'clipboard' ? 'Screenshot.png' : 'chart.png';
    const imageId = 'saved-chart';
    const documentName = 'notes.docx';
    const documentId = 'saved-notes';
    const caption = withoutCaption ? '' : 'Describe this chart';
    const imageSelection: TrustedMaterialSelection = {
      ...diskSelection(imageName), ext: 'png', formatId: 'png', category: 'image', route: 'image',
      mimeType: 'image/png', source: source === 'picker' ? 'picker' : 'drop', nativePreviewable: true,
    };
    const documentSelection = { ...diskSelection(documentName), source: imageSelection.source };
    const selections = document === 'none' ? [imageSelection] : [imageSelection, documentSelection];
    const choose = deferred<Awaited<ReturnType<NativeIntakeApi['chooseMaterialFiles']>>>();
    const finishImage = deferred<void>();
    nativeIntake.chooseMaterialFiles.mockReturnValue(choose.promise);
    nativeIntake.droppedMaterialFiles.mockImplementation(async ([file]) => ({
      accepted: selections.filter((selection) => selection.name === file?.name), rejected: [],
    }));
    const { fake, services } = renderKb({ world: chatWorld(), bridge: { nativeIntake } });
    const chat = fake.world.chats.find(({ id }) => id === 'c1')!;
    const priorMessages = chat.messages.length;
    const material = fake.world.materials[0]!;
    nativeIntake.importSelection.mockImplementation(async ({ selectionId }) => {
      const isImage = selectionId !== documentName;
      if (isImage) await finishImage.promise;
      const id = isImage ? imageId : documentId;
      const fragments = !isImage || hasText ? [fragment(id, 1, 'A fixture paragraph.')] : [];
      const saved = {
        ...material, id, title: isImage ? imageName : documentName, kind: isImage ? 'image' : 'docx',
        fragment_count: fragments.length, fragments,
      } as const;
      fake.world.materials.push(saved);
      return { ok: true, status: 201, data: { material: saved, already_in_library: false } };
    });
    const originalRequest = fake.requestMock.getMockImplementation()!;
    const preflights: KbVisualPreflightRequest[] = [];
    fake.requestMock.mockImplementation((request) => {
      if (request.method === 'POST' && request.path === '/kb/chats/visual-preflight') {
        const body = request.body as KbVisualPreflightRequest;
        preflights.push(body);
        const response: KbVisualPreflightResponse = {
          requires_visual: true, supported: true, engine: body.engine!, model_id: body.model!, state: 'supported',
          reason_code: null, title: null, detail: null, text_only_available: hasText,
          draft_preserved: true, locator: null, compatible_models: [],
        };
        return Promise.resolve({ ok: true, status: 200, data: response });
      }
      if (hasText && request.method === 'POST' && request.path === `/kb/materials/${imageId}/ingest`) {
        fake.calls.push(request);
        return Promise.resolve({ ok: false, status: 503, detail: 'Fixture wiki service unavailable.' });
      }
      return originalRequest(request);
    });
    const draft = () => services.composer.getState().attachmentDrafts.getState();
    const wikiCalls = () => fake.calls.filter(({ method, path }) => method === 'POST' && path.endsWith('/ingest'))
      .map(({ path }) => path);
    const send = () => screen.getByRole('button', { name: 'Send' });

    await openA(user);
    if (source === 'clipboard') {
      const image = new File(['fixture'], imageName, { type: 'image/png' });
      Object.defineProperty(image, 'arrayBuffer', { value: async () => new ArrayBuffer(4) });
      expect(nativeIntake.importSelection).not.toHaveBeenCalled();
      fireEvent.paste(editor(), { clipboardData: { getData: () => caption, items: [], files: [image] } });
    } else {
      fireEvent.input(editor(), { target: { innerHTML: caption } });
      if (source === 'picker') {
        await pickFiles(user);
        expect(nativeIntake.importSelection).not.toHaveBeenCalled();
        await act(async () => choose.resolve({ accepted: selections, rejected: [] }));
      } else {
        const dataTransfer = dropData(...selections.map(({ name }) => name));
        fireEvent.dragEnter(conversation(), { dataTransfer });
        expect(nativeIntake.importSelection).not.toHaveBeenCalled();
        fireEvent.drop(conversation(), { dataTransfer });
      }
    }
    const imageChip = (await within(row()).findByTitle(imageName)).closest('li')!;
    expect(imageChip).toHaveAttribute('data-state', 'adding');
    const details = () => within(imageChip);
    expect.soft(details().queryByRole('checkbox', { name: /^In wiki/ })).toBeNull();
    await act(async () => finishImage.resolve());
    await waitFor(() => expect(imageChip).toHaveAttribute('data-state', 'ready'));
    const savedImage = draft().getDraft('c1').attachments[0];
    expect(savedImage).toMatchObject({ materialId: imageId, thumbnail: { type: 'image/png' } });
    expect.soft(savedImage?.inWiki).toBe(hasText);
    if (hasText) expect(details().getByRole('checkbox', { name: /^In wiki/ })).toBeChecked();
    else expect.soft(details().queryByRole('checkbox', { name: /^In wiki/ })).toBeNull();
    if (document !== 'none') {
      const wiki = within(row()).getByRole('checkbox', { name: `In wiki: ${documentName}` });
      expect(wiki).toBeChecked();
      if (document === 'opt-out') {
        await user.click(wiki);
        expect(wiki).not.toBeChecked();
      }
    }
    if (source === 'drop') {
      // Simulate a stale checked value arriving after eligibility was resolved.
      act(() => draft().update('c1', (items) => items.map((item) => item.materialId === imageId ? { ...item, inWiki: true } : item)));
    }

    const attachments = document === 'none' ? [imageId] : [imageId, documentId];
    expect(nativeIntake.importSelection.mock.calls.map(([input]) => input)).toEqual(
      (source === 'clipboard' ? ['clip'] : selections.map(({ selectionId }) => selectionId))
        .map((selectionId) => ({ selectionId, folderId: expect.any(String), toWiki: false })),
    );
    expect(outbound(fake.calls)).toEqual([]);
    expect(wikiCalls()).toEqual([]);
    expect(chat.messages).toHaveLength(priorMessages);
    expect(editor().textContent).toBe(caption);
    expect(send()).not.toHaveAttribute('aria-disabled', 'true');

    await user.click(send());
    await waitFor(() => expect(draft().getDraft('c1').attachments).toEqual([]));
    expect(preflights).toContainEqual(expect.objectContaining({ chat_id: 'c1', text: caption, attachments }));
    expect(outbound(fake.calls)).toEqual([expect.objectContaining({
      path: '/kb/chats/c1/messages', body: expect.objectContaining({ text: caption, attachments }),
    })]);
    expect(chat.messages.slice(priorMessages).filter(({ role }) => role === 'user')).toEqual([
      expect.objectContaining({ input: expect.objectContaining({ text: caption, attachments }) }),
    ]);
    expect.soft(wikiCalls()).toEqual([
      ...(hasText ? [`/kb/materials/${imageId}/ingest`] : []),
      ...(document === 'default' ? [`/kb/materials/${documentId}/ingest`] : []),
    ]);
    expect(fake.world.jobs.filter(({ material_id }) => material_id === documentId))
      .toHaveLength(document === 'default' ? 1 : 0);
    if (hasText) expect(await screen.findByText(/Fixture wiki service unavailable/)).toBeVisible();
    else expect.soft(screen.queryByText(/is saved to Materials but couldn’t go to the wiki yet/)).toBeNull();
  });

  it('bounds overlapping drops and keeps same-name and unresolved files attributable to their own rows', async () => {
    const user = userEvent.setup();
    const nativeIntake = nativeBridge();
    const files = ['same.docx', 'missing.docx', 'same.docx', 'notes.docx', 'other.docx', 'last.docx']
      .map((name, i) => new File([String(i)], name));
    const admissions = files.map(() => deferred<void>());
    const imports = deferred<void>();
    let pending = 0;
    let peak = 0;
    nativeIntake.droppedMaterialFiles.mockImplementation(async ([file]) => {
      const index = files.indexOf(file!);
      peak = Math.max(peak, ++pending);
      await admissions[index]!.promise;
      if (index === 1) {
        pending--;
        return { accepted: [], rejected: [] };
      }
      return { accepted: [{ ...diskSelection(file!.name), selectionId: `file-${index}` }], rejected: [] };
    });
    const importSelection = nativeIntake.importSelection.getMockImplementation()!;
    nativeIntake.importSelection.mockImplementation(async (request) => {
      await imports.promise;
      pending--;
      return importSelection(request);
    });
    const { fake, services } = renderKb({ world: chatWorld(), bridge: { nativeIntake } });
    await openA(user);
    for (const batch of [files.slice(0, 3), files.slice(3)]) {
      fireEvent.drop(conversation(), { dataTransfer: { types: ['Files'], files: batch } });
    }
    const observedAtAdmission = pending;
    await act(async () => {
      admissions[0]!.resolve();
      admissions[2]!.resolve();
      admissions[3]!.resolve();
    });
    const observedDuringImport = nativeIntake.droppedMaterialFiles.mock.calls.length;
    await act(async () => {
      for (const admission of admissions) admission.resolve();
      imports.resolve();
    });
    await waitFor(() => expect(row()).not.toHaveTextContent('Preparing'));
    expect(observedAtAdmission).toBe(4);
    expect(observedDuringImport).toBe(4);
    expect(peak).toBe(4);
    expect(pending).toBe(0);
    const draft = services.composer.getState().attachmentDrafts.getState().getDraft('c1');
    expect(draft.attachments.map(({ name, materialId, state }) => [name, materialId, state])).toEqual([
      ['same.docx', 'file-0', 'ready'],
      ['missing.docx', null, 'failed'],
      ['same.docx', 'file-2', 'ready'],
      ['notes.docx', 'file-3', 'ready'],
      ['other.docx', 'file-4', 'ready'],
      ['last.docx', 'file-5', 'ready'],
    ]);
    expect(screen.getByRole('alert')).toHaveTextContent('missing.docx: SKAZ couldn’t read');
    expect(outbound(fake.calls)).toEqual([]);
  });

  it.each([true, false])('keeps a clipboard HEIC ready and reports the preview result (available: %s)', async (available) => {
    const user = userEvent.setup();
    const bytes = Uint8Array.from(readFileSync('electron/nativeIntake041/fixtures/sample-chart.heic'));
    const png = Uint8Array.from(readFileSync('electron/nativeIntake041/fixtures/sample-chart.png'));
    const fetchFixture = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/kb/materials/clipboard-image?')) {
        return Response.json({ material: { id: 'pasted-chart', status: 'ready' } }, { status: 201 });
      }
      if (String(url).endsWith('/kb/materials/image-preview')) {
        return available
          ? new Response(png, { headers: { 'Content-Type': 'image/png' } })
          : Response.json({ detail: 'Fixture preview is unavailable' }, { status: 422 });
      }
      throw new Error(`Unexpected fixture request: ${String(url)}`);
    });
    const nativeIntake = kbBridgeHandlers({
      handle: () => ({ port: 5432, token: 'fixture' }),
      fetch: fetchFixture,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
      writeTextFile: () => {},
      fileSize: () => null,
      realPath: () => null,
      readHeader: () => null,
      documentsDir: '/fixture/documents',
      downloadsDir: '/fixture/downloads',
      materialExtensions: [],
      newId: () => 'clipboard-selection',
    });
    const { fake, services } = renderKb({ world: chatWorld(), bridge: {
      nativeIntake: {
        chooseMaterialFiles: nativeIntake.chooseMaterialBatch,
        droppedMaterialFiles: async () => ({ accepted: [], rejected: [] }),
        validateClipboardImage: async (input) => nativeIntake.validateClipboardImage(input),
        importSelection: nativeIntake.importSelection,
        imagePreview: nativeIntake.imagePreview,
      },
    } });
    await openA(user);
    const image = new File([bytes], 'sample-chart.heic', { type: 'image/heic' });
    Object.defineProperty(image, 'arrayBuffer', { value: async () => bytes.buffer });
    fireEvent.paste(editor(), { clipboardData: { getData: () => '', items: [], files: [image] } });
    const card = await within(row()).findByTitle('sample-chart.heic');
    await waitFor(() => expect(card.closest('li')).toHaveAttribute('data-state', 'ready'));
    const [item] = services.composer.getState().attachmentDrafts.getState().getDraft('c1').attachments;
    expect(item).toMatchObject({ materialId: 'pasted-chart', state: 'ready' });
    expect(Buffer.compare(fetchFixture.mock.calls[0]![1]!.body as Buffer, Buffer.from(bytes))).toBe(0);
    if (available) {
      expect(item?.thumbnail).toMatchObject({ type: 'image/png', size: png.byteLength });
    } else {
      expect(item?.thumbnail).toBeFalsy();
      expect(card.querySelector('img')).toBeNull();
    }
    await user.click(card);
    expect(screen.queryByRole('dialog', { name: image.name })).toBeNull();
    expect(fetchFixture).toHaveBeenCalledTimes(2);
    expect(fetchFixture).toHaveBeenLastCalledWith(
      'http://127.0.0.1:5432/kb/materials/image-preview',
      expect.objectContaining({ body: JSON.stringify({ material_id: 'pasted-chart' }) }),
    );
    expect(await nativeIntake.imagePreview('pasted-chart')).toMatchObject({ ok: false, status: 403 });
    expect(fetchFixture).toHaveBeenCalledTimes(2);
    expect(outbound(fake.calls)).toEqual([]);
  });

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
      await user.click(within(row()).getByRole('button', { name: 'Replace broken.docx' }));
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

    await user.click(within(row()).getByRole('button', { name: 'Replace unreadable.docx' }));
    await waitFor(() => expect(row()).toHaveTextContent('fixed.docx'));
    expect(row()).not.toHaveTextContent('unreadable.docx');
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

  it('restores a refused first send to the created chat after a tab switch and retries on that same ID', async () => {
    const user = userEvent.setup();
    const nativeIntake = nativeBridge();
    const { fake, services } = renderKb({ world: chatWorld(), bridge: { nativeIntake } });
    const side = await openA(user);
    const creation = deferred<void>();
    const original = fake.bridge.request;
    let creates = 0;
    const attempts: Array<{ path: string; body: unknown }> = [];
    fake.bridge.request = async (req) => {
      if (req.method === 'POST' && req.path === '/kb/chats') {
        creates++;
        await creation.promise;
      }
      if (req.method === 'POST' && /\/messages$/.test(req.path)) {
        attempts.push({ path: req.path, body: req.body });
        if (attempts.length < 3) return { ok: false, status: 409, detail: 'Fixture refused the first message' };
      }
      return original(req);
    };

    act(() => services.chats.getState().open(null));
    fireEvent.drop(conversation(), { dataTransfer: dropData('new-chat.docx') });
    await waitFor(() => expect(row()).not.toHaveTextContent('Preparing'));
    await user.click(editor());
    await user.keyboard('Keep the first question{Enter}');
    await waitFor(() => expect(creates).toBe(1));
    await user.click(within(side).getByRole('button', { name: /Transformer paper review/ }));
    await user.click(editor());
    await user.keyboard('Keep this other draft');
    await act(async () => creation.resolve());

    expect(services.chats.getState().currentId).toBe('c6');
    expect(editor()).toHaveTextContent('Keep this other draft');
    expect(screen.queryByText('Fixture refused the first message')).toBeNull();
    expect(attempts).toHaveLength(1);
    const createdId = attempts[0]!.path.split('/')[3]!;
    expect(createdId).not.toBe('c6');
    const created = services.chats.getState().chats[createdId]!.chat!;
    await user.click(screen.getByRole('tab', { name: created.title }));
    expect(editor()).toHaveTextContent('Keep the first question');
    expect(row()).toHaveTextContent('new-chat.docx');
    expect(screen.getByText('Fixture refused the first message')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(attempts).toHaveLength(2));
    expect(editor()).toHaveTextContent('Keep the first question');
    expect(row()).toHaveTextContent('new-chat.docx');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(outbound(fake.calls)).toHaveLength(1));
    expect(creates).toBe(1);
    expect(attempts).toEqual(Array.from({ length: 3 }, () => ({
      path: `/kb/chats/${createdId}/messages`,
      body: expect.objectContaining({ text: 'Keep the first question', attachments: ['new-chat.docx'] }),
    })));
    expect(screen.queryByRole('list', { name: 'Draft attachments' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: /Transformer paper review/ }));
    expect(editor()).toHaveTextContent('Keep this other draft');
  });
});
