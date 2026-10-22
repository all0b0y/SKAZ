// 0.3.1 S: flashcards and tests — the /kb/study routes over the generated types. A block is a part of
// its chat's message (`KbStudyPart`); every action answers with the block as it is now, which goes
// back into the chat in place (the chat's `part_update` events say the same everywhere else).

import type {
  KbDeckStudy, KbDeckStudyResult, KbDeckView, KbStudyAnswerIn, KbStudyCard, KbStudyMarkIn, KbStudyMove, KbStudyPart,
  KbStudyQuestion, KbStudySettings,
} from '../../api/kb/types.gen';
import type { KbClient } from '../api/client';

export type { KbDeckView, KbStudyCard, KbStudyPart, KbStudyQuestion };
export type StudyGrade = 'again' | 'hard' | 'good' | 'easy';
/**
 * Where a block can be in this interface: in the chat or beside it. The backend still accepts the
 * retired `window` (its own window, removed); such a block shows in the chat and is moved back there.
 */
export type StudyPlace = Exclude<KbStudyPart['place'], 'window'>;
export type StudyMode = KbStudyPart['mode'];
export type StudyMark = KbStudyMarkIn['mark'];

export const GRADES: readonly StudyGrade[] = ['again', 'hard', 'good', 'easy'];
export const GRADE_LABEL: Record<StudyGrade, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };
export const MODE_LABEL: Record<StudyMode, string> = {
  due: 'Due today', new: 'New only', hard: 'Hard only', quick10: 'Quick 10', all: 'Review all',
};
/** Modes that leave the schedule alone, except Again (S9). */
export const PRACTICE: ReadonlySet<StudyMode> = new Set(['hard', 'quick10', 'all']);

export const isStudyPart = (p: { type: string }): p is KbStudyPart => p.type === 'study';

export const studyApi = {
  read: (c: KbClient, id: string) => c.call('GET /kb/study/{block_id}', { path: { block_id: id } }),
  move: (c: KbClient, id: string, body: KbStudyMove) => c.call('PATCH /kb/study/{block_id}', { path: { block_id: id }, body }),
  grade: (c: KbClient, id: string, itemId: string, grade: StudyGrade) =>
    c.call('POST /kb/study/{block_id}/grade', { path: { block_id: id }, body: { item_id: itemId, grade } }),
  mark: (c: KbClient, id: string, itemIds: string[], mark: StudyMark) =>
    c.call('POST /kb/study/{block_id}/mark', { path: { block_id: id }, body: { item_ids: itemIds, mark } }),
  answer: (c: KbClient, id: string, body: KbStudyAnswerIn) => c.call('POST /kb/study/{block_id}/answer', { path: { block_id: id }, body }),
  checkOpen: (c: KbClient, id: string, itemId: string, text: string) =>
    c.call('POST /kb/study/{block_id}/check-open', { path: { block_id: id }, body: { item_id: itemId, text } }),
  finish: (c: KbClient, id: string) => c.call('POST /kb/study/{block_id}/finish', { path: { block_id: id } }),
  retake: (c: KbClient, id: string, mistakesOnly: boolean) =>
    c.call('POST /kb/study/{block_id}/retake', { path: { block_id: id }, body: { mistakes_only: mistakesOnly } }),
  save: (c: KbClient, id: string, decision: 'allow' | 'deny') =>
    c.call('POST /kb/study/{block_id}/save', { path: { block_id: id }, body: { decision } }),
  rename: (c: KbClient, id: string, title: string) =>
    c.call('POST /kb/study/{block_id}/rename', { path: { block_id: id }, body: { title } }),
  deck: (c: KbClient, pageId: string): Promise<KbDeckView> => c.call('GET /kb/study/decks/{page_id}', { path: { page_id: pageId } }),
  markDeck: (c: KbClient, pageId: string, itemIds: string[], mark: StudyMark): Promise<KbDeckView> =>
    c.call('POST /kb/study/decks/{page_id}/marks', { path: { page_id: pageId }, body: { item_ids: itemIds, mark } }),
  studyDeck: (c: KbClient, pageId: string, body: KbDeckStudy): Promise<KbDeckStudyResult> =>
    c.call('POST /kb/study/decks/{page_id}/study', { path: { page_id: pageId }, body }),
  settings: (c: KbClient): Promise<KbStudySettings> => c.call('GET /kb/study/settings'),
  setSettings: (c: KbClient, newPerDay: number): Promise<KbStudySettings> =>
    c.call('PATCH /kb/study/settings', { body: { new_per_day: newPerDay } }),
};

/** "Flashcards" / "Test": what the block is, in words. */
export const kindLabel = (p: Pick<KbStudyPart, 'kind'>): string => (p.kind === 'deck' ? 'Flashcards' : 'Test');

/** Where a block is, as the agent is told (W2). */
export const PLACE_LABEL: Record<StudyPlace, string> = { chat: 'in the chat', panel: 'beside the chat' };

/** The place a block shows in: a stored `window` block is in the chat. */
export const placeOf = (p: Pick<KbStudyPart, 'place'>): StudyPlace => (p.place === 'panel' ? 'panel' : 'chat');

/** "card 3 of 12 · answer side" / "question 4 of 8 · not answered": the chip above the composer. */
export function studyWhere(p: KbStudyPart): string {
  if (p.kind === 'deck') {
    if (p.total === 0) return 'no cards';
    if (p.position >= p.total) return `done · ${p.total} cards`;
    return `card ${p.position + 1} of ${p.total} · ${p.side === 'answer' ? 'answer side' : 'question side'}`;
  }
  if (p.result) return `result · ${formatScore(p.result.correct)} of ${p.result.total}`;
  const q = p.questions[Math.min(p.position, p.questions.length - 1)];
  const state = q?.response?.checked ? 'answered' : 'not answered';
  return `question ${Math.min(p.position, p.total - 1) + 1} of ${p.total} · ${state}`;
}

export const formatScore = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
