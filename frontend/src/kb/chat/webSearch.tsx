import { useEffect, useRef, useState } from 'react';
import { m } from 'motion/react';
import type { KbAgent, KbMessage } from '../../api/kb/types.gen';
import { Button, Icon, IconButton, Popover } from '../ui';
import { SPRING_SMALL } from '../ui/motion';
import { errorText } from '../api/client';
import { useServices } from '../state/context';
import { partsOf } from '../api/permissions';
import {
  addWebPage, chatWebSearch, decideWebSearch, revokeChatWebSearch,
  type KbChatWebSearch, type KbWebDecision, type KbWebLink, type KbWebSearchPart,
} from '../api/webSearch';
import { agentName } from './permission';

/**
 * W-2: an agent's own web search in the chat. Pending, it shows the exact query — the only thing that
 * leaves SKAZ for the search — with Deny / Allow in this chat / Allow once. W-3b: Codex, Hermes and
 * OpenCode ask through SKAZ's tool; the card names the agent whose own search runs it in a clean run. Decided, it folds into one
 * line; the links it found are listed apart from the material citations, each with «Add to wiki».
 */
export function WebSearchCard({ chatId, part }: { chatId: string; part: KbWebSearchPart }) {
  if (part.status !== 'pending') return <WebSearchOutcome part={part} />;
  return <WebSearchRequest chatId={chatId} part={part} />;
}

const ONLY_QUERY = 'Only this query is sent — nothing else from the chat or your library.';
/** Claude Code's search runs inside Anthropic's search model (`max_uses: 8`), which may refine the approved query. */
const CLAUDE_REPHRASES = 'Claude may rephrase it for up to 8 searches; nothing else from the chat or your library is sent.';
/** W-3b: Codex's model writes its own web_search calls from the one message holding the query. */
const CODEX_REPHRASES = 'Codex may rephrase it for its searches; nothing else from the chat or your library is sent.';

/** What the approval card says leaves SKAZ for the search of this engine — the one that runs it (decision 8, 2026-10-21). */
export const searchScopeNote = (engine: KbWebSearchPart['engine']): string =>
  (engine === 'claude_code' ? CLAUDE_REPHRASES : engine === 'codex' ? CODEX_REPHRASES : ONLY_QUERY);

/** W-3b: `skaz_web_search` queries run in another agent's own search, in a run that gets only the query. */
const searcherLine = (part: KbWebSearchPart): string | null =>
  (part.searcher ? `Searched by ${agentName(part.searcher)} in a separate run that gets only this query.` : null);

function WebSearchRequest({ chatId, part }: { chatId: string; part: KbWebSearchPart }) {
  const { client, chats } = useServices();
  const [busy, setBusy] = useState<KbWebDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = `${agentName(part.engine)} wants to search the web`;

  const send = async (decision: KbWebDecision) => {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      chats.getState().applyPart(chatId, await decideWebSearch(client, part.id, decision));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <m.section className="kb-perm kb-web" aria-label={name} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0, transition: SPRING_SMALL }}>
      <header className="kb-perm__head">
        <Icon name="web" size={16} />
        <b>{name}</b>
      </header>
      <div className="kb-perm__body kb-web__body">
        <p className="kb-web__query" aria-label="Search query">{part.query}</p>
        <Domains part={part} />
        {searcherLine(part) && <p className="kb-perm__note">{searcherLine(part)}</p>}
        <p className="kb-perm__note">{searchScopeNote(part.searcher ?? part.engine)}</p>
      </div>
      <div className="kb-perm__foot" role="group" aria-label="Decision">
        <Button size="sm" busy={busy === 'deny'} disabled={!!busy} onClick={() => void send('deny')}>Deny</Button>
        <span className="kb-perm__spacer" />
        <Button size="sm" busy={busy === 'allow_chat'} disabled={!!busy} onClick={() => void send('allow_chat')}>Allow in this chat</Button>
        <Button size="sm" variant="fill" busy={busy === 'allow'} disabled={!!busy} onClick={() => void send('allow')}>Allow once</Button>
      </div>
      {error && <p className="kb-inline-error kb-perm__error" role="alert">{error}</p>}
    </m.section>
  );
}

