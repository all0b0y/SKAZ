// 0.3.1 S: a study block as its chat has it now, its actions, and its one place (W2, A-4).

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { errorText } from '../api/client';
import type { ActionResult } from '../state/library';
import { useChats, useServices, useUi } from '../state/context';
import { partsOf } from '../api/permissions';
import { isStudyPart, studyApi, type KbStudyPart, type StudyPlace } from './api';

/** The block in its chat (live: the chat's updates show at once, wherever the block is). */
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
 * What the agent is told is open (W2 "Agent sees"): the block beside the chat; otherwise the block
 * of this chat the user worked with last, unless its chip was closed.
 */
export function useOpenStudy(chatId: string | null): KbStudyPart | null {
  const messages = useChats((s) => (chatId ? s.chats[chatId]?.chat?.messages : undefined));
  const focus = useUi((s) => (chatId ? s.studyFocus[chatId] : undefined));
  return useMemo(() => {
    if (!messages) return null;
    const parts = studyParts(messages);
    const away = parts.find((p) => p.place === 'panel');
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
 * Move a block into the chat or beside it (W2). The block is never in two places: the store shows
 * it in the new place at once, the right panel follows, and the backend records it (A-4: a block
 * already away goes back to the chat there, and its update arrives).
 */
export function useStudyRoute(chatId: string): (part: KbStudyPart, to: StudyPlace) => Promise<ActionResult<KbStudyPart>> {
  const { client, chats, ui } = useServices();
  return useCallback(async (part, to) => {
    if (part.place === to) return { ok: true, value: part };
    chats.getState().applyPart(chatId, { ...part, place: to });
    ui.getState().focusStudy(chatId, part.id);
    const right = ui.getState().right;
    const shownBeside = right?.kind === 'study' && right.studyId === part.id;
    if (to === 'panel') ui.getState().openStudy(chatId, part.id);
    else if (shownBeside) ui.getState().closeDoc();
    try {
      const moved = await studyApi.move(client, part.id, { place: to });
      chats.getState().applyPart(chatId, moved);
      return { ok: true, value: moved };
    } catch (error) {
      chats.getState().applyPart(chatId, part);
      if (to === 'panel') ui.getState().closeDoc();
      return { ok: false, error: errorText(error) };
    }
  }, [client, chats, ui, chatId]);
}

/**
 * Keeps the window in step with where the blocks of the open chat are (W2): a block beside the chat
 * is shown in the right panel (after a restart, from a deck page's "Study"); one whose panel was
 * closed or replaced goes back into the chat. A block stored in the retired own window (`window`,
 * still legal in the backend) shows in the chat; the first time it is seen the backend is told it
 * is there, so the agent isn't told "in its own window" (a failed call changes nothing visible).
 */
export function useStudyPlacement(): void {
  const { chats, ui, client } = useServices();
  const chatId = useChats((s) => s.currentId);
  const messages = useChats((s) => (s.currentId ? s.chats[s.currentId]?.chat?.messages : undefined));
  const right = useUi((s) => s.right);
  const parts = useMemo(() => (messages ? studyParts(messages) : []), [messages]);
  const beside = parts.find((p) => p.place === 'panel') ?? null;
  const shownId = right?.kind === 'study' ? right.studyId : null;
  const lastShown = useRef<{ chatId: string; studyId: string } | null>(null);
  /** Blocks once in the retired own window already sent back to the chat (once per block). */
  const settled = useRef(new Set<string>());

  const bringBack = useCallback((chat: string, studyId: string) => {
    const part = findStudy(chats.getState().chats[chat]?.chat?.messages ?? [], studyId);
    if (!part || part.place !== 'panel') return;
    chats.getState().applyPart(chat, { ...part, place: 'chat' });
    void studyApi.move(client, studyId, { place: 'chat' }).then(
      (moved) => chats.getState().applyPart(chat, moved),
      () => chats.getState().applyPart(chat, part),
    );
  }, [chats, client]);

  // The panel was closed (Esc) or now shows something else: its block goes back into the chat.
  useEffect(() => {
    const before = lastShown.current;
    lastShown.current = right?.kind === 'study' ? { chatId: right.chatId, studyId: right.studyId } : null;
    if (before && before.studyId !== shownId) bringBack(before.chatId, before.studyId);
  }, [right, shownId, bringBack]);

  // A block that is beside the chat but not shown there: show it. Read the store again — the effect
  // above may just have brought this very block back (its panel was closed or replaced).
  useEffect(() => {
    if (!chatId || !beside || shownId === beside.id) return;
    if (findStudy(chats.getState().chats[chatId]?.chat?.messages ?? [], beside.id)?.place !== 'panel') return;
    ui.getState().openStudy(chatId, beside.id);
  }, [chatId, beside, shownId, ui, chats]);

  // A block left in the retired own window: the backend is told it is in the chat, once.
  useEffect(() => {
    if (!chatId) return;
    for (const part of parts) {
      if (part.place !== 'window' || settled.current.has(part.id)) continue;
      settled.current.add(part.id);
      void studyApi.move(client, part.id, { place: 'chat' }).then(
        (moved) => chats.getState().applyPart(chatId, moved),
        () => undefined,
      );
    }
  }, [chatId, parts, chats, client]);
}
