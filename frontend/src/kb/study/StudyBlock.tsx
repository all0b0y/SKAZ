import { useEffect, useMemo, useRef, useState } from 'react';
import { m, useReducedMotion } from 'motion/react';
import { Button, EmptyState, Icon, IconButton } from '../ui';
import { SPRING_LARGE, SPRING_SMALL } from '../ui/motion';
import { PathText } from '../ui/PathText';
import { SourcesProvider } from '../cite/SourceMarks';
import { indexSources } from '../cite/sources';
import { useOpenDocument } from '../state/document';
import { useFold, useServices } from '../state/context';
import { agentName } from '../chat/permission';
import { RenameForm } from '../chat/ChatMenu';
import type { KbPermissionPart } from '../api/permissions';
import { MODE_LABEL, PLACE_LABEL, kindLabel, placeOf, studyApi, studyWhere, type KbStudyPart, type StudyPlace } from './api';
import { CardStack } from './CardStack';
import { TestRunner, QUESTION_LABEL } from './TestRunner';
import { useStudyActions, useStudyPart, useStudyRoute } from './useStudy';

/** The block's one size button (decision 2): the same slot, two states — never two buttons. */
const SIZE: Record<StudyPlace, { icon: 'grow' | 'shrink'; label: string; to: StudyPlace }> = {
  chat: { icon: 'grow', label: 'Bigger — beside the chat', to: 'panel' },
  panel: { icon: 'shrink', label: 'Smaller — back into the chat', to: 'chat' },
};

const engineOf = (p: KbStudyPart) => (p.engine ?? 'codex') as KbPermissionPart['engine'];

/**
 * Where keyboard focus lands after a move the user asked for: the block in its new place (chat or
 * beside it) — never lost to the page. Set just before the move, taken by the block that mounts there.
 */
let focusAfterMove: string | null = null;
const focusKey = (studyId: string, at: StudyPlace) => `${at}:${studyId}`;
const takeFocus = (studyId: string, at: StudyPlace) => {
  if (focusAfterMove !== focusKey(studyId, at)) return false;
  focusAfterMove = null;
  return true;
};
/** Move a block and keep the keyboard with it. */
function moveWithFocus(route: ReturnType<typeof useStudyRoute>, part: KbStudyPart, to: StudyPlace) {
  focusAfterMove = focusKey(part.id, to);
  return route(part, to);
}

/**
 * A deck or test block (S5, W2): header (fold chevron in the chat, the title — click it to rename —
 * progress, and one size arrow: ⤢ beside the chat / ⤡ back into the chat), the stack or the test,
 * and the "Save to wiki" row. The same block in the chat or beside it — never in two places.
 */
