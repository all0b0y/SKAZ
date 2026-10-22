import type { KbWikiSettings } from '../../api/kb/types.gen';
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

function replyIn({ language, hasQuestion }: FixLanguage): string {
  if (language) return `Reply in ${languageName(language)}.`;
  return hasQuestion ? 'Reply in the language of my previous question.' : 'Reply in English.';
}

export function diagramFixRequest(source: string, error: string, language: FixLanguage): string {
  return `The diagram in your answer can’t be drawn (${error}). Please send a corrected Mermaid diagram. ${replyIn(language)}`
    + `\n\n\`\`\`mermaid\n${source}\n\`\`\``;
}
