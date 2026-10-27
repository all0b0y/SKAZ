import { useCallback, useEffect, useState } from 'react';
import { Button, Icon } from '../ui';
import { errorText } from '../api/client';
import { useChats, useServices } from '../state/context';
import type { ComposerItem } from '../state/composer';
import { studyApi } from './api';
import type { KbMessage, KbStudyUnclearItem } from '../../api/kb/types.gen';

/**
 * P3-b: «Unclear» — the user has a question about a card or a test question (decisions 8–10). The
 * mark lives on the item, survives retakes and right answers, never touches FSRS and is apart from
 * «Hard»; only the user clears it. The agent reads the marks (`skaz_study_unclear`) and never changes
 * them: «Clear now» under its answer is the user's button.
 */

/** SKAZ's own thread of the blocks opened from the wiki (backend `WIKI_STUDY_CHAT_ID`): never a chat to talk in. */
export const WIKI_STUDY_CHAT_ID = 'chat-wiki-study';
/** The prepared request of «Discuss unclear» (the user sends it, or adds their own words). */
export const DISCUSS_UNCLEAR_TEXT = 'Let’s talk about what I marked unclear.';

/** The mark on a card face or a test sheet (p3d-v2): an icon; its words on hover, always when on. */
export function UnclearMark({ on, disabled, onToggle, what, tabIndex }: {
  on: boolean; disabled?: boolean; onToggle: () => void; what: 'card' | 'question'; tabIndex?: number;
}) {
  return (
    <button type="button" className={`kb-st-unc${on ? ' is-on' : ''}`} aria-pressed={on} disabled={disabled} tabIndex={tabIndex}
      title={on ? 'Marked Unclear — click to clear' : `Mark: I have a question about this ${what}`}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}>
      <Icon name="help" size={14} /><span className="kb-st-unc__l">{on ? 'Unclear' : 'I have a question'}</span>
    </button>
  );
}

/**
 * Open a chat with items in its message field (nothing is sent): `chatId` null = a new chat. A block
 * of the wiki-study thread talks in a new chat; the page goes along as a token, so the chat is in its
 * folder (and the agent's `skaz_study_unclear` reads that folder).
 */
export function useOpenChatWith(): (chatId: string | null, items: ComposerItem[]) => void {
  const { chats, ui, composer } = useServices();
  return useCallback((chatId, items) => {
    const target = chatId === WIKI_STUDY_CHAT_ID ? null : chatId;
    if (chats.getState().currentId !== target) chats.getState().open(target);
    const s = ui.getState();
    if (s.center !== 'chat') s.showCenter('chat');
    if (s.docExpanded) s.toggleDocExpanded();
    composer.getState().push(items, { focus: true });
  }, [chats, ui, composer]);
}

/** «Discuss unclear · N»: quiet; opens the chat with the prepared request. */
export function DiscussUnclear({ count, chatId, page }: {
  count: number; chatId: string | null; page?: { id: string; title: string } | null;
}) {
  const openWith = useOpenChatWith();
  if (count <= 0) return null;
  const wiki = chatId === null || chatId === WIKI_STUDY_CHAT_ID;
  return (
    <Button size="sm" variant="quiet" icon="help" onClick={() => openWith(wiki ? null : chatId, [
      ...(wiki && page ? [{ kind: 'mention' as const, ref: { type: 'page' as const, id: page.id, title: page.title } }, { kind: 'text' as const, text: ' ' }] : []),
      { kind: 'text', text: DISCUSS_UNCLEAR_TEXT },
    ])}>
      Discuss unclear · {count}
    </Button>
  );
}

/** The count of marks on a saved page (the test page has no block to read them from). */
export function useUnclearCount(pageId: string): number {
  const { client } = useServices();
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    studyApi.unclear(client, { pageId }).then((r) => { if (live) setCount(r.items.length); }, () => undefined);
    return () => { live = false; };
  }, [client, pageId]);
  return count;
}

const lastUnclearOf = new WeakMap<readonly KbMessage[], string | null>();
const NO_MESSAGES: readonly KbMessage[] = [];

/**
 * The chat's last answer that read the «Unclear» marks. Every answer of the chat asks on every store
 * change (each streaming delta), so the scan runs once per messages list — the store replaces the
 * list on a change — not once per answer (Q1 p3 M6).
 */
export function lastUnclearAnswer(messages: readonly KbMessage[]): string | null {
  const known = lastUnclearOf.get(messages);
  if (known !== undefined) return known;
  let found: string | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'assistant' && (m.parts as ReadonlyArray<{ type: string; name?: string }>)
      .some((p) => p.type === 'tool' && p.name === 'skaz_study_unclear')) { found = m.id; break; }
  }
  lastUnclearOf.set(messages, found);
  return found;
}

/** Did this answer read the «Unclear» marks? Only the chat's last such answer shows «Clear now». */
export function useLastUnclearAnswer(chatId: string): string | null {
  return useChats((s) => lastUnclearAnswer(s.chats[chatId]?.chat?.messages ?? NO_MESSAGES));
}

/**
 * Under the agent's answer that went through the marks: what is still marked here and «Clear now».
 * The user's button — the agent only offers it in words (decision 9).
 */
export function UnclearClearRow({ chatId }: { chatId: string }) {
  const { client } = useServices();
  const [items, setItems] = useState<KbStudyUnclearItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    studyApi.unclear(client, { chatId }).then((r) => { if (live) setItems(r.items); }, (e: unknown) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [client, chatId]);
  const clear = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    try { setItems((await studyApi.clearUnclear(client, ids, chatId)).items); } catch (e) { setError(errorText(e)); }
    setBusy(false);
  };
  if (items === null && !error) return null;
  return (
    <div className="kb-st-uncrow" role="group" aria-label="Marked unclear">
      {items && items.length > 0 ? (
        <>
          <div className="kb-st-uncrow__head">
            <Icon name="help" size={14} />
            <span>Marked unclear · {items.length}</span>
            <span className="kb-st-spacer" />
            <Button size="sm" busy={busy} disabled={busy} onClick={() => void clear(items.map((i) => i.item_id))}>Clear now</Button>
          </div>
          <ul className="kb-st-uncrow__list">
            {items.map((i) => (
              <li key={i.item_id}>
                <span className="kb-st-uncrow__q" title={`${i.title} · ${i.question}`}>{i.question}</span>
                <button type="button" className="kb-st-rv__link" disabled={busy} aria-label={`Clear: ${i.question}`}
                  onClick={() => void clear([i.item_id])}>Clear</button>
              </li>
            ))}
          </ul>
        </>
      ) : items && <span className="kb-st-uncrow__done"><Icon name="allowed" size={14} />Nothing is marked unclear now.</span>}
      {error && <p className="kb-inline-error" role="alert">{error}</p>}
    </div>
  );
}