export function StudyBlock({ chatId, part, where }: { chatId: string; part: KbStudyPart; where: StudyPlace }) {
  const { ui, client } = useServices();
  const actions = useStudyActions(chatId, part.id);
  const route = useStudyRoute(chatId);
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLButtonElement | null>(null);
  const keys = useRef<((event: React.KeyboardEvent) => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  /** Rename ended from the keyboard (Enter, Esc): the title takes the focus back; a click elsewhere keeps it there. */
  const refocusTitle = useRef(false);
  // U2-a: only in the chat a block folds to its title line; open by default, kept across restarts.
  // Beside the chat it is always open (it was moved there to work with it).
  const [foldedInChat, setFolded] = useFold(`study:${part.id}`, false);
  const folded = where === 'chat' && foldedInChat;
  const deck = part.kind === 'deck';
  const total = deck ? part.cards.length : part.questions.length;
  const shown = Math.min(part.position + 1, total);
  const progress = total ? (deck ? Math.min(part.position, total) : part.result ? total : part.position) / total : 0;
  const sources = useMemo(() => indexSources(deck ? part.cards.flatMap((c) => c.citations) : part.questions.flatMap((q) => q.citations)),
    [deck, part.cards, part.questions]);
  const size = SIZE[where];
  const question = !deck && !part.result ? part.questions[Math.min(part.position, total - 1)] : undefined;
  const subtitle = part.origin === 'show' && deck ? MODE_LABEL[part.mode] : null;
  const canRename = part.origin === 'agent';

  const move = async (to: StudyPlace) => {
    setError(null);
    const res = await moveWithFocus(route, part, to);
    if (!res.ok) setError(res.error);
  };
  const startRename = () => { setError(null); setRenaming(true); };
  useEffect(() => { if (takeFocus(part.id, where)) ref.current?.focus(); }, [part.id, where]);
  useEffect(() => {
    if (renaming || !refocusTitle.current) return;
    refocusTitle.current = false;
    titleRef.current?.focus();
  }, [renaming]);

  return (
    <m.section ref={ref} className={`kb-st kb-st--${where}`} data-kind={part.kind} data-folded={folded || undefined} tabIndex={0}
      aria-label={`${kindLabel(part)}: ${part.title}`} layoutId={`study-${part.id}`}
      initial={reduced ? { opacity: 0 } : false} animate={{ opacity: 1, transition: reduced ? { duration: 0.14, ease: 'linear' } : SPRING_LARGE }}
      transition={SPRING_LARGE}
      onFocusCapture={() => ui.getState().focusStudy(chatId, part.id)} onKeyDown={(e) => { if (!folded) keys.current?.(e); }}>
      <header className="kb-st-head" data-renaming={renaming || undefined}>
        {where === 'chat' && (
          <IconButton icon={folded ? 'chevronDown' : 'chevronUp'} label={folded ? 'Expand' : 'Collapse'} size="sm"
            className="kb-st-fold" aria-expanded={!folded} onClick={() => setFolded(!folded)} />
        )}
        <Icon name={deck ? 'deck' : 'test'} size={15} />
        {/* Keys on the title and its rename field stay there: Space never flips the card, a letter never picks an answer. */}
        <span className="kb-st-titlewrap" onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation(); }}
          onKeyDownCapture={(e) => { if (renaming && (e.key === 'Enter' || e.key === 'Escape')) refocusTitle.current = true; }}>
          {renaming ? (
            // U3-a: a new title without a new agent run; a saved block renames its page (links follow).
            <RenameForm title={part.title} label={deck ? 'Deck name' : 'Test name'} onCancel={() => setRenaming(false)}
              onSave={async (next) => {
                const r = await actions.run(() => studyApi.rename(client, part.id, next));
                if (!r.ok) return r.error;
                setRenaming(false);
                return null;
              }} />
          ) : (
            <span className="kb-st-title" title={part.title}>
              <span className="kb-st-kindl">{kindLabel(part)} ·</span>
              {canRename ? (
                <button ref={titleRef} type="button" className="kb-st-title__btn" aria-label={`Rename: ${part.title}`}
                  aria-keyshortcuts="F2" onClick={startRename}
                  onKeyDown={(e) => { if (e.key === 'F2') { e.preventDefault(); startRename(); } }}>{part.title}</button>
              ) : <span className="kb-st-title__text">{part.title}</span>}
            </span>
          )}
        </span>
        {!renaming && (
          <>
            {subtitle && <span className="kb-st-sub">· {subtitle}</span>}
            {question && <span className="kb-st-sub">· {QUESTION_LABEL[question.type]}</span>}
            <span className="kb-st-cnt">{!deck && part.result ? 'done' : total ? `${shown} / ${total}` : '0'}</span>
          </>
        )}
        <span className="kb-st-route">
          <IconButton icon={size.icon} label={size.label} size="sm" onClick={() => void move(size.to)} />
        </span>
      </header>
      {!folded && (
        <>
          <div className="kb-st-bar" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.round(progress * total)}>
            <i style={{ width: `${progress * 100}%` }} />
          </div>
          <SourcesProvider index={sources}>
            {deck
              ? <CardStack part={part} actions={actions} onError={setError} keys={keys} />
              : <TestRunner part={part} actions={actions} onError={setError} keys={keys} />}
          </SourcesProvider>
          {error && <p className="kb-inline-error kb-st-error" role="alert">{error}</p>}
          {part.origin === 'agent' && <SaveRow chatId={chatId} part={part} />}
        </>
      )}
    </m.section>
  );
}

/** The block's last row (S6): ask to create the page, or say where it is / that it stays in the chat. */
function SaveRow({ chatId, part }: { chatId: string; part: KbStudyPart }) {
  const { client } = useServices();
  const open = useOpenDocument();
  const actions = useStudyActions(chatId, part.id);
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deck = part.kind === 'deck';
  const decide = async (decision: 'allow' | 'deny') => {
    setBusy(decision);
    setError(null);
    const res = await actions.run(() => studyApi.save(client, part.id, decision));
    setBusy(null);
    if (!res.ok) setError(res.error);
  };
  const status = part.save.status;
  return (
    <div className="kb-st-save" data-status={status}>
      {status === 'saved' ? (
        <>
          <Icon name="allowed" size={15} />
          <span>Saved to wiki</span>
          <span className="kb-st-path"><PathText path={part.save.path} /></span>
          {part.save.page_id && (
            <span className="kb-st-sv"><Button size="sm" onClick={() => open({ type: 'page', id: part.save.page_id! })}>Open</Button></span>
          )}
        </>
      ) : status === 'denied' ? (
        <>
          <Icon name="about" size={15} />
          <span className="kb-st-path">Not saved — this {deck ? 'deck' : 'test'} lives only in this chat{deck ? '; grades are not scheduled' : ''}.</span>
          <span className="kb-st-sv"><Button size="sm" busy={busy === 'allow'} onClick={() => void decide('allow')}>Save to wiki</Button></span>
        </>
      ) : (
        <>
          <Icon name="permission" size={15} />
          <span><b>{agentName(engineOf(part))} wants to create</b></span>
          <span className="kb-st-path"><PathText path={part.save.path} /></span>
          <span className="kb-st-sv">
            <Button size="sm" busy={busy === 'deny'} disabled={!!busy} onClick={() => void decide('deny')}>Deny</Button>
            <Button size="sm" variant="fill" busy={busy === 'allow'} disabled={!!busy} onClick={() => void decide('allow')}>Save to wiki</Button>
          </span>
        </>
      )}
      {error && <p className="kb-inline-error kb-st-error" role="alert">{error}</p>}
    </div>
  );
}

