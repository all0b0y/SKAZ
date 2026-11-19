import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { Icon } from '../../ui/Icon';
import { hasDragFiles, hasDragItems } from '../../ui/listSelection/dnd';
import type { AttachmentDraftStore, AttachmentIntake } from './draft';
import './attachmentDrafts.css';

type PasteEvent = Pick<ClipboardEvent, 'clipboardData' | 'defaultPrevented' | 'preventDefault'>;

export interface ExternalAttachmentBoundaryOptions {
  /** Pass null when this pane cannot accept attachments. */
  chatId: string | null;
  store: AttachmentDraftStore;
  intake: AttachmentIntake;
  inWiki: boolean;
  acceptsTarget?: (target: EventTarget | null) => boolean;
}

function clipboardImages(clipboard: DataTransfer): File[] {
  const files: File[] = [];
  for (const item of Array.from(clipboard.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files.length ? files : Array.from(clipboard.files ?? []).filter((file) => file.type.startsWith('image/'));
}

function isExternalFileDrag(transfer: DataTransfer | null): boolean {
  return hasDragFiles(transfer) && !hasDragItems(transfer);
}

/** Spread paneHandlers on the chat pane and call handlePaste before normal editor paste handling. */
export function useExternalAttachmentBoundary({ chatId, store, intake, inWiki, acceptsTarget }: ExternalAttachmentBoundaryOptions) {
  const [overChat, setOverChat] = useState<string | null>(null);
  const drag = useRef<{ chatId: string; cancelled: boolean; over: boolean } | null>(null);

  useLayoutEffect(() => {
    if (drag.current && drag.current.chatId !== chatId) {
      drag.current.cancelled = true;
      setOverChat(null);
    }
  }, [chatId]);

  useEffect(() => {
    const finish = () => {
      if (!drag.current) return;
      drag.current = null;
      setOverChat(null);
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current) return;
      drag.current.cancelled = true;
      setOverChat(null);
    };
    const resumePointer = (event: PointerEvent) => {
      // Normal pointer input resumes after an external drop/cancellation outside the window.
      // A dragenter with no related target can also be the old gesture coming back.
      if (event.isTrusted && (event.type === 'pointerdown' || event.buttons === 0)) finish();
    };
    window.addEventListener('keydown', cancel, true);
    window.addEventListener('drop', finish);
    window.addEventListener('dragend', finish);
    window.addEventListener('pointerdown', resumePointer, true);
    window.addEventListener('pointermove', resumePointer, true);
    return () => {
      window.removeEventListener('keydown', cancel, true);
      window.removeEventListener('drop', finish);
      window.removeEventListener('dragend', finish);
      window.removeEventListener('pointerdown', resumePointer, true);
      window.removeEventListener('pointermove', resumePointer, true);
    };
  }, []);

  const insideZone = (pane: HTMLElement, target: EventTarget | null) =>
    target instanceof Node && pane.contains(target) && (acceptsTarget?.(target) ?? true);

  const track = (event: DragEvent<HTMLElement>) => {
    if (chatId === null || event.defaultPrevented || !isExternalFileDrag(event.dataTransfer)) return null;
    if (!insideZone(event.currentTarget, event.target)) return null;
    const active = drag.current ?? (drag.current = { chatId, cancelled: false, over: true });
    active.over = true;
    return active;
  };

  const paneHandlers = {
    onDragEnter: track,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      const active = track(event);
      if (!active) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = active.cancelled ? 'none' : 'copy';
      if (!active.cancelled) setOverChat(active.chatId);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!drag.current) return;
      if (insideZone(event.currentTarget, event.relatedTarget)) return;
      drag.current.over = false;
      setOverChat(null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (chatId === null || event.defaultPrevented || !isExternalFileDrag(event.dataTransfer)) return;
      if (!insideZone(event.currentTarget, event.target)) return;
      event.preventDefault();
      const previous = drag.current;
      drag.current = null;
      setOverChat(null);
      if (previous && (!previous.over || previous.cancelled || previous.chatId !== chatId)) return;
      const files = Array.from(event.dataTransfer.files ?? []);
      void store.getState().addExternal(chatId, 'drop', files, intake, inWiki);
    },
  };

  /** Returns true when an image-only paste replaces ordinary editor paste. Mixed paste keeps both. */
  const handlePaste = (event: PasteEvent): boolean => {
    if (chatId === null || event.defaultPrevented || !event.clipboardData) return false;
    const images = clipboardImages(event.clipboardData);
    if (!images.length) return false;
    const imageOnly = !event.clipboardData.getData('text/plain');
    if (imageOnly) event.preventDefault();
    void store.getState().addExternal(chatId, 'clipboard', images, intake, inWiki);
    return imageOnly;
  };

  return { paneHandlers, handlePaste, over: chatId !== null && overChat === chatId };
}

export function ExternalAttachmentDropOverlay({ visible }: { visible: boolean }) {
  return visible ? (
    <div className="kb-attachment041-drop" role="status">
      <Icon name="upload" size={20} />
      <strong>Drop files to attach</strong>
      <span>Added to this draft.</span>
    </div>
  ) : null;
}
