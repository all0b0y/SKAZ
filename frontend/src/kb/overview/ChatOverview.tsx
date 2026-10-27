import { useMemo, useState } from 'react';
import { errorText } from '../api/client';
import { saveChatSearchRules } from '../api/searchRules';
import { addWebPage } from '../api/webSearch';
import { useChats, useServices, useUi } from '../state/context';
import { Icon, IconButton } from '../ui';
import { openSearchPanel, searchRulesChanged, useChatSearchRules } from '../searchRules/ChatSearchPanel';
import { full } from '../searchRules/sites';
import { chatOverview, type OvItem, type OvLink } from './model';

/**
 * N8 · Chat overview in the right panel (a button in the chat header): Links · Used · Created, and on
 * top one line on what the chat uses («Sources as in Settings» / «Only these · 4» / «2 excluded»), whose
 * «Edit» opens the panel above the message field. A click on a row jumps to the message it came from.
 */

type Tab = 'links' | 'used' | 'created';

/** Scroll the chat to a message and mark it briefly (it may be far up in a long chat). */
export function jumpToMessage(messageId: string) {
  const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!el) return;
  el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  el.setAttribute('data-flash', 'true');
  window.setTimeout(() => el.removeAttribute('data-flash'), 1200);
}

export function ChatOverview({ chatId }: { chatId: string }) {
  const { client } = useServices();
  const chat = useChats((s) => s.chats[chatId]?.chat ?? null);
  const close = useUi((s) => s.closeDoc);
  const [tab, setTab] = useState<Tab>('links');
  const data = useMemo(() => chatOverview(chat?.messages ?? []), [chat?.messages]);
  const [rules] = useChatSearchRules(chatId);
  const used = data.cited.length + data.lookedAt.length;
  const created = data.study.length + data.wiki.length;

  return (
    <div className="kb-ov" role="region" aria-label="Chat overview">
      <header className="kb-head kb-head--doc">
        <span className="kb-doc__type"><Icon name="chats" size={14} /><span>Chat overview</span></span>
        <span className="kb-head__spacer" />
        <IconButton icon="close" label="Close the overview" onClick={close} />
      </header>
      <div className="kb-ov__line">
        {rules?.sources_only ? <b><Icon name="shield" size={12} /> Only these · {rules.sources.length}</b>
          : rules?.excluded.length ? <span>All sources · <b>{rules.excluded.length} excluded</b></span>
            : <span>Sources as in Settings</span>}
        <button type="button" className="kb-ov__edit" onClick={() => openSearchPanel(chatId)}>Edit</button>
      </div>
      <div className="kb-ov__tabs" role="tablist" aria-label="Chat overview">
        {([['links', 'Links', data.links], ['used', 'Used', used], ['created', 'Created', created]] as const).map(([id, label, count]) => (
          <button key={id} type="button" role="tab" className="kb-ov__tab" aria-selected={tab === id} id={`kb-ov-${id}`}
            aria-controls={`kb-ov-${id}-panel`} onClick={() => setTab(id)}>
            {label}<span className="kb-ov__count">{count}</span>
          </button>
        ))}
      </div>
      <div className="kb-ov__body" role="tabpanel" id={`kb-ov-${tab}-panel`} aria-labelledby={`kb-ov-${tab}`}>
        {tab === 'links' && <LinksTab data={data} />}
        {tab === 'used' && <UsedTab chatId={chatId} cited={data.cited} lookedAt={data.lookedAt} excluded={rules?.excluded.map((s) => s.id) ?? []}
          onExclude={async (item, out) => {
            if (!rules) return;
            const ids = rules.excluded.map((s) => s.id);
            const excluded = out ? [...ids, item.id] : ids.filter((id) => id !== item.id);
            await saveChatSearchRules(client, chatId, {
              web: rules.web ? full(rules.web) : null, sources_only: rules.sources_only,
              sources: rules.sources.map((s) => s.id).filter((id) => id !== item.id || !out), excluded,
            });
            searchRulesChanged(chatId);
          }} />}
        {tab === 'created' && <CreatedTab data={data} />}
      </div>
    </div>
  );
}

function LinksTab({ data }: { data: ReturnType<typeof chatOverview> }) {
  if (!data.links && !data.hidden) return <p className="kb-ov__empty">No links in this chat yet.</p>;
  return (
    <>
      {data.searches.filter((s) => s.links.length || s.hidden).map((search) => (
        <section key={search.id} aria-label={`From search «${search.query}»`}>
          <h3 className="kb-ov__group">From search <span className="kb-muted">· «{search.query}»</span></h3>
          <ul className="kb-ov__list">{search.links.map((link) => <LinkRow key={link.url} link={link} />)}</ul>
          {search.hidden > 0 && <p className="kb-ov__note">{search.hidden} {search.hidden === 1 ? 'link' : 'links'} hidden by your rules</p>}
        </section>
      ))}
      {data.inMessages.length > 0 && (
        <section aria-label="In messages">
          <h3 className="kb-ov__group">In messages</h3>
          <ul className="kb-ov__list">{data.inMessages.map((link) => <LinkRow key={link.url} link={link} />)}</ul>
        </section>
      )}
    </>
  );
}

