// N7 fake routes: Settings → Search and one chat's changes, as the backend answers them
// (`api/search_rules.py`): sites normalised, a chat's Never sites only add to Settings'. Search Beta
// gates Only/Prefer; Save/Reset/Save as global preserve hidden lists while Beta is off.

import type {
  KbChatSearchRules,
  KbChatSearchRulesUpdate,
  KbSearchSettings,
} from '../../api/kb/types.gen';
import type { FakeRoutes, FakeWorld } from './fakeKb';
import { full, fullSettings, siteOf, type SearchSettings, type WebRules } from '../searchRules/sites';

export interface FakeChatRules {
  web: WebRules | null;
  sources_only: boolean;
  sources: string[];
  excluded: string[];
  everywhere_once: boolean;
  /** Q1 n78 M-7: when the library sources last changed. */
  sources_since?: string | null;
}

const EMPTY: SearchSettings = { never: [], only_on: false, only: [], prefer: [], beta: false };

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

function label(settings: SearchSettings, chat: FakeChatRules): string | null {
  const ownOnly = settings.beta && chat.web?.only_on ? chat.web.only.length : 0;
  if (chat.sources_only || ownOnly) return `Only these · ${chat.sources.length + ownOnly}`;
  if (chat.excluded.length) return `${chat.excluded.length} excluded`;
  if (chat.web && (settings.beta ? JSON.stringify(chat.web) !== JSON.stringify(full(settings)) : chat.web.never.length > 0)) return 'Changed';
  return null;
}

function view(w: FakeWorld, chatId: string, fail: (status: number, detail: string) => never): KbChatSearchRules {
  if (!w.chats.some((c) => c.id === chatId)) fail(404, 'Chat not found.');
  const settings = fullSettings(w.searchSettings ?? EMPTY);
  const chat = w.chatSearchRules?.[chatId] ?? { web: null, sources_only: false, sources: [], excluded: [], everywhere_once: false };
  const lists = chat.web ?? settings;
  const never = [...settings.never, ...(chat.web?.never ?? []).filter((s) => !settings.never.includes(s))];
  const only = settings.beta && lists.only_on ? lists.only : [];
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
    active: { never, settings_never: [...settings.never], only: once ? [] : [...only], prefer: settings.beta ? [...lists.prefer] : [], origin: chat.web ? 'chat' : 'settings', everywhere_once: once },
    sources_only: chat.sources_only, sources: chat.sources.map(ref), excluded: chat.excluded.map(ref),
    everywhere_once: chat.everywhere_once, differs: text !== null, label: text,
    sources_since: chat.sources_since ?? null,
  };
}

/** API-seam projection shared by create-with-rules and the later PUT. */
export function applyFakeChatRules(w: FakeWorld, chatId: string, update: KbChatSearchRulesUpdate,
  fail: (status: number, detail: string) => never): void {
  const settings = fullSettings(w.searchSettings ?? EMPTY);
  const before = w.chatSearchRules?.[chatId];
  let web = update.web ? clean(update.web, fail) : null;
  if (!settings.beta) web = { ...full(before?.web ?? settings), never: web?.never ?? [] };
  if (update.as_global && web) {
    const never = [...settings.never, ...web.never.filter((s) => !settings.never.includes(s))];
    w.searchSettings = settings.beta ? { ...web, never, beta: true } : { ...settings, never };
    web = settings.beta ? null : { ...full(before?.web ?? settings), never: [] };
  } else if (web) {
    web = { ...web, never: web.never.filter((s) => !settings.never.includes(s)) };
    if (JSON.stringify({ ...web, never: [] }) === JSON.stringify({ ...full(settings), never: [] }) && web.never.length === 0) web = null;
  }
  const excluded = [...new Set(update.excluded ?? [])];
  (w.chatSearchRules ??= {})[chatId] = {
    web, sources_only: !!update.sources_only, sources: [...new Set(update.sources ?? [])].filter((id) => !excluded.includes(id)),
    excluded, everywhere_once: before?.everywhere_once ?? false,
  };
}

export function searchRulesRoutes(fail: (status: number, detail: string) => never): FakeRoutes {
  return {
    'GET /kb/settings/search': [200, (w) => structuredClone(fullSettings(w.searchSettings ?? EMPTY))],
    'PUT /kb/settings/search': [200, (w, { body }) => {
      const current = fullSettings(w.searchSettings ?? EMPTY);
      const beta = body.beta ?? current.beta;
      const cleaned = clean({ ...current, ...body }, fail);
      w.searchSettings = {
        ...cleaned,
        only_on: beta ? cleaned.only_on : current.only_on,
        only: beta ? cleaned.only : current.only,
        prefer: beta ? cleaned.prefer : current.prefer,
        beta,
      };
      return structuredClone(w.searchSettings);
    }],
    'GET /kb/chats/{chat_id}/search-rules': [200, (w, { path }) => view(w, path.chat_id, fail)],
    'PUT /kb/chats/{chat_id}/search-rules': [200, (w, { path, body }) => {
      view(w, path.chat_id, fail);
      applyFakeChatRules(w, path.chat_id, body as KbChatSearchRulesUpdate, fail);
      return view(w, path.chat_id, fail);
    }],
    'DELETE /kb/chats/{chat_id}/search-rules': [200, (w, { path }) => {
      view(w, path.chat_id, fail);
      const settings = fullSettings(w.searchSettings ?? EMPTY);
      const before = w.chatSearchRules?.[path.chat_id];
      if (settings.beta) {
        if (w.chatSearchRules) delete w.chatSearchRules[path.chat_id];
      } else {
        let web = before?.web ? { ...before.web, never: [] } : null;
        if (web && JSON.stringify(web) === JSON.stringify({ ...full(settings), never: [] })) web = null;
        (w.chatSearchRules ??= {})[path.chat_id] = {
          web, sources_only: false, sources: [], excluded: [], everywhere_once: before?.everywhere_once ?? false,
        };
      }
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
