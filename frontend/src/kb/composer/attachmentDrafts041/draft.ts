import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { errorText } from '../../api/client';
import type { Attachment } from '../Attach';

export type DraftAttachment = Attachment & {
  thumbnail?: Blob;
  importVideo?: () => Promise<AttachmentIntakeResult>;
  replaceKey?: string;
};

export interface Draft {
  readonly attachments: readonly DraftAttachment[];
  readonly sending: boolean;
  readonly error: string | null;
}

export type ExternalAttachmentSource = 'drop' | 'clipboard';

/** The trusted adapter owns file validation, material intake and preview production. */
export interface AttachmentIntakeResult {
  id: string;
  ready: boolean;
  existing?: boolean;
  thumbnail?: Blob;
  name?: string;
}

export type PreparedAttachment = AttachmentIntakeResult | {
  name: string;
  importVideo: () => Promise<AttachmentIntakeResult>;
};

export type AttachmentIntake = (input: {
  source: ExternalAttachmentSource;
  file: File;
}) => Promise<PreparedAttachment>;

export interface DraftFile {
  name: string;
  load: () => Promise<PreparedAttachment>;
}

type DraftUpdate = (items: readonly DraftAttachment[]) => readonly DraftAttachment[];

interface AttachmentDraftState {
  readonly drafts: ReadonlyMap<string, Draft>;
  getDraft(chatId: string): Draft;
  update(chatId: string, change: DraftUpdate): void;
  setSending(chatId: string, sending: boolean): void;
  setError(chatId: string, error: string | null): void;
  move(source: string, destination: string): void;
  resolveVideo(chatId: string, itemKey: string, proceed: boolean): boolean;
  addFiles(chatId: string, files: readonly DraftFile[], inWiki: boolean, replaceKey?: string): Promise<void>;
  addExternal(
    chatId: string, source: ExternalAttachmentSource, files: readonly File[], intake: AttachmentIntake, inWiki: boolean,
  ): Promise<void>;
}

const EMPTY_DRAFT: Draft = { attachments: [], sending: false, error: null };
export const NEW_CHAT_DRAFT = 'new';

