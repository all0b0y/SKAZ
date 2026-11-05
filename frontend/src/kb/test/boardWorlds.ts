// Fixture worlds and fixture data of the dev-only design board (kb/board, layers 3–4). Built on the
// worlds of fixtures.ts (never edited for the board) and in the generated contract's shapes, so the
// real components show them exactly as they would show the backend's answers. Pure — no test-runner
// imports, no React.

import type { KbMessage } from '../../api/kb/types.gen';
import type { Attachment } from '../composer/Attach';
import type { KbPermissionPart, KbQuestionPart } from '../api/permissions';
import { chatMessage, type FakeWorld } from './fakeKb';
import { agentControlsWorld, ago, chatWorld, docWorld, permissionPart, questionPart, unconfiguredWorld } from './fixtures';

/** The worlds a board pattern or screen can start from (each call gives a fresh copy). */
export const BOARD_WORLDS = {
  /** Chats with an answer, the notification feed with decisions, settings with one problem. */
  chat: chatWorld,
  /** `chat` plus chats where the agent waits for you (a permission, a question) and decided requests. */
  agentControls: agentControlsWorld,
  /** The library: wiki pages, materials of every kind and state (processing, ready, failed), the graph. */
  doc: docWorld,
  /** First launch: no library yet. */
  firstLaunch: unconfiguredWorld,
} satisfies Record<string, () => FakeWorld>;

export type BoardWorldId = keyof typeof BOARD_WORLDS;

export function boardWorld(id: BoardWorldId): FakeWorld {
  return BOARD_WORLDS[id]();
}

/** The chat whose answer has citation marks, a page chip and a connection block (chatWorld «c1»). */
export const ANSWER_CHAT = 'c1';

/** The messages of the chat exchange pattern: the states one answer can be in. */
export function exchangeMessages(world: FakeWorld = chatWorld()): {
  question: KbMessage; answer: KbMessage; thinking: KbMessage; interrupted: KbMessage; stopped: KbMessage;
} {
  const chat = world.chats.find((c) => c.id === ANSWER_CHAT);
  const [question, answer] = chat?.messages ?? [];
  if (!question || !answer) throw new Error('chatWorld lost the answered chat c1');
  return {
    question,
    answer,
    // The agent is working and has written nothing yet: «Writing an answer…» with the indicator.
    thinking: chatMessage('board-think', 3, 'assistant', ago(1), [], { state: 'streaming' }),
    interrupted: chatMessage('board-limit', 4, 'assistant', ago(1), [
      { type: 'text', text: 'Cross-entropy compares the distribution the model predicts with the true one, and ' },
    ], {
      state: 'interrupted',
      failure: { kind: 'limit', message: 'Claude Code reached the limit of your subscription.', retry_at: null },
    }),
    stopped: chatMessage('board-stop', 5, 'assistant', ago(1), [
      { type: 'text', text: 'In short: the logarithm turns products of probabilities into sums' },
    ], { state: 'cancelled' }),
  };
}

/** The agent's requests of the permission pattern, in every status a card has. */
export function permissionStates(): Array<{ label: string; chatId: string; part: KbPermissionPart }> {
  return [
    { label: 'Edit · waiting for you', chatId: 'c8', part: permissionPart('board-perm-edit') },
    {
      label: 'Delete · waiting for you', chatId: 'c11', part: permissionPart('board-perm-del', {
        kind: 'delete', title: 'Spike', page_id: 'p-spike', summary: { added: 0, changed: 0, removed: 3, user_notes_untouched: true },
        changes: [{ op: 'remove', block_id: null, label: 'Whole page', block_kind: 'page', before: '“Spike” — 3 blocks, made by the agent', after: null }],
      }),
    },
    { label: 'Allowed in this chat', chatId: 'c10', part: permissionPart('board-perm-auto', { status: 'allowed', auto: true, title: 'Cross-entropy', page_id: 'p-xent' }) },
    { label: 'Denied with a reason', chatId: 'c10', part: permissionPart('board-perm-denied', { status: 'denied', reason: 'Only from the lecture, no comparisons' }) },
    { label: 'Cancelled', chatId: 'c10', part: permissionPart('board-perm-cancel', { kind: 'create', status: 'cancelled', title: 'Microstate', page_id: null }) },
  ];
}

/** The agent's questions of the question pattern, in every status a block has. */
export function questionStates(): Array<{ label: string; chatId: string; part: KbQuestionPart }> {
  return [
    { label: 'Waiting for an answer', chatId: 'c9', part: questionPart('board-q-wait') },
    { label: 'Answered with an option', chatId: 'c9', part: questionPart('board-q-done', { status: 'answered', answer: 'Hard cards first' }) },
    { label: 'Answered in your own words', chatId: 'c9', part: questionPart('board-q-own', { status: 'answered', answer: 'Only the formulas, please' }) },
    { label: 'You wrote your own message', chatId: 'c9', part: questionPart('board-q-super', { status: 'superseded' }) },
    { label: 'Cancelled', chatId: 'c9', part: questionPart('board-q-cancel', { status: 'cancelled' }) },
  ];
}

/** Attachments of the composer pattern (the composer's own draft shape): one ready, one saving, one failed. */
export function composerAttachments(): Attachment[] {
  const base = { source: 'file' as const, error: null, inWiki: true, materialReady: true };
  return [
    { ...base, key: 'board-att-1', name: 'Information theory ch2.pdf', state: 'ready', materialId: 'm2' },
    { ...base, key: 'board-att-2', name: 'lecture-9.m4a', state: 'adding', materialId: null, inWiki: false, materialReady: false },
    { ...base, key: 'board-att-3', name: 'slides.key', state: 'failed', materialId: null, error: 'This file type can’t be read.' },
  ];
}

/** The text typed into the composer in the «with text» state. */
export const COMPOSER_TEXT = 'How is Boltzmann’s entropy related to the cross-entropy loss?';
