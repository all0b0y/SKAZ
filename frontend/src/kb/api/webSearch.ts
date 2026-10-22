// W-2: an agent's own web search held for the user — routes over the generated /kb types.

import type { KbChatWebSearch, KbMaterial, KbWebSearchDecide, KbWebSearchPart } from '../../api/kb/types.gen';
import type { KbClient } from './client';

export type { KbChatWebSearch, KbWebLink, KbWebSearchPart } from '../../api/kb/types.gen';
export type KbWebDecision = KbWebSearchDecide['decision'];

export function decideWebSearch(client: KbClient, id: string, decision: KbWebDecision): Promise<KbWebSearchPart> {
  return client.call('POST /kb/web-searches/{search_id}/decide', { path: { search_id: id }, body: { decision } });
}

export function chatWebSearch(client: KbClient, chatId: string): Promise<KbChatWebSearch> {
  return client.call('GET /kb/chats/{chat_id}/web-search', { path: { chat_id: chatId } });
}

export function revokeChatWebSearch(client: KbClient, chatId: string): Promise<KbChatWebSearch> {
  return client.call('DELETE /kb/chats/{chat_id}/web-search', { path: { chat_id: chatId } });
}

/** «Add to wiki» of a web link (W-3): SKAZ saves that one page as a material; ingest follows. */
export function addWebPage(client: KbClient, url: string): Promise<KbMaterial> {
  return client.call('POST /kb/materials/web', { body: { url } });
}
