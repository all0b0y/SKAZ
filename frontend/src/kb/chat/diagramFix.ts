import { useCallback } from 'react';
import type { KbQuote, KbWikiSettings } from '../../api/kb/types.gen';
import { useServices } from '../state/context';
import type { DiagramFix } from '../ui/markdown/Diagram';
import { diagramId } from './select/model';
import { languageName } from '../settings/Languages';

/**
 * D-12 + decision 10 (2026-10-21): the request «Ask the agent to fix» sends. The UI stays English,
 * so the request is one short neutral English instruction that names the reply language — no
 * hand-translated templates. The answer language is:
 * 1. the wiki language the user chose (chat answers fall back to it too, chats/context.py);
 * 2. not chosen yet: the language of the user's previous question in this chat (the agent sees it);
 * 3. nothing to go by: English.
 */
export interface FixLanguage {
  /** The chosen wiki language code (`ru`), or null when the user hasn't chosen one. */
  language: string | null;
  /** Whether the chat has a question of the user's before this request. */
  hasQuestion: boolean;
}

export function fixLanguage(wiki: KbWikiSettings | null, hasQuestion: boolean): FixLanguage {
  return { language: wiki?.wiki_language_chosen ? wiki.wiki_language : null, hasQuestion };
}

export function replyIn({ language, hasQuestion }: FixLanguage): string {
  if (language) return `Reply in ${languageName(language)}.`;
  return hasQuestion ? 'Reply in the language of my previous question.' : 'Reply in English.';
}

/**
 * FIX-2: like a block's (blocks/blockFix.ts), the diagram's Mermaid source and its error are not part
 * of the user's text. The request names the diagram (a chat quote with the answer's id and the
 * diagram's `mmd-…` id, select/model.ts); the backend reads the source from the stored answer and
 * gives it to the agent, with the error the app reported, as untrusted data (`chats/context.py`
 * `_diagram_to_fix`).
 */
export function diagramFixRequest(language: FixLanguage): string {
  return 'The diagram in your answer can’t be drawn. Please send it again as a corrected ```mermaid diagram;'
    + ` its source and the error are attached. ${replyIn(language)}`;
}

/** Sends the fix request for a diagram of the answer `messageId` in the open chat: null when sent, else why not. */
export function useDiagramFix(messageId: string): DiagramFix {
  const { chats, settings } = useServices();
  return useCallback<DiagramFix>(async (source, error) => {
    if (!settings.getState().wiki.value) await settings.getState().loadWiki();
    const s = chats.getState();
    const messages = s.currentId ? s.chats[s.currentId]?.chat?.messages ?? [] : [];
    const language = fixLanguage(settings.getState().wiki.value, messages.some((m) => m.role === 'user'));
    // The error is the app's own short message (Diagram.tsx); the source stays in the stored answer.
    const quotes: KbQuote[] = s.currentId
      ? [{ source: 'chat', id: s.currentId, message_id: messageId, block_id: diagramId(source), text: error || 'Unknown error' }]
      : [];
    const res = await chats.getState().send({ text: diagramFixRequest(language), mentions: [], quotes, attachments: [] }, {});
    return res.ok ? null : res.error;
  }, [chats, settings, messageId]);
}
