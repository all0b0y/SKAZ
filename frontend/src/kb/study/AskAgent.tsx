import { useCallback } from 'react';
import type { KbStudyPart, KbStudyQuestion } from '../../api/kb/types.gen';
import { useOpenChatWith } from './Unclear';

/** The default words of «Ask the agent» (P3-c decision 11): Enter sends them, or the user adds their own. */
export const ASK_QUESTION_TEXT = 'Explain this question';

/**
 * P3-c: «Ask the agent» on any test question — the chat's field gets the «📍 question N» chip (the P2
 * selection, `kind: 'study'`) and «Explain this question». A test of a chat asks in that chat; a test
 * opened from the wiki asks in a new chat (its folder follows the test). Nothing is sent by itself.
 * What the agent may see is the backend's: no right answer before the user has answered.
 */
export function useAskAgent(part: KbStudyPart): (question: KbStudyQuestion) => void {
  const openWith = useOpenChatWith();
  return useCallback((question) => {
    const index = part.questions.findIndex((q) => q.id === question.id);
    openWith(part.chat_id, [
      { kind: 'selection', selection: { message_id: part.message_id, block_id: part.id, kind: 'study', title: part.title,
        items: [{ id: question.id, label: `question ${index + 1}` }] } },
      { kind: 'text', text: ASK_QUESTION_TEXT },
    ]);
  }, [part, openWith]);
}