function Domains({ part }: { part: KbWebSearchPart }) {
  if (part.allowed_domains.length) return <p className="kb-web__domains">Only these sites: {part.allowed_domains.join(', ')}</p>;
  if (part.blocked_domains.length) return <p className="kb-web__domains">Not these sites: {part.blocked_domains.join(', ')}</p>;
  return null;
}

function outcomeState(part: KbWebSearchPart): { state: string; detail: string | null } {
  if (part.status === 'allowed') return { state: part.auto ? 'Searched the web · allowed in this chat' : 'Searched the web', detail: null };
  if (part.status === 'denied') return { state: 'Search denied', detail: 'Nothing was sent' };
  return { state: 'Search cancelled', detail: 'Nothing was sent' };
}

/** Web results v1 «Folded line + quiet rows» (2026-10-21): this many rows show before «Show N more». */
const FIRST_LINKS = 5;

function WebSearchOutcome({ part }: { part: KbWebSearchPart }) {
  const { state, detail } = outcomeState(part);
  const icon = part.status === 'allowed' ? 'web' : part.status === 'denied' ? 'denied' : 'cancelled';
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const count = part.links.length;
  const label = `${state}: ${part.query}`;
  if (count > 0) {
    const shown = all ? part.links : part.links.slice(0, FIRST_LINKS);
    return (
      <m.div className="kb-web-done kb-web-done--links" data-status={part.status} role="group" aria-label={label}
        initial={{ opacity: 0 }} animate={{ opacity: 1, transition: SPRING_SMALL }}>
        <button type="button" className="kb-web-fold" aria-expanded={open} onClick={() => setOpen((v) => !v)}
          aria-label={`${state} · ${part.query} · ${count} ${count === 1 ? 'link' : 'links'}`}>
          <Icon name="web" size={14} />
          <b>{state}</b>
          <span className="kb-web-fold__query" title={part.query}>{part.query}</span>
          <span className="kb-web-fold__count">· {count} {count === 1 ? 'link' : 'links'}</span>
          <Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} />
        </button>
        {open && (
          <ul className="kb-web__links" aria-label="From the web">
            {shown.map((link) => <WebLinkRow key={link.url} link={link} />)}
            {!all && count > FIRST_LINKS && (
              <li className="kb-web__more-row">
                <button type="button" className="kb-web__more" onClick={() => setAll(true)}>Show {count - FIRST_LINKS} more</button>
              </li>
            )}
          </ul>
        )}
      </m.div>
    );
  }
  return (
    <m.div className="kb-perm-done kb-web-done" data-status={part.status} role="group" aria-label={label}
      initial={{ opacity: 0 }} animate={{ opacity: 1, transition: SPRING_SMALL }}>
      <div className="kb-perm-done__row">
        <Icon name={icon} size={15} className="kb-perm-done__icon" />
        <b>{state}</b>
        <span className="kb-perm-done__line" title={part.query}>{part.query}</span>
        {detail && <span className="kb-perm-done__detail">{detail}</span>}
      </div>
    </m.div>
  );
}