/** Create once per renderer session. All mutations, including async completions, take a chat key. */
export function createAttachmentDraftStore() {
  let nextKey = 0;
  return createStore<AttachmentDraftState>()((set, get) => {
    const changeDraft = (chatId: string, change: (draft: Draft) => Draft) => set((state) => {
      const previous = state.getDraft(chatId);
      const draft = change(previous);
      if (draft === previous) return state;
      const drafts = new Map(state.drafts);
      if (draft.attachments.length || draft.sending || draft.error) drafts.set(chatId, draft);
      else drafts.delete(chatId);
      return { drafts };
    });
    const loadFile = async (chatId: string, item: DraftAttachment, load: DraftFile['load']) => {
      let outcome: Partial<DraftAttachment>;
      try {
        const added = await load();
        if ('importVideo' in added) {
          outcome = { state: 'confirming', name: added.name, importVideo: added.importVideo };
        } else {
          if (!added.id) throw new Error('The file could not be saved to Materials.');
          outcome = {
            state: 'ready',
            materialId: added.id,
            materialReady: added.ready,
            alreadyInLibrary: added.existing,
            thumbnail: added.thumbnail,
            ...(added.name ? { name: added.name } : {}),
          };
        }
      } catch (error) {
        outcome = { state: 'failed', error: errorText(error) };
      }
      get().update(chatId, (items) => {
        if (!items.some((entry) => entry.key === item.key && entry.state === 'adding')) return items;
        const confirming = outcome.state === 'confirming';
        return items
          .filter((entry) => confirming || entry.key !== item.replaceKey)
          .map((entry) => entry.key === item.key
            ? { ...entry, ...outcome, replaceKey: confirming ? item.replaceKey : undefined }
            : entry);
      });
    };
    const addFiles: AttachmentDraftState['addFiles'] = async (chatId, files, inWiki, replaceKey) => {
      if (!files.length || get().getDraft(chatId).sending) return;
      const { attachments } = get().getDraft(chatId);
      const replaced = attachments.find((item) => item.key === replaceKey && item.state === 'failed');
      if (replaceKey && (!replaced || attachments.some((item) => item.replaceKey === replaceKey))) return;
      const pending = files.map(({ name, load }) => {
        const item: DraftAttachment = {
          key: `external-att-${++nextKey}`,
          name,
          source: 'file',
          state: 'adding',
          materialId: null,
          error: null,
          inWiki: replaced?.inWiki ?? inWiki,
          materialReady: false,
          replaceKey,
        };
        return { load, item };
      });
      // Keep the failed file until a replacement proceeds, so cancelling a video leaves it actionable.
      get().update(chatId, (items) => [...items, ...pending.map(({ item }) => item)]);
      await Promise.all(pending.map(({ load, item }) => loadFile(chatId, item, load)));
    };
    return {
      drafts: new Map(),
      getDraft: (chatId) => get().drafts.get(chatId) ?? EMPTY_DRAFT,
      update: (chatId, change) => changeDraft(chatId, (draft) => {
        const attachments = change(draft.attachments);
        return attachments === draft.attachments ? draft : { ...draft, attachments };
      }),
      setSending: (chatId, sending) => changeDraft(chatId, (draft) =>
        sending === draft.sending ? draft : { ...draft, sending }),
      setError: (chatId, error) => changeDraft(chatId, (draft) =>
        error === draft.error ? draft : { ...draft, error }),
      move: (source, destination) => set((state) => {
        const draft = state.drafts.get(source);
        if (!draft) return state;
        const drafts = new Map(state.drafts);
        drafts.delete(source);
        drafts.set(destination, draft);
        return { drafts };
      }),
      resolveVideo: (chatId, itemKey, proceed) => {
        const { getDraft, update } = get();
        const draft = getDraft(chatId);
        const item = draft.attachments.find((entry) => entry.key === itemKey && entry.state === 'confirming');
        if (draft.sending || !item?.importVideo) return false;
        if (!proceed) {
          update(chatId, (items) => items.filter((entry) => entry.key !== itemKey));
        } else {
          const load = item.importVideo;
          // Consume the decision before entering the import boundary, including on repeated activation.
          update(chatId, (items) => items
            .filter((entry) => entry.key !== item.replaceKey)
            .map((entry) => entry.key === itemKey
              ? { ...entry, state: 'adding', importVideo: undefined, replaceKey: undefined }
              : entry));
          void loadFile(chatId, item, load);
        }
        return true;
      },
      addFiles,
      addExternal: (chatId, source, files, intake, inWiki) => addFiles(chatId, files.map((file) => ({
        name: file.name || (source === 'clipboard' ? 'Clipboard image' : 'Dropped file'),
        load: () => intake({ file, source }),
      })), inWiki),
    };
  });
}

export type AttachmentDraftStore = ReturnType<typeof createAttachmentDraftStore>;

export function useAttachmentDraft(store: AttachmentDraftStore, chatId: string | null): Draft {
  return useStore(store, (state) => chatId === null ? EMPTY_DRAFT : state.drafts.get(chatId) ?? EMPTY_DRAFT);
}

/** Check both in the send handler and when presenting the send control. */
export function attachmentSendBlocker(items: readonly DraftAttachment[]): string | null {
  if (items.some((item) => item.state === 'confirming')) return 'Confirm or cancel the video import before sending.';
  const failed = items.find((item) => item.state === 'failed');
  if (failed) {
    const reason = failed.error || 'Attachment failed.';
    const punctuation = /[.!?]$/.test(reason) ? '' : '.';
    return `${failed.name}: ${reason}${punctuation} Remove or replace before sending.`;
  }
  return items.some((item) => item.state === 'adding') ? 'Preparing attachments…' : null;
}