/**
 * What stays in the thread while the block is beside the chat (W2): the block folded to one row
 * (U2, decision 5) — its title, size, where it is open, and Bring back. The block itself is always
 * open there; its fold in the chat is kept for when it comes back.
 */
export function StudyPlaceholder({ chatId, part }: { chatId: string; part: KbStudyPart }) {
  const route = useStudyRoute(chatId);
  const [error, setError] = useState<string | null>(null);
  const deck = part.kind === 'deck';
  const total = deck ? part.cards.length : part.questions.length;
  return (
    <m.div className="kb-st-ph" role="group" aria-label={`${kindLabel(part)}: ${part.title}`} tabIndex={-1}
      data-place="panel" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0, transition: { ...SPRING_SMALL, delay: 0.12 } }}>
      <Icon name={deck ? 'deck' : 'test'} size={15} />
      <b className="kb-st-ph__title" title={part.title}>{`${kindLabel(part)} · ${part.title}`}</b>
      <span className="kb-st-ph__cnt">
        {total} {deck ? (total === 1 ? 'card' : 'cards') : (total === 1 ? 'question' : 'questions')}
      </span>
      <span className="kb-st-ph__where"><Icon name="panelRight" size={12} />Open beside the chat</span>
      <Button size="sm" onClick={async () => { const r = await moveWithFocus(route, part, 'chat'); setError(r.ok ? null : r.error); }}>Bring back</Button>
      {error && <p className="kb-inline-error" role="alert">{error}</p>}
    </m.div>
  );
}

/**
 * A study part of a message: the block itself, or its placeholder while it is beside the chat.
 * A block stored in the retired own window (`window`) is shown here, in the chat.
 */
export function StudyInChat({ chatId, part }: { chatId: string; part: KbStudyPart }) {
  if (placeOf(part) === 'panel') return <StudyPlaceholder chatId={chatId} part={part} />;
  return <StudyBlock chatId={chatId} part={part} where="chat" />;
}

/** The block beside the chat (RightView `study`): no header of its own — the block's ⤡ takes it back. */
export function StudyPanel({ chatId, studyId }: { chatId: string; studyId: string }) {
  const part = useStudyPart(chatId, studyId);
  const { ui } = useServices();
  return (
    <div className="kb-st-panel">
      <div className="kb-st-panel__body">
        {part
          ? <StudyBlock chatId={chatId} part={part} where="panel" />
          : (
            <EmptyState icon="wiki" title="This block isn’t here any more" compact
              action={<Button size="sm" onClick={() => ui.getState().closeDoc()}>Close</Button>}>
              Open its chat to see it.
            </EmptyState>
          )}
      </div>
    </div>
  );
}

/**
 * "Agent sees: Flashcards · card 3 of 12 · answer side · beside the chat" above the message field
 * (W2): what goes to the agent as open with the next message, so "this card" means this one.
 */
export function StudyContextChip({ chatId, part }: { chatId: string; part: KbStudyPart }) {
  const { ui } = useServices();
  const place = placeOf(part);
  return (
    <div className="kb-st-ctx" role="note" aria-label={`Agent sees: ${kindLabel(part)}, ${studyWhere(part)}, ${PLACE_LABEL[place]}`}>
      <Icon name="agent" size={13} />
      <span>Agent sees:</span>
      <span className="kb-st-ctx__tok">
        <Icon name={part.kind === 'deck' ? 'deck' : 'test'} size={12} />{kindLabel(part)} · {studyWhere(part)}
      </span>
      <span>{PLACE_LABEL[place]}</span>
      {place === 'chat' && (
        <button type="button" className="kb-st-ctx__x" aria-label="Don’t send this to the agent"
          onClick={() => ui.getState().dismissStudyContext(chatId)}><Icon name="close" size={12} /></button>
      )}
    </div>
  );
}
