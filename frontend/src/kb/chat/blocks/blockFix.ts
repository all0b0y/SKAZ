import { useCallback } from 'react';
import { useServices } from '../../state/context';
import { fixLanguage, replyIn, type FixLanguage } from '../diagramFix';

/**
 * P1 decision 6: a block that couldn't be drawn asks this chat's agent for a fix — the same path as a
 * diagram (diagramFix.ts, D-12): one plain English request the user sees in the chat, sent only when
 * the user presses «Ask agent to fix», with the reply language of decision 10. No automatic retries.
 */
export function blockFixRequest(raw: string, error: string, language: FixLanguage): string {
  return `The block in your answer can’t be drawn (${error}). Please send it again as a corrected \`\`\`skaz-block`
    + ` (skaz_answer_blocks has its schema). ${replyIn(language)}\n\n\`\`\`json\n${raw.trimEnd()}\n\`\`\``;
}

/** Sends the fix request in the open chat: resolves null when sent, else why not. */
export function useBlockFix(): (raw: string, error: string) => Promise<string | null> {
  const { chats, settings } = useServices();
  return useCallback(async (raw, error) => {
    if (!settings.getState().wiki.value) await settings.getState().loadWiki();
    const s = chats.getState();
    const messages = s.currentId ? s.chats[s.currentId]?.chat?.messages ?? [] : [];
    const language = fixLanguage(settings.getState().wiki.value, messages.some((m) => m.role === 'user'));
    const res = await chats.getState().send({ text: blockFixRequest(raw, error, language), mentions: [], quotes: [], attachments: [] }, {});
    return res.ok ? null : res.error;
  }, [chats, settings]);
}
