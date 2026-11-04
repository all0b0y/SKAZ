import { useCallback } from 'react';
import type { KbQuote } from '../../../api/kb/types.gen';
import { useServices } from '../../state/context';
import { fixLanguage, replyIn, type FixLanguage } from '../diagramFix';

/** The longest quote the API takes (`KbQuote.text`); the backend reads the stored block anyway. */
const QUOTE_CHARS = 20_000;

/**
 * P1 decision 6: a block that couldn't be drawn asks this chat's agent for a fix — one plain English
 * request the user sees in the chat, sent only when the user presses «Ask the agent to fix», with the
 * reply language of decision 10. No automatic retries.
 *
 * FIX-1 F2.7: the block's data and error are not part of the user's text. The request names the block
 * (a chat quote with the answer's and the block's ids); the backend reads its data and error from the
 * stored answer and gives them to the agent as untrusted data (`chats/context.py` `_block_to_fix`).
 */
export function blockFixRequest(language: FixLanguage): string {
  return 'The block in your answer can’t be drawn. Please send it again as a corrected ```skaz-block'
    + ` (skaz_answer_blocks has its schema); its data and the error are attached. ${replyIn(language)}`;
}

export interface BlockToFix {
  /** The answer the block is in (null outside an answer: the data then goes as a plain quote). */
  messageId: string | null;
  blockId: string;
  raw: string;
}

/** Sends the fix request in the open chat: resolves null when sent, else why not. */
export function useBlockFix(): (block: BlockToFix) => Promise<string | null> {
  const { chats, settings } = useServices();
  return useCallback(async ({ messageId, blockId, raw }) => {
    if (!settings.getState().wiki.value) await settings.getState().loadWiki();
    const s = chats.getState();
    const messages = s.currentId ? s.chats[s.currentId]?.chat?.messages ?? [] : [];
    const language = fixLanguage(settings.getState().wiki.value, messages.some((m) => m.role === 'user'));
    const quotes: KbQuote[] = s.currentId
      ? [{ source: 'chat', id: s.currentId, message_id: messageId, block_id: blockId, text: raw.slice(0, QUOTE_CHARS) }]
      : [];
    const res = await chats.getState().send({ text: blockFixRequest(language), mentions: [], quotes, attachments: [] }, {});
    return res.ok ? null : res.error;
  }, [chats, settings]);
}
