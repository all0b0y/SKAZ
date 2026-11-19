import { describe, expect, it, vi } from 'vitest';
import { attachmentSendBlocker, createAttachmentDraftStore, type AttachmentIntakeResult } from './draft';

const file = (name: string) => new File(['fixture'], name);

function pendingIntake() {
  let finish!: (result: AttachmentIntakeResult) => void;
  const result = new Promise<AttachmentIntakeResult>((resolve) => { finish = resolve; });
  return { finish, result };
}

describe('attachment drafts', () => {
  it('settles a delayed intake in the originating chat and starts empty in a new store', async () => {
    const store = createAttachmentDraftStore();
    const slow = pendingIntake();
    const source = file('notes.docx');
    const intake = vi.fn((input: { file: File }) => input.file === source
      ? slow.result : Promise.resolve({ id: 'second', ready: true }));
    const first = store.getState().addExternal('chat-a', 'drop', [source], intake, true);
    expect(attachmentSendBlocker(store.getState().getDraft('chat-a').attachments)).toBe('Preparing attachments…');
    expect(store.getState().getDraft('chat-b').attachments).toEqual([]);

    await store.getState().addExternal('chat-b', 'clipboard', [file('image.png')], intake, false);
    slow.finish({ id: 'first', ready: false, existing: true });
    await first;
    expect(intake).toHaveBeenCalledWith({ file: source, source: 'drop' });
    expect(store.getState().getDraft('chat-a').attachments).toMatchObject([
      { materialId: 'first', materialReady: false, state: 'ready', alreadyInLibrary: true, inWiki: true },
    ]);
    expect(store.getState().getDraft('chat-b').attachments).toMatchObject([{ materialId: 'second', inWiki: false }]);
    expect(createAttachmentDraftStore().getState().getDraft('chat-a').attachments).toEqual([]);
  });

  it('blocks a partial failure until the failed item is removed and retains successful files', async () => {
    const store = createAttachmentDraftStore();
    const { addExternal, getDraft, update } = store.getState();
    const preview = new Blob(['preview'], { type: 'image/png' });
    await addExternal('chat', 'drop', [file('chart.png'), file('broken.heic')], ({ file: offered }) => {
      if (offered.name === 'broken.heic') throw new Error('This image could not be decoded.');
      return Promise.resolve({ id: 'chart', ready: true, thumbnail: preview });
    }, false);

    const draft = getDraft('chat');
    expect(draft.attachments).toMatchObject([
      { materialId: 'chart', thumbnail: preview, state: 'ready' },
      { name: 'broken.heic', state: 'failed', error: 'This image could not be decoded.' },
    ]);
    expect(attachmentSendBlocker(draft.attachments)).toContain('Remove or replace before sending.');
    update('chat', (items) => items.filter((item) => item.state !== 'failed'));
    expect(getDraft('chat').attachments.map((item) => item.materialId)).toEqual(['chart']);
    expect(attachmentSendBlocker(getDraft('chat').attachments)).toBeNull();
  });

  it('does not revive an item removed while its intake was pending', async () => {
    const store = createAttachmentDraftStore();
    const { addExternal, getDraft, update } = store.getState();
    const slow = pendingIntake();
    const first = addExternal('chat', 'drop', [file('notes.docx')], () => slow.result, false);
    update('chat', () => []);
    await addExternal('chat', 'drop', [file('notes.docx')], async () => ({ id: 'replacement', ready: true }), false);
    const replacement = getDraft('chat');
    slow.finish({ id: 'removed', ready: true });
    await first;
    expect(getDraft('chat')).toBe(replacement);
  });
});
