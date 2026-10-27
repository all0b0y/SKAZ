// N7 fake routes: Settings → Search and one chat's changes, as the backend answers them
// (`api/search_rules.py`): sites normalised, a chat's Never sites only add to Settings', «Save as
// global» writes the web lists into Settings, Reset clears the chat, «Search everywhere once» is a flag.

import type {
  KbChatSearchRules,
  KbChatSearchRulesUpdate,
  KbSearchSettings,
} from '../../api/kb/types.gen';
import type { FakeRoutes, FakeWorld } from './fakeKb';
import { full, siteOf, type WebRules } from '../searchRules/sites';

export interface FakeChatRules {
  web: WebRules | null;
  sources_only: boolean;
  sources: string[];
  excluded: string[];
  everywhere_once: boolean;
  /** Q1 n78 M-7: when the library sources last changed. */
  sources_since?: string | null;
}

const EMPTY: WebRules = { never: [], only_on: false, only: [], prefer: [] };

function sites(list: readonly string[], fail: (status: number, detail: string) => never): string[] {
  const out: string[] = [];
  for (const item of list) {
    const site = siteOf(item);
    if (!site) fail(422, `«${item.slice(0, 80)}» is not a site. Write it like example.com.`);
    if (site && !out.includes(site)) out.push(site);
  }
  return out;
}

const clean = (rules: KbSearchSettings, fail: (status: number, detail: string) => never): WebRules => ({
  never: sites(rules.never ?? [], fail), only_on: !!rules.only_on, only: sites(rules.only ?? [], fail), prefer: sites(rules.prefer ?? [], fail),
});

function label(settings: WebRules, chat: FakeChatRules): string | null {
  const ownOnly = chat.web?.only_on ? chat.web.only.length : 0;
  if (chat.sources_only || ownOnly) return `Only these · ${chat.sources.length + ownOnly}`;
  if (chat.excluded.length) return `${chat.excluded.length} excluded`;
  if (chat.web && JSON.stringify(chat.web) !== JSON.stringify(settings)) return 'Changed';
  return null;
}

function view(w: FakeWorld, chatId: string, fail: (status: number, detail: string) => never): KbChatSearchRules {
  if (!w.chats.some((c) => c.id === chatId)) fail(404, 'Chat not found.');
  const settings = full(w.searchSettings ?? EMPTY);
  const chat = w.chatSearchRules?.[chatId] ?? { web: null, sources_only: false, sources: [], excluded: [], everywhere_once: false };
  const lists = chat.web ?? settings;
  const never = [...settings.never, ...(chat.web?.never ?? []).filter((s) => !settings.never.includes(s))];
  const only = lists.only_on ? lists.only : [];
  const once = chat.everywhere_once && only.length > 0;
  const ref = (id: string) => {
    const material = w.materials.find((m) => m.id === id);
    if (material) return { id, kind: 'material' as const, title: material.title };
    const page = w.pages.find((p) => p.id === id);
    return { id, kind: 'page' as const, title: page?.title ?? null };
  };
  const text = label(settings, chat);
  return {
    settings: structuredClone(settings), web: chat.web ? structuredClone(chat.web) : null,
    active: { never, settings_never: [...settings.never], only: once ? [] : [...only], prefer: [...lists.prefer], origin: chat.web ? 'chat' : 'settings', everywhere_once: once },
    sources_only: chat.sources_only, sources: chat.sources.map(ref), excluded: chat.excluded.map(ref),
    everywhere_once: chat.everywhere_once, differs: text !== null, label: text,
    sources_since: chat.sources_since ?? null,
  };
}

export function searchRulesRoutes(fail: (status: number, detail: string) => never): FakeRoutes {
  return {
    'GET /kb/settings/search': [200, (w) => structuredClone(w.searchSettings ?? EMPTY)],
    'PUT /kb/settings/search': [200, (w, { body }) => {
      w.searchSettings = clean(body, fail);
      return structuredClone(w.searchSettings);
    }],
    'GET /kb/chats/{chat_id}/search-rules': [200, (w, { path }) => view(w, path.chat_id, fail)],
    'PUT /kb/chats/{chat_id}/search-rules': [200, (w, { path, body }) => {
      view(w, path.chat_id, fail);
      const update = body as KbChatSearchRulesUpdate;
      const settings = full(w.searchSettings ?? EMPTY);
      let web = update.web ? clean(update.web, fail) : null;
      if (update.as_global && web) {
        w.searchSettings = { ...web, never: [...settings.never, ...web.never.filter((s) => !settings.never.includes(s))] };
        web = null;
      } else if (web) {
        web = { ...web, never: web.never.filter((s) => !settings.never.includes(s)) };
        if (JSON.stringify({ ...web, never: [] }) === JSON.stringify({ ...settings, never: [] }) && web.never.length === 0) web = null;
      }
      const before = w.chatSearchRules?.[path.chat_id];
      const excluded = [...new Set(update.excluded ?? [])];
      (w.chatSearchRules ??= {})[path.chat_id] = {
        web, sources_only: !!update.sources_only, sources: [...new Set(update.sources ?? [])].filter((id) => !excluded.includes(id)),
        excluded, everywhere_once: before?.everywhere_once ?? false,
      };
      return view(w, path.chat_id, fail);
    }],
    'DELETE /kb/chats/{chat_id}/search-rules': [200, (w, { path }) => {
      view(w, path.chat_id, fail);
      if (w.chatSearchRules) delete w.chatSearchRules[path.chat_id];
      return view(w, path.chat_id, fail);
    }],
    'POST /kb/chats/{chat_id}/search-rules/everywhere-once': [200, (w, { path }) => {
      view(w, path.chat_id, fail);
      const chat = w.chatSearchRules?.[path.chat_id] ?? { web: null, sources_only: false, sources: [], excluded: [], everywhere_once: false };
      (w.chatSearchRules ??= {})[path.chat_id] = { ...chat, everywhere_once: true };
      return view(w, path.chat_id, fail);
    }],
  };
}
