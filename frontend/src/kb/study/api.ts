// 0.3.1 S: flashcards and tests — the /kb/study routes over the generated types. A block is a part of
// its chat's message (`KbStudyPart`); every action answers with the block as it is now, which goes
// back into the chat in place (the chat's `part_update` events say the same everywhere else).

import type {
  KbDeckStudy, KbDeckStudyResult, KbDeckView, KbStudyAnswerIn, KbStudyCard, KbStudyLibrary, KbStudyMarkIn,
  KbStudyMove, KbStudyOption, KbStudyPart, KbStudyQuestion, KbStudySettings,
} from '../../api/kb/types.gen';
import type { KbClient } from '../api/client';

export type { KbDeckView, KbStudyCard, KbStudyOption, KbStudyPart, KbStudyQuestion };
export type StudyBasis = NonNullable<KbStudyCard['basis']>;

/** Shown under every question and answer that comes from the agent's own knowledge (#12, variant B). */
export const NOT_FROM_MATERIALS = 'Not based on your materials';

/** Whether a card, question or saved block comes from the agent's own knowledge rather than the user's materials. */
export const isAgentBasis = (item: { basis?: StudyBasis | null; citations?: readonly unknown[] }): boolean =>
  item.basis ? item.basis === 'agent' : Array.isArray(item.citations) && item.citations.length === 0;

/**
 * Whether `option` is a right answer to `question`, independent of whether the question comes from
 * the user's materials (`origin: 'source'`) or from the agent's own knowledge (`origin: 'agent'`).
 */
export function isRightOption(question: Pick<KbStudyQuestion, 'basis' | 'citations' | 'answers'>, option: KbStudyOption): boolean {
  if (typeof option.right === 'boolean') return option.right;
  if (option.id.startsWith('r')) return true;
  if (option.id.startsWith('w')) return false;
  if (question.answers.includes(option.text)) return true;
  return !isAgentBasis(question) && option.origin === 'source';
}
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
  /** P3-d: one step of a pass — «I know this» (Good), a skip (Again once per pass), ← back, «Go through again». */
  pass: (c: KbClient, id: string, action: 'know' | 'skip' | 'back' | 'restart', itemId: string | null) =>
    c.call('POST /kb/study/{block_id}/pass', { path: { block_id: id }, body: { action, item_id: itemId } }),
  mark: (c: KbClient, id: string, itemIds: string[], mark: StudyMark) =>
    c.call('POST /kb/study/{block_id}/mark', { path: { block_id: id }, body: { item_ids: itemIds, mark } }),
  answer: (c: KbClient, id: string, body: KbStudyAnswerIn) => c.call('POST /kb/study/{block_id}/answer', { path: { block_id: id }, body }),
  checkOpen: (c: KbClient, id: string, itemId: string, text: string) =>
    c.call('POST /kb/study/{block_id}/check-open', { path: { block_id: id }, body: { item_id: itemId, text } }),
  /** «I did say this» (P3-a): the agent rechecks one key idea against words of the user's own answer. */
  recheck: (c: KbClient, id: string, itemId: string, ideaId: string, words: string) =>
    c.call('POST /kb/study/{block_id}/recheck', { path: { block_id: id }, body: { item_id: itemId, idea_id: ideaId, words } }),
  /** «Count it» / take it back: the user counts a key idea as said («counted by you»). */
  count: (c: KbClient, id: string, itemId: string, ideaId: string, counted: boolean) =>
    c.call('POST /kb/study/{block_id}/count', { path: { block_id: id }, body: { item_id: itemId, idea_id: ideaId, counted } }),
  /** P3-b: what is marked «Unclear» in a chat's scope (its folders or the whole library), or on a page. */
  unclear: (c: KbClient, where: { chatId?: string; pageId?: string }) =>
    c.call('GET /kb/study/unclear', { query: { ...(where.chatId ? { chat_id: where.chatId } : {}), ...(where.pageId ? { page_id: where.pageId } : {}) } }),
  /** «Clear now»: the user clears these marks (the agent never does). */
  clearUnclear: (c: KbClient, itemIds: string[], chatId?: string) =>
    c.call('POST /kb/study/unclear/clear', { body: { item_ids: itemIds }, ...(chatId ? { query: { chat_id: chatId } } : {}) }),
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
  /** N4-7, N4-8: saved decks and tests apart from the wiki's pages, with what is archived. */
  library: (c: KbClient): Promise<KbStudyLibrary> => c.call('GET /kb/study-library'),
  /** The user opened the page: its 60 days start again, and an archived one is back in the lists. */
  opened: (c: KbClient, pageId: string) => c.call('POST /kb/study-library/{page_id}/opened', { path: { page_id: pageId } }),
  archive: (c: KbClient, pageId: string) => c.call('POST /kb/study-library/{page_id}/archive', { path: { page_id: pageId } }),
  unarchive: (c: KbClient, pageId: string) => c.call('POST /kb/study-library/{page_id}/unarchive', { path: { page_id: pageId } }),
  /** «Not now» to the suggestion to archive a learned deck. */
  keep: (c: KbClient, pageId: string) => c.call('POST /kb/study-library/{page_id}/keep', { path: { page_id: pageId } }),
  deleteWarning: (c: KbClient, pageId: string) => c.call('GET /kb/study-library/{page_id}/delete-warning', { path: { page_id: pageId } }),
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
