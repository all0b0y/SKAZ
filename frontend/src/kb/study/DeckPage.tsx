import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import type { KbPage } from '../../api/kb/types.gen';
import { Banner, Button, Icon, IconButton, Spinner } from '../ui';
import { SelectionCheckbox, useListSelection } from '../ui/listSelection';
import { errorText } from '../api/client';
import { useServices } from '../state/context';
import { useAskAbout } from '../document/parts';
import { GroupChip } from './CardStack';
import { studyApi, type KbDeckView, type StudyMark, type StudyMode } from './api';

const GROUPS: Array<{ key: keyof KbDeckView['groups']; label: string }> = [
  { key: 'new', label: 'New' }, { key: 'learning', label: 'Learning' }, { key: 'known', label: 'Known' }, { key: 'hard', label: 'Hard' },
];

/**
 * "Study" from a deck or test page (S12, W1): the cards as a block of the open chat (a new chat
 * "Study · <deck>" when none is open), shown beside the chat.
 */
export function useStudyFromPage(): (pageId: string, mode: StudyMode, cardIds?: string[]) => Promise<string | null> {
  const { client, chats, ui } = useServices();
  return useCallback(async (pageId, mode, cardIds) => {
    try {
      const started = await studyApi.studyDeck(client, pageId, { mode, card_ids: cardIds ?? null, chat_id: chats.getState().currentId });
      await chats.getState().load(started.chat_id);
      chats.getState().open(started.chat_id);
      if (ui.getState().center !== 'chat') ui.getState().showCenter('chat');
      ui.getState().openStudy(started.chat_id, started.study.id);
      return null;
    } catch (error) {
      return errorText(error);
    }
  }, [client, chats, ui]);
}

/**
 * The deck page (S12): groups with counts, Study / Hard first / Ask in chat, and the cards. A row's
 * Hard / Known / Don't show (hover, or H / K / ⌘⌫ on the selection) go into FSRS — the file stays.
 */
export function DeckPage({ page }: { page: KbPage }) {
  const { client } = useServices();
  const askAbout = useAskAbout();
  const study = useStudyFromPage();
  const [deck, setDeck] = useState<KbDeckView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    studyApi.deck(client, page.id).then((d) => { if (live) setDeck(d); }, (e: unknown) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [client, page.id, page.updated_at]);

  const mark = async (ids: string[], value: StudyMark) => {
    if (!ids.length) return;
    setError(null);
    try { setDeck(await studyApi.markDeck(client, page.id, ids, value)); } catch (e) { setError(errorText(e)); }
  };
  const start = async (what: string, mode: StudyMode) => {
    setBusy(what);
    setError(await study(page.id, mode));
    setBusy(null);
  };
  const ids = deck?.cards.map((c) => c.id) ?? [];
  const sel = useListSelection({ ids, onDelete: (targets) => { void mark(targets, 'hide'); }, resetKey: page.id });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const key = event.key.toLowerCase();
    if (!event.metaKey && !event.ctrlKey && !event.altKey && (key === 'h' || key === 'k')
      && !(event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) {
      event.preventDefault();
      void mark(sel.targets(), key === 'h' ? 'hard' : 'known');
      return;
    }
    sel.listProps.onKeyDown(event);
  };

  if (!deck) {
    return error ? <Banner tone="error" title="Couldn’t read the deck.">{error}</Banner> : <Spinner label="Reading the deck" />;
  }
  return (
    <div className="kb-deck">
      <p className="kb-deck__meta">
        Deck · {deck.cards.length} {deck.cards.length === 1 ? 'card' : 'cards'}{deck.due > 0 ? ` · ${deck.due} due now` : ''}
      </p>
      <div className="kb-deck__groups" role="list" aria-label="Cards by group">
        {GROUPS.map((g) => (
          <span key={g.key} role="listitem" className={`kb-deck__grp kb-st-chip--${g.key}`}><i aria-hidden="true" />{g.label}<b>{deck.groups[g.key]}</b></span>
        ))}
      </div>
      <div className="kb-deck__actions">
        <Button size="sm" variant="fill" icon="deck" busy={busy === 'study'} disabled={!!busy} onClick={() => void start('study', 'due')}>Study</Button>
        <Button size="sm" icon="hard" busy={busy === 'hard'} disabled={!!busy || deck.groups.hard === 0} onClick={() => void start('hard', 'hard')}>Hard first</Button>
        <Button size="sm" icon="chats" onClick={() => askAbout({ type: 'page', id: page.id, title: page.title })}>Ask in chat</Button>
      </div>
      {error && <p className="kb-inline-error" role="alert">{error}</p>}
      <ul className="kb-deck__list" aria-label="Cards" {...sel.gridProps} {...sel.listProps} onKeyDown={onKeyDown}>
        {deck.cards.map((card) => (
          <li key={card.id} className="kb-deck__row" {...sel.rowProps(card.id)}>
            <SelectionCheckbox checked={sel.selected.has(card.id)} />
            <span className="kb-deck__q" role="gridcell" tabIndex={-1}>
              {card.question}<small>{card.answer}</small>
            </span>
            <span role="gridcell">
              {card.suspended ? (
                <span className="kb-deck__hidden"><Icon name="hidden" size={13} />Not shown
                  <Button size="sm" onClick={() => void mark([card.id], 'unhide')}>Show again</Button></span>
              ) : (
                <>
                  <GroupChip group={card.group} />
                  <span className="kb-deck__marks" data-sel-ignore>
                    <Button size="sm" onClick={() => void mark([card.id], card.marked_hard ? 'unhard' : 'hard')}>{card.marked_hard ? 'Not hard' : 'Hard'}</Button>
                    <Button size="sm" onClick={() => void mark([card.id], 'known')}>Known</Button>
                    <IconButton icon="hidden" size="sm" label="Don’t show" onClick={() => void mark([card.id], 'hide')} />
                  </span>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A saved test page (S12): its questions, and "Take the test" as a block beside the chat. */
export function TestPage({ page }: { page: KbPage }) {
  const study = useStudyFromPage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const questions = page.blocks.filter((b) => b.kind === 'from_source');
  return (
    <div className="kb-deck">
      <p className="kb-deck__meta">Test · {questions.length} {questions.length === 1 ? 'question' : 'questions'}</p>
      <div className="kb-deck__actions">
        <Button size="sm" variant="fill" icon="test" busy={busy} onClick={async () => { setBusy(true); setError(await study(page.id, 'all')); setBusy(false); }}>
          Take the test
        </Button>
      </div>
      {error && <p className="kb-inline-error" role="alert">{error}</p>}
      <ol className="kb-deck__list" aria-label="Questions">
        {questions.map((b) => <li key={b.id} className="kb-deck__row"><span className="kb-deck__q">{b.text.split('::')[0]!.split('\n')[0]}</span></li>)}
      </ol>
    </div>
  );
}
