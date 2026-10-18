// 0.3.1 S: a study block as its chat has it now, its actions, and its one place (W2, A-4).

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { errorText } from '../api/client';
import type { ActionResult } from '../state/library';
import { useChats, useServices, useUi } from '../state/context';
import { partsOf } from '../api/permissions';
import { isStudyPart, studyApi, type KbStudyPart, type StudyPlace } from './api';

/** The block in its chat (live: a grade in one window shows in the other). */
export function useStudyPart(chatId: string, studyId: string): KbStudyPart | null {
  return useChats((s) => findStudy(s.chats[chatId]?.chat?.messages ?? [], studyId));
}

export function findStudy(messages: ReadonlyArray<{ parts: readonly { type: string }[] }>, studyId: string): KbStudyPart | null {
  for (const m of messages) {
    const part = (m.parts as ReturnType<typeof partsOf>).find((p) => isStudyPart(p) && p.id === studyId);
    if (part) return part as KbStudyPart;
  }
  return null;
}

/** Every study block of a chat, oldest first. */
export function studyParts(messages: ReadonlyArray<{ parts: readonly { type: string }[] }>): KbStudyPart[] {
  return messages.flatMap((m) => (m.parts as ReturnType<typeof partsOf>).filter(isStudyPart) as KbStudyPart[]);
}

/**
 * What the agent is told is open (W2 "Agent sees"): the block beside the chat or in its window;
 * otherwise the block of this chat the user worked with last, unless its chip was closed.
 */
export function useOpenStudy(chatId: string | null): KbStudyPart | null {
  const messages = useChats((s) => (chatId ? s.chats[chatId]?.chat?.messages : undefined));
  const focus = useUi((s) => (chatId ? s.studyFocus[chatId] : undefined));
  return useMemo(() => {
    if (!messages) return null;
    const parts = studyParts(messages);
    const away = parts.find((p) => p.place !== 'chat');
    if (away) return away;
    if (!focus?.on) return null;
    return parts.find((p) => p.id === focus.id) ?? null;
  }, [messages, focus]);
}

export interface StudyActions {
  /** Run one /kb/study call; its answer replaces the block in the chat. */
  run: (call: () => Promise<KbStudyPart>) => Promise<ActionResult<KbStudyPart>>;
  /** Put the block in the store as it should look now (before the request answers). */
  optimistic: (part: KbStudyPart) => void;
}

export function useStudyActions(chatId: string, studyId: string): StudyActions {
  const { chats, ui } = useServices();
  const optimistic = useCallback((part: KbStudyPart) => chats.getState().applyPart(chatId, part), [chats, chatId]);
  const run = useCallback(async (call: () => Promise<KbStudyPart>): Promise<ActionResult<KbStudyPart>> => {
    ui.getState().focusStudy(chatId, studyId);
    try {
      const part = await call();
      chats.getState().applyPart(chatId, part);
      return { ok: true, value: part };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }, [chats, ui, chatId, studyId]);
  return { run, optimistic };
}

/**
 * Move a block to the chat, beside it or into its window (W2). The block is never in two places:
 * the store shows it in the new place at once, the right panel and the window follow, and the
 * backend records it (A-4: a block already away goes back to the chat there, and its update arrives).
 */
export function useStudyRoute(chatId: string): (part: KbStudyPart, to: StudyPlace) => Promise<ActionResult<KbStudyPart>> {
  const { client, chats, ui, bridge } = useServices();
  return useCallback(async (part, to) => {
    if (part.place === to) return { ok: true, value: part };
    const from = part.place;
    chats.getState().applyPart(chatId, { ...part, place: to });
    ui.getState().focusStudy(chatId, part.id);
    const right = ui.getState().right;
    const shownBeside = right?.kind === 'study' && right.studyId === part.id;
    if (to === 'panel') ui.getState().openStudy(chatId, part.id);
    else if (shownBeside) ui.getState().closeDoc();
    if (from === 'window' && !bridge.studyWindow) void bridge.closeStudyWindow?.();
    try {
      const moved = await studyApi.move(client, part.id, { place: to });
      // The window itself is opened (and closed) by `useStudyPlacement`, which follows the place.
      chats.getState().applyPart(chatId, moved);
      return { ok: true, value: moved };
    } catch (error) {
      chats.getState().applyPart(chatId, part);
      if (to === 'panel') ui.getState().closeDoc();
      return { ok: false, error: errorText(error) };
    }
  }, [client, chats, ui, bridge, chatId]);
}

/**
 * Keeps the main window in step with where the blocks of the open chat are (W2): a block beside
 * the chat is shown in the right panel (after a restart, from a deck page's "Study", from its
 * window's book button); one whose panel was closed or replaced goes back into the chat; a block in
 * its own window has that window, and closing the window brings it back. Main window only.
 */
export function useStudyPlacement(): void {
  const { chats, ui, bridge, client } = useServices();
  const chatId = useChats((s) => s.currentId);
  const messages = useChats((s) => (s.currentId ? s.chats[s.currentId]?.chat?.messages : undefined));
  const right = useUi((s) => s.right);
  const parts = useMemo(() => (messages ? studyParts(messages) : []), [messages]);
  const beside = parts.find((p) => p.place === 'panel') ?? null;
  // The one block in its own window, in whichever loaded chat it is (A-4: one away at a time).
  const windowKey = useChats((s) => {
    for (const [id, open] of Object.entries(s.chats)) {
      const part = studyParts(open.chat?.messages ?? []).find((p) => p.place === 'window');
      if (part) return `${id}/${part.id}`;
    }
    return null;
  });
  const shownId = right?.kind === 'study' ? right.studyId : null;
  const lastShown = useRef<{ chatId: string; studyId: string } | null>(null);

  const bringBack = useCallback((chat: string, studyId: string, expected: StudyPlace) => {
    const part = findStudy(chats.getState().chats[chat]?.chat?.messages ?? [], studyId);
    if (!part || part.place !== expected) return;
    chats.getState().applyPart(chat, { ...part, place: 'chat' });
    void studyApi.move(client, studyId, { place: 'chat' }).then(
      (moved) => chats.getState().applyPart(chat, moved),
      () => chats.getState().applyPart(chat, part),
    );
  }, [chats, client]);

  // The panel was closed (✕, Esc) or now shows something else: its block goes back into the chat.
  useEffect(() => {
    const before = lastShown.current;
    lastShown.current = right?.kind === 'study' ? { chatId: right.chatId, studyId: right.studyId } : null;
    if (before && before.studyId !== shownId) bringBack(before.chatId, before.studyId, 'panel');
  }, [right, shownId, bringBack]);

  // A block that is beside the chat but not shown there: show it.
  useEffect(() => {
    if (chatId && beside && shownId !== beside.id) ui.getState().openStudy(chatId, beside.id);
  }, [chatId, beside, shownId, ui]);

  // The block in its own window has that window (main focuses an open one instead of a second);
  // when no block is in a window any more (brought back here, replaced by another), it closes.
  const hadWindow = useRef(false);
  useEffect(() => {
    if (!bridge.openStudyWindow) return;
    if (!windowKey) {
      if (hadWindow.current) void bridge.closeStudyWindow?.();
      hadWindow.current = false;
      return;
    }
    hadWindow.current = true;
    const [chat, studyId] = windowKey.split('/') as [string, string];
    void bridge.openStudyWindow({ studyId, chatId: chat });
  }, [windowKey, bridge]);

  // Closing that window brings its block back into the chat.
  useEffect(() => bridge.onStudyWindowClosed?.((target) => bringBack(target.chatId, target.studyId, 'window')),
    [bridge, bringBack]);
}
