import { useState, type DragEvent } from 'react';
import { Icon } from '../ui';
import { useServices } from '../state/context';
import { currentDrag, hasDragItems, readDragItems, useItemsDrag } from '../ui/selection/index';

/**
 * The message field as a drop target (0.3.1 F3, mockup lib-v2 «Drag into chat»): wiki pages and
 * materials dragged from a list become @-mentions at the caret, the same tokens MentionPopup makes.
 * Chats can't be attached this way: the field dims and says so. Nothing is sent by itself.
 */
export function useMentionDrop() {
  const { composer, library } = useServices();
  const drag = useItemsDrag();
  const [over, setOver] = useState(false);
  const why = drag && drag.items.some((i) => i.type === 'chat') ? 'Chats can’t be attached — drop pages or materials' : null;
  const handlers = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!hasDragItems(e.dataTransfer) || why) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!over) setOver(true);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!hasDragItems(e.dataTransfer)) return;
      e.preventDefault();
      setOver(false);
      const items = readDragItems(e.dataTransfer);
      if (!items || items.some((i) => i.type === 'chat')) return;
      const titles = new Map((currentDrag()?.items ?? []).map((i) => [`${i.type}:${i.id}`, i.title]));
      const materials = new Map(library.getState().materials.map((m) => [m.id, m.title]));
      composer.getState().push(items.map((i) => ({
        kind: 'mention' as const,
        ref: { type: i.type, id: i.id, title: titles.get(`${i.type}:${i.id}`) ?? (i.type === 'material' ? materials.get(i.id) : undefined) ?? (i.type === 'page' ? 'Page' : 'Material') },
      })), { focus: true });
    },
  };
  const overlay = drag ? (
    <div className={`kb-composer-drop${why ? ' is-off' : ''}`} aria-hidden={!over && !why} role={why ? 'status' : undefined}>
      {why ?? <><Icon name="mention" size={14} />&nbsp;Drop to attach {drag.items.length} to this message</>}
    </div>
  ) : null;
  return { handlers, overlay };
}
