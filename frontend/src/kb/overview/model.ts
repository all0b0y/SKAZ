// N8 · the chat overview's content, built from the chat's own messages (no extra request): every link
// that came up, the library items the agent cited or read, and what the chat created. Pure, so tests
// check it without rendering.

import type { KbCitation, KbMessage, KbMessagePart, KbRulesInForce, KbWebSearchPart } from '../../api/kb/types.gen';

/** Every citation of an answer: its cite chips, a connection's sides and answer blocks' sources (as the Sources row). */
export function citationsOf(parts: readonly KbMessagePart[]): KbCitation[] {
  return parts.flatMap((p) => {
    if (p.type === 'cite') return [p.citation];
    if (p.type === 'connection') return p.folders.map((f) => f.citation);
    if (p.type === 'answer_block') return p.sources.flatMap((s) => (s.type === 'cite' ? [s.citation] : []));
    return [];
  });
}

export interface OvLink {
  url: string;
  title: string;
  site: string;
  /** The message where it first came up (a click jumps there). */
  messageId: string;
  /** From search: the answer links to it. */
  used?: boolean;
  /** In messages: who wrote it. */
  by?: 'you' | 'agent';
}

export interface OvSearch {
  id: string;
  query: string;
  messageId: string;
  links: OvLink[];
  /** Links the user's rules removed (only counted, N7). */
  hidden: number;
}

export interface OvItem {
  kind: 'material' | 'page';
  id: string;
  title: string;
  /** Citations in answers (0 for «Looked at»). */
  count: number;
  /** The first message that cites (or read) it. */
  messageId: string;
  /** Attached or @-mentioned by the user. */
  byYou: boolean;
}

export interface OvStudy { id: string; kind: 'deck' | 'test'; title: string; saved: boolean; messageId: string }
export interface OvWiki {
  kind: 'analysis' | 'fix';
  id: string;
  title: string;
  messageId: string;
  before?: string;
  after?: string;
}

export interface ChatOverviewData {
  searches: OvSearch[];
  inMessages: OvLink[];
  /** Agent-written links to sites the chat's rules rule out (only counted, Q1 n78 M-5). */
  inMessagesHidden: number;
  hidden: number;
  links: number;
  cited: OvItem[];
  lookedAt: OvItem[];
  study: OvStudy[];
  wiki: OvWiki[];
}

const MD_LINK = /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)/g;
const BARE = /https?:\/\/[^\s<>()[\]{}"'`]+/g;

export function siteOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The host a browser opens (lower case, punycode — the form the rules' sites are kept in); '' if none. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

const covered = (host: string, sites: readonly string[]) => !!host && sites.some((s) => host === s || host.endsWith(`.${s}`));

/** N7 on a link the agent wrote: a Never site, or outside «only these sites» (an unclear host too). */
export function ruledOut(url: string, rules: Pick<KbRulesInForce, 'never' | 'only'> | null | undefined): boolean {
  if (!rules || (!rules.never.length && !rules.only.length)) return false;
  const host = hostOf(url);
  return !host || covered(host, rules.never) || (rules.only.length > 0 && !covered(host, rules.only));
}

/** Links written in a text: markdown ones with their title, bare ones by their address. */
export function linksIn(text: string): Array<{ url: string; title: string }> {
  const out: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MD_LINK)) {
    const url = match[2]!;
    if (!seen.has(url)) { seen.add(url); out.push({ url, title: match[1]!.trim() }); }
  }
  const rest = text.replace(MD_LINK, ' ');
  for (const match of rest.matchAll(BARE)) {
    const url = match[0].replace(/[.,;:!?…»”]+$/, '');
    if (!seen.has(url)) { seen.add(url); out.push({ url, title: siteOfUrl(url) }); }
  }
  return out;
}

const textOf = (message: KbMessage): string => (message.role === 'user'
  ? message.input?.text ?? message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n')
  : message.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n'));

/** Which question an answer belongs to (for the analysis page's name). */
function questionBefore(messages: readonly KbMessage[], index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'user') return textOf(m).trim().split('\n')[0]!.slice(0, 120);
  }
  return 'Answer';
}

