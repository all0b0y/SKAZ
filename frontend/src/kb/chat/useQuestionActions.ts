import { useEffect, useState } from 'react';
import type { KbChat, KbMessage, KbOpenContext } from '../../api/kb/types.gen';
import { useServices, useUi } from '../state/context';
import { openTarget } from '../state/document';
import { isAnswering } from '../state/chats';
import { useOpenStudy } from '../study/useStudy';
import { questionInput } from './Message';
import type { QuestionActions } from './QuestionActions';

/** Why Edit and Resend wait while an answer is written (Regenerate's 409 would say the same later). */
export const WAIT_REASON = 'Available when the answer is finished';

/**
 * Copy · Edit · Resend for the questions of the chat on screen. Resend is the normal send of the
 * same input (text, mentions, quotes, attachments) with what is open now, as the message field
 * would send it; the chat's current agent and model answer.
 */
export function useQuestionActions(chatId: string | null, chat: KbChat | null): (message: KbMessage) => QuestionActions {
  const { chats } = useServices();
  const doc = useUi(openTarget);
  const study = useOpenStudy(chatId);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => { setError(null); }, [chatId]);
  const waitReason = chat && (chat.state === 'answering' || isAnswering(chat)) ? WAIT_REASON : null;
  const context = (): KbOpenContext => ({
    ...(doc ? (doc.type === 'page' ? { open_page_id: doc.id } : { open_material_id: doc.id }) : {}),
    ...(study ? { open_study_id: study.id } : {}),
  });
  return (message) => ({
    waitReason,
    error: error?.id === message.id ? error.text : null,
    onEdit: async (input) => {
      if (!chatId) return 'This chat is not open.';
      const res = await chats.getState().edit(chatId, message.id, input);
      return res.ok ? null : res.error;
    },
    onResend: () => {
      if (!chatId || waitReason) return;
      setError(null);
      void chats.getState().send(questionInput(message), context()).then((res) => {
        if (!res.ok) setError({ id: message.id, text: res.error });
      });
    },
  });
}