function LinkRow({ link }: { link: OvLink }) {
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
    <li className="kb-ov__row">
      <button type="button" className="kb-ov__main" onClick={() => jumpToMessage(link.messageId)} title={link.url}>
        <Icon name="link" size={14} />
        <span className="kb-ov__title">{link.title}</span>
        <span className="kb-ov__meta">· {link.site}</span>
      </button>
      {state === 'added'
        ? <span className="kb-ov__tag is-ok" role="status"><Icon name="check" size={12} />In library</span>
        : <button type="button" className="kb-ov__act" disabled={state === 'busy'} onClick={() => void add()}>{state === 'busy' ? 'Adding…' : 'Add to library'}</button>}
      {link.used && <span className="kb-ov__tag is-used">used in answer</span>}
      {link.by && <span className="kb-ov__tag">by {link.by}</span>}
      {error && <span className="kb-inline-error kb-inline-error--flat" role="alert">{error}</span>}
    </li>
  );
}

function UsedTab({ chatId, cited, lookedAt, excluded, onExclude }: {
  chatId: string; cited: OvItem[]; lookedAt: OvItem[]; excluded: string[]; onExclude: (item: OvItem, out: boolean) => Promise<void>;
}) {
  const openDocument = useUi((s) => s.openDocument);
  void chatId;
  if (!cited.length && !lookedAt.length) return <p className="kb-ov__empty">The agent hasn’t used library materials in this chat yet.</p>;
  const row = (item: OvItem, muted: boolean) => <UsedRow key={`${item.kind}:${item.id}`} item={item} muted={muted} out={excluded.includes(item.id)}
    onOpen={() => (item.count ? jumpToMessage(item.messageId) : openDocument({ type: item.kind, id: item.id }))} onExclude={onExclude} />;
  return (
    <>
      {cited.length > 0 && (
        <section aria-label="Cited">
          <h3 className="kb-ov__group">Cited</h3>
          <ul className="kb-ov__list">{cited.map((item) => row(item, false))}</ul>
        </section>
      )}
      {lookedAt.length > 0 && (
        <section aria-label="Looked at">
          <h3 className="kb-ov__group">Looked at</h3>
          <ul className="kb-ov__list">{lookedAt.map((item) => row(item, true))}</ul>
        </section>
      )}
    </>
  );
}

function UsedRow({ item, muted, out, onOpen, onExclude }: {
  item: OvItem; muted: boolean; out: boolean; onOpen: () => void; onExclude: (item: OvItem, out: boolean) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    setError(null);
    try { await onExclude(item, !out); } catch (e) { setError(errorText(e)); }
  };
  return (
    <li className={`kb-ov__row${muted ? ' is-muted' : ''}${out ? ' is-out' : ''}`}>
      <button type="button" className="kb-ov__main" onClick={onOpen}>
        <Icon name={item.kind === 'page' ? 'wiki' : 'text'} size={14} />
        <span className="kb-ov__title">{item.kind === 'page' ? `Wiki · ${item.title}` : item.title}</span>
        {item.count > 0 && <span className="kb-ov__meta">· {item.count} {item.count === 1 ? 'citation' : 'citations'}</span>}
      </button>
      {item.byYou && <span className="kb-ov__tag">added by you</span>}
      {out && <span className="kb-ov__tag">excluded</span>}
      <button type="button" className="kb-ov__act" onClick={() => void toggle()}>{out ? 'Bring back' : 'Exclude from this chat'}</button>
      {error && <span className="kb-inline-error kb-inline-error--flat" role="alert">{error}</span>}
    </li>
  );
}

function CreatedTab({ data }: { data: ReturnType<typeof chatOverview> }) {
  if (!data.study.length && !data.wiki.length) return <p className="kb-ov__empty">Nothing created from this chat yet.</p>;
  return (
    <>
      {data.study.length > 0 && (
        <section aria-label="Study">
          <h3 className="kb-ov__group">Study</h3>
          <ul className="kb-ov__list">
            {data.study.map((s) => (
              <li key={s.id} className="kb-ov__row">
                <button type="button" className="kb-ov__main" onClick={() => jumpToMessage(s.messageId)}>
                  <Icon name={s.kind === 'deck' ? 'deck' : 'test'} size={14} />
                  <span className="kb-ov__title">{s.kind === 'deck' ? 'Deck' : 'Test'} · {s.title}</span>
                </button>
                <span className="kb-ov__tag">{s.saved ? 'saved to wiki' : 'only in chat'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.wiki.length > 0 && (
        <section aria-label="Wiki">
          <h3 className="kb-ov__group">Wiki</h3>
          <ul className="kb-ov__list">
            {data.wiki.map((w, i) => (
              <li key={`${w.kind}-${w.id}-${i}`} className="kb-ov__row">
                <button type="button" className="kb-ov__main" onClick={() => jumpToMessage(w.messageId)}>
                  <Icon name={w.kind === 'analysis' ? 'analysis' : 'pencil'} size={14} />
                  <span className="kb-ov__title">
                    {w.kind === 'analysis' ? `Analysis · ${w.title}` : `Fix in wiki · ${w.title}`}
                    {w.kind === 'fix' && <span className="kb-ov__diff">{w.before} → {w.after}</span>}
                  </span>
                </button>
                <span className="kb-ov__tag">{w.kind === 'analysis' ? 'new page' : 'was → became'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