/** One web result: title · site on one quiet line; «Add to wiki» is an icon shown on hover/focus. */
function WebLinkRow({ link }: { link: KbWebLink }) {
  const { client } = useServices();
  const [state, setState] = useState<'idle' | 'busy' | 'added'>('idle');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setState('busy');
    setError(null);
    try {
      await addWebPage(client, link.url);
      setState('added');
    } catch (e) {
      setError(errorText(e));
      setState('idle');
    }
  };
  return (
    <li className="kb-web__link" data-state={error ? 'error' : state}>
      <div className="kb-web__row">
        <a className="kb-web__title" href={link.url} target="_blank" rel="noreferrer noopener" title={link.url}>{link.title}</a>
        <span className="kb-web__site">{link.site}</span>
        <span className="kb-perm__spacer" />
        {state === 'added'
          ? <span className="kb-web__added" role="status" title="Added to the library — the wiki follows"><Icon name="check" size={13} />In library</span>
          : state === 'busy'
            ? <span className="kb-web__busy" role="status" aria-label="Adding to the library"><span className="kb-spinner kb-spinner--inline" aria-hidden="true" /></span>
            : <IconButton icon="saveWiki" label="Add to wiki" size="sm" className="kb-web__add" onClick={() => void add()} />}
      </div>
      {error && (
        <p className="kb-web__error" role="alert">
          <Icon name="warning" size={13} />
          <span className="kb-web__error-text" title={error}>{error}</span>
          <button type="button" className="kb-web__retry" onClick={() => void add()}>Retry</button>
        </p>
      )}
    </li>
  );
}

/**
 * The chat header's chip while «Allow in this chat» holds for web search (W-2): it says so, shows
 * since when, and revokes it. The grant is read again whenever a search of this chat is decided.
 */
export function WebSearchChip({ chatId, messages }: { chatId: string; messages: readonly KbMessage[] }) {
  const { client } = useServices();
  const [grant, setGrant] = useState<KbChatWebSearch | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  // A grant comes only from a search of this chat: no search here, nothing to ask the backend.
  const decided = messages.flatMap((msg) => partsOf(msg)).filter((p) => p.type === 'web_search' && p.status !== 'pending').length;

  useEffect(() => {
    if (!decided) { setGrant(null); return undefined; }
    let live = true;
    chatWebSearch(client, chatId).then((g) => { if (live) setGrant(g); }, () => { if (live) setGrant(null); });
    return () => { live = false; };
  }, [client, chatId, decided]);

  if (!grant?.allowed) return null;
  const since = grant.granted_at ? new Date(grant.granted_at) : null;
  const when = since && !Number.isNaN(since.getTime())
    ? since.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      setGrant(await revokeChatWebSearch(client, chatId));
      setOpen(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button ref={anchor} type="button" className="kb-tag kb-tag--static kb-web-chip" aria-expanded={open}
        aria-label={`Web search allowed in this chat${when ? ` since ${when}` : ''}`} onClick={() => setOpen((v) => !v)}>
        <Icon name="web" size={12} />Web search allowed
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} label="Web search in this chat" placement="bottom-end" width={300}>
        <div className="kb-web-pop">
          <p>The agent searches the web in this chat without asking{when ? ` (allowed ${when})` : ''}. Each query still shows here, and only the query is sent.</p>
          <p className="kb-muted">Other chats and wiki jobs always ask.</p>
          {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
          <Button size="sm" variant="danger" busy={busy} disabled={busy} onClick={() => void revoke()}>Stop allowing</Button>
        </div>
      </Popover>
    </>
  );
}

/** The agent card's line: each query is asked first, or why this agent has no web search (W-2, W-3b). */
export function WebSearchNote({ agent }: { agent: KbAgent }) {
  const web = agent.web_search;
  if (!web) return null;
  const text = !web.available ? `Web search: off. ${web.reason ?? ''}`.trim()
    : web.through ? `Web search: with your approval — each query is shown to you first, then searched by ${agentName(web.through)} in a separate run that gets only the query.`
      : 'Web search: asks you before each query; only the query is sent.';
  return <p className="kb-agentcard__note kb-web-note" role="note">{text}</p>;
}

/** A pending web search counts as «waiting for you» like a permission (composer hint). */
export const hasPendingWebSearch = (messages: readonly KbMessage[]): boolean =>
  messages.some((msg) => partsOf(msg).some((p) => p.type === 'web_search' && p.status === 'pending'));