/** ``rules``: the chat's rules in force — links the agent wrote to sites they rule out are only counted. */
export function chatOverview(messages: readonly KbMessage[], rules?: Pick<KbRulesInForce, 'never' | 'only'> | null): ChatOverviewData {
  const seen = new Set<string>();
  const searches: OvSearch[] = [];
  const inMessages: OvLink[] = [];
  let hidden = 0;
  let inMessagesHidden = 0;
  const answers = messages.filter((m) => m.role === 'assistant').map((m) => ({ id: m.id, text: textOf(m) }));

  // Links: search results first (each address once in the whole chat), then the ones written in messages.
  messages.forEach((message, index) => {
    for (const part of message.parts) {
      if (part.type !== 'web_search') continue;
      const search = part as KbWebSearchPart;
      if (search.status !== 'allowed') continue;
      const later = answers.slice(answers.findIndex((a) => a.id === message.id)).map((a) => a.text).join('\n');
      const links: OvLink[] = [];
      for (const link of search.links) {
        if (seen.has(link.url)) continue;
        seen.add(link.url);
        links.push({ url: link.url, title: link.title, site: link.site, messageId: message.id, used: later.includes(link.url) });
      }
      const count = (search.hidden ?? []).reduce((n, h) => n + h.count, 0);
      hidden += count;
      searches.push({ id: search.id, query: search.query, messageId: message.id, links, hidden: count });
    }
    void index;
  });
  for (const message of messages) {
    if (message.role === 'system') continue;
    for (const link of linksIn(textOf(message))) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      if (message.role !== 'user' && ruledOut(link.url, rules)) { inMessagesHidden += 1; continue; }
      inMessages.push({ ...link, site: siteOfUrl(link.url), messageId: message.id, by: message.role === 'user' ? 'you' : 'agent' });
    }
  }

  // Used: cited materials and pages (count, first message), then what was read or added but not cited.
  const cited = new Map<string, OvItem>();
  const looked = new Map<string, OvItem>();
  const byYou = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user' || !message.input) continue;
    for (const ref of message.input.mentions) if (ref.type !== 'chat') byYou.add(ref.id);
    for (const id of message.input.attachments) byYou.add(id);
  }
  const bump = (kind: OvItem['kind'], id: string, title: string, messageId: string) => {
    const key = `${kind}:${id}`;
    const item = cited.get(key);
    if (item) item.count += 1;
    else cited.set(key, { kind, id, title, count: 1, messageId, byYou: byYou.has(id) });
  };
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const citation of citationsOf(message.parts)) {
      bump('material', citation.material_id, citation.material_title ?? 'A material no longer in the library', message.id);
    }
    for (const part of message.parts) if (part.type === 'page') bump('page', part.page.id, part.page.title, message.id);
  }
  for (const message of messages) {
    if (message.role === 'user' && message.input) {
      for (const ref of message.input.mentions) {
        if (ref.type === 'chat') continue;
        const key = `${ref.type}:${ref.id}`;
        if (!cited.has(key) && !looked.has(key)) looked.set(key, { kind: ref.type, id: ref.id, title: ref.title, count: 0, messageId: message.id, byYou: true });
      }
    }
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (part.type !== 'tool' || !part.target) continue;
      const key = `${part.target.type}:${part.target.id}`;
      if (cited.has(key) || looked.has(key)) continue;
      const title = part.label.replace(/^Read (page |a passage of |the last \d+ min of |the latest part of )?/, '');
      looked.set(key, { kind: part.target.type, id: part.target.id, title, count: 0, messageId: message.id, byYou: byYou.has(part.target.id) });
    }
  }

  // Created: study blocks and what went into the wiki from this chat.
  const study: OvStudy[] = [];
  const wiki: OvWiki[] = [];
  messages.forEach((message, index) => {
    if (message.saved_page_id) {
      wiki.push({ kind: 'analysis', id: message.saved_page_id, title: questionBefore(messages, index), messageId: message.id });
    }
    for (const part of message.parts) {
      if (part.type === 'study' && !study.some((s) => s.id === part.id)) {
        study.push({ id: part.id, kind: part.kind, title: part.title, saved: part.save.status === 'saved', messageId: message.id });
      }
      if (part.type === 'wiki_fix' && part.status === 'applied') {
        wiki.push({ kind: 'fix', id: part.page.id, title: part.page.title, messageId: message.id, before: part.before, after: part.after });
      }
    }
  });

  const links = searches.reduce((n, s) => n + s.links.length, 0) + inMessages.length;
  hidden += inMessagesHidden;
  return { searches, inMessages, inMessagesHidden, hidden, links, cited: [...cited.values()], lookedAt: [...looked.values()], study, wiki };
}
