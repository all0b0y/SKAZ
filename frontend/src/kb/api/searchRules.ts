// N7: the user's search rules — Settings → Search and one chat's changes (routes over the generated /kb types).

import type {
  KbChatSearchRules,
  KbChatSearchRulesUpdate,
  KbSearchSettings,
} from '../../api/kb/types.gen';
import type { KbClient } from './client';

export type { KbChatSearchRules, KbChatSearchRulesUpdate, KbRulesInForce, KbSearchSettings, KbSourceRef } from '../../api/kb/types.gen';

export function searchSettings(client: KbClient): Promise<KbSearchSettings> {
  return client.call('GET /kb/settings/search');
}

export function saveSearchSettings(client: KbClient, rules: KbSearchSettings): Promise<KbSearchSettings> {
  return client.call('PUT /kb/settings/search', { body: rules });
}

export function chatSearchRules(client: KbClient, chatId: string): Promise<KbChatSearchRules> {
  return client.call('GET /kb/chats/{chat_id}/search-rules', { path: { chat_id: chatId } });
}

/** Save (this chat) or, with ``as_global``, Save as global (the web lists go into Settings). */
export function saveChatSearchRules(client: KbClient, chatId: string, body: KbChatSearchRulesUpdate): Promise<KbChatSearchRules> {
  return client.call('PUT /kb/chats/{chat_id}/search-rules', { path: { chat_id: chatId }, body });
}

/** Reset to Settings. */
export function resetChatSearchRules(client: KbClient, chatId: string): Promise<KbChatSearchRules> {
  return client.call('DELETE /kb/chats/{chat_id}/search-rules', { path: { chat_id: chatId } });
}

/** «Search everywhere once» — only on the user's click on a search card. */
export function searchEverywhereOnce(client: KbClient, chatId: string): Promise<KbChatSearchRules> {
  return client.call('POST /kb/chats/{chat_id}/search-rules/everywhere-once', { path: { chat_id: chatId } });
}
