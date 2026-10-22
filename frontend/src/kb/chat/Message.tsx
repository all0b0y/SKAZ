import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import type { KbCitation, KbMessage, KbMessageInput, KbMessagePart } from '../../api/kb/types.gen';
import { Button, Icon, IconButton, useCopied, useIconPlay } from '../ui';
import { EngineBadge } from '../ui/EngineBadge';
import { quoteAttrs } from '../ui/Selection';
import { inputPieces, quoteLabel } from '../composer/editor';
import { useOpenDocument } from '../state/document';
import { useServices } from '../state/context';
import { InlineMarkdown } from './Markdown';
import { ConnectionBlock, InlinePart } from './parts';
import { FoldedSourcesRow, SourcesProvider } from '../cite/SourceMarks';
import { indexSources } from '../cite/sources';
import type { AnyMessagePart, KbPermissionPart, KbQuestionPart } from '../api/permissions';
import { PermissionCard } from './permission';
import { QuestionBlock } from './QuestionBlock';
import { StudyInChat } from '../study/StudyBlock';
import type { KbStudyPart } from '../study/api';
import type { KbWebSearchPart } from '../api/webSearch';
import { WebSearchCard } from './webSearch';
import { QuestionActionsRow, QuestionEditor, type QuestionActions } from './QuestionActions';
import { ConnectIndicator } from '../fx/indicators/ConnectIndicator';

/** An inline slot: a run of source citations (one claim) or a wiki page chip. */
export type InlineSlot =
  | { type: 'cites'; citations: KbCitation[] }
  | Extract<KbMessagePart, { type: 'page' }>;

type Block =
  | { kind: 'inline'; pieces: Array<string | number>; slots: InlineSlot[] }
  | { kind: 'connection'; part: Extract<KbMessagePart, { type: 'connection' }> }
  | { kind: 'permission'; part: KbPermissionPart }
  | { kind: 'question'; part: KbQuestionPart }
  | { kind: 'study'; part: KbStudyPart }
  | { kind: 'web'; part: KbWebSearchPart };

/**
 * Text/cite/page parts flow inline in one Markdown run; a connection is its own block. Citations
 * standing next to each other (only spaces between) are one claim's sources: one slot, so the
 * marks merge duplicates; the spaces before them go, so the number sits on the sentence.
 */
export function toBlocks(parts: readonly AnyMessagePart[]): Block[] {
  const out: Block[] = [];
  let run: Extract<Block, { kind: 'inline' }> | null = null;
  let pendingSpace: string | null = null;
  const lastCites = () => {
    const last = run?.pieces.at(-1);
    const slot = typeof last === 'number' ? run?.slots[last] : undefined;
    return slot?.type === 'cites' ? slot : null;
  };
  const flushSpace = () => {
    if (pendingSpace !== null && run) run.pieces.push(pendingSpace);
    pendingSpace = null;
  };
  for (const part of parts) {
    if (part.type === 'tool') continue;
    if (part.type === 'web_search') {
      // W-2: an agent's web search is its own block, apart from the material citations.
      flushSpace();
      run = null;
      out.push({ kind: 'web', part });
      continue;
    }
    if (part.type === 'connection' || part.type === 'permission' || part.type === 'question' || part.type === 'study') {
      // A connection, a permission request, an agent question (0.3.1 P) and a deck or test (S) are
      // blocks of their own.
      flushSpace();
      run = null;
      out.push(part.type === 'connection' ? { kind: 'connection', part } : part.type === 'permission' ? { kind: 'permission', part }
        : part.type === 'question' ? { kind: 'question', part } : { kind: 'study', part });
      continue;
    }
    if (!run) { run = { kind: 'inline', pieces: [], slots: [] }; out.push(run); }
    if (part.type === 'text') {
      if (!part.text.trim() && part.text.length > 0 && !part.text.includes('\n') && lastCites()) {
        pendingSpace = (pendingSpace ?? '') + part.text;
        continue;
      }
      flushSpace();
      run.pieces.push(part.text);
      continue;
    }
    if (part.type === 'cite') {
      const open = lastCites();
      if (open) { pendingSpace = null; open.citations.push(part.citation); continue; }
      flushSpace();
      const prev = run.pieces.at(-1);
      if (typeof prev === 'string') run.pieces[run.pieces.length - 1] = prev.replace(/[ \t]+$/, '');
      run.pieces.push(run.slots.length);
      run.slots.push({ type: 'cites', citations: [part.citation] });
      continue;
    }
    flushSpace();
    run.pieces.push(run.slots.length);
    run.slots.push(part);
  }
  flushSpace();
  return out;
}

/** Every citation of an answer in reading order: the numbering of its sources. */
export function answerCitations(parts: KbMessagePart[]): KbCitation[] {
  return parts.flatMap((p) => {
    if (p.type === 'cite') return [p.citation];
    if (p.type === 'connection') return p.folders.map((f) => f.citation);
    return [];
  });
}

/** Plain text of an answer for "Copy": the words, chips as their names. */
export function plainText(parts: KbMessagePart[]): string {
  return parts.map((p) => {
    if (p.type === 'text') return p.text;
    if (p.type === 'cite') return p.citation.material_title ?? '';
    if (p.type === 'page') return p.page.title;
    if (p.type === 'connection') return `\n${p.folders.map((f) => `${f.folder_name}: ${f.text}`).join('\n')}\n${p.inference}\n`;
    return '';
  }).join('').trim();
}

function Parts({ chatId, parts }: { chatId: string; parts: readonly AnyMessagePart[] }) {
  const open = useOpenDocument();
  const { ui } = useServices();
  return (
    <>
      {toBlocks(parts).map((b, i) => {
        if (b.kind === 'connection') return <ConnectionBlock key={i} folders={b.part.folders} inference={b.part.inference} page={b.part.page} />;
        if (b.kind === 'permission') {
          const partId = b.part.id;
          return (
            <PermissionCard key={partId} chatId={chatId} part={b.part} onOpen={(id) => open({ type: 'page', id })}
              onReview={() => ui.getState().openReview(chatId, partId)} />
          );
        }
        if (b.kind === 'question') return <QuestionBlock key={b.part.id} chatId={chatId} part={b.part} />;
        if (b.kind === 'study') return <StudyInChat key={b.part.id} chatId={chatId} part={b.part} />;
        if (b.kind === 'web') return <WebSearchCard key={b.part.id} chatId={chatId} part={b.part} />;
        return <InlineMarkdown key={i} pieces={b.pieces} slot={(index, key) => <InlinePart key={key} part={b.slots[index]!} />} />;
      })}
    </>
  );
}

/** SKAZ's web search tool (backend `permissions/web_tool.py` WEB_TOOL). */
const WEB_TOOL = 'skaz_web_search';

/** What the agent looked at ("Read page Entropy"), folded. */
function Tools({ parts }: { parts: KbMessagePart[] }) {
  // W-3b: the skaz_web_search call has its own «Searched the web» line — not repeated here.
  const tools = parts.filter((p): p is Extract<KbMessagePart, { type: 'tool' }> => p.type === 'tool' && !p.name.endsWith(WEB_TOOL));
  const [open, setOpen] = useState(false);
  if (!tools.length) return null;
  return (
    <div className="kb-tools">
      <button type="button" className="kb-tools__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="tool" size={13} />Looked at {tools.length} {tools.length === 1 ? 'thing' : 'things'}
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} />
      </button>
      {open && <ul className="kb-tools__list">{tools.map((t, i) => <li key={i}>{t.label}</li>)}</ul>}
    </div>
  );
}

function retryText(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const today = new Date().toDateString() === t.toDateString();
  const time = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return today ? ` The limit resets at ${time}.` : ` The limit resets on ${t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} at ${time}.`;
}

const FAILURE_TITLE: Record<string, string> = {
  limit: 'Answer interrupted: subscription limit',
  auth: 'Answer interrupted: signed out',
  incompatible: 'Answer interrupted: the agent needs an update',
  network: 'Answer interrupted: no connection',
  cancelled: 'Answer stopped',
  other: 'Answer interrupted',
};

export interface AnswerActions {
  onRegenerate: () => void;
  onResume: () => void;
  onSave: () => void;
  busy: string | null;
  /** Why Regenerate/Resume didn't start, shown by the buttons; `fix` is the way to fix the agent. */
  error?: string | null;
  fix?: ReactNode;
}

/** One assistant answer: parts, the interruption card, and the actions under it. */
export function AssistantMessage({ chatId, message, actions }: { chatId: string; message: KbMessage; actions: AnswerActions }) {
  const [copied, setCopied] = useCopied();
  // Feedback motion (animated-icons spec): the ✓ draws itself after a copy, the arrow turns on Regenerate.
  const [copyPlay, replayCopy] = useIconPlay();
  const [regenPlay, replayRegen] = useIconPlay();
  const open = useOpenDocument();
  const empty = message.parts.filter((p) => p.type !== 'tool').length === 0;
  const interrupted = message.state === 'interrupted' || message.state === 'failed';
  const sources = useMemo(() => indexSources(answerCitations(message.parts)), [message.parts]);
  return (
    <article className="kb-msg kb-msg--assistant" data-state={message.state} aria-label="Answer">
      <Tools parts={message.parts} />
      <div className="kb-msg__body" {...quoteAttrs({ source: 'chat', id: chatId, message_id: message.id })}>
        {empty && message.state === 'streaming' && (
          // FX §7: «Connecting nodes» beside the words; the canvas is decorative, the text is the status.
          <p className="kb-msg__wait" role="status"><ConnectIndicator className="kb-msg__think" />Writing an answer…</p>
        )}
        <SourcesProvider index={sources}>
          <Parts chatId={chatId} parts={message.parts} />
        </SourcesProvider>
      </div>
      <FoldedSourcesRow index={sources} foldKey={`sources:${chatId}/${message.id}`} />
      {interrupted && message.failure && (
        <div className="kb-interrupt" role="alert">
          <Icon name="clock" size={16} className="kb-interrupt__icon" />
          <div className="kb-interrupt__text">
            <b>{FAILURE_TITLE[message.failure.kind] ?? FAILURE_TITLE.other}</b>
            <p>{message.failure.message}{message.failure.kind === 'limit' ? retryText(message.failure.retry_at) : ''} The answer starts over; your question is kept.</p>
          </div>
          <Button size="sm" variant="fill" icon="retry" busy={actions.busy === 'resume'} onClick={actions.onResume}>Resume</Button>
        </div>
      )}
      {actions.error && (
        <p className="kb-inline-error kb-inline-error--flat kb-msg__error" role="alert">{actions.error}{actions.fix && <> {actions.fix}</>}</p>
      )}
      {message.state === 'cancelled' && <p className="kb-msg__note">Stopped. The question is kept — you can regenerate the answer.</p>}
      {(message.state === 'done' || message.state === 'cancelled') && (
        <div className="kb-msg__actions" role="group" aria-label="Answer actions">
          <IconButton icon={copied ? 'check' : 'copy'} iconPlay={copyPlay} label={copied ? 'Copied' : 'Copy'} size="sm"
            onClick={async () => {
              const ok = await copyToClipboard(plainText(message.parts));
              setCopied(ok);
              if (ok) replayCopy();
            }} />
          <IconButton icon="retry" iconPlay={regenPlay} label="Regenerate" size="sm" disabled={actions.busy === 'regenerate'}
            onClick={() => { replayRegen(); actions.onRegenerate(); }} />
          {message.saved_page_id ? (
            <IconButton icon="check" label="Saved to wiki — open" size="sm"
              onClick={() => open({ type: 'page', id: message.saved_page_id! })} />
          ) : (
            <IconButton icon="saveWiki" label="Save to wiki" size="sm" disabled={actions.busy === 'save' || message.state !== 'done'} onClick={actions.onSave} />
          )}
        </div>
      )}
    </article>
  );
}

/** What the user typed: the stored input, or (older messages) the text of its parts. */
export function questionInput(message: KbMessage): KbMessageInput {
  return message.input ?? {
    text: message.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''), mentions: [], quotes: [], attachments: [],
  };
}

/**
 * The question as typed: mentions and quotes stay tokens (decision 23). With `actions`: Copy · Edit ·
 * Resend under it (2026-10-21); Edit turns the bubble into a field in place.
 */
export function UserMessage({ message, actions }: { message: KbMessage; actions?: QuestionActions }) {
  const input = questionInput(message);
  const [editing, setEditing] = useState(false);
  const articleRef = useRef<HTMLElement | null>(null);
  const refocus = useRef(false);
  // Cancel: the focus goes back to Edit, where the user started.
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    articleRef.current?.querySelector<HTMLElement>('[aria-label="Edit"]')?.focus();
  }, [editing]);
  const close = () => { refocus.current = true; setEditing(false); };
  return (
    <article className={`kb-msg kb-msg--user${editing ? ' is-editing' : ''}`} aria-label="Your question" ref={articleRef}>
      {editing && actions ? (
        <QuestionEditor input={input} onCancel={close} onSend={async (next) => {
          const failed = await actions.onEdit(next);
          if (!failed) close();
          return failed;
        }} />
      ) : (
        <div className="kb-msg__bubble">{renderInput(input)}</div>
      )}
      {input.attachments.length > 0 && (
        <p className="kb-msg__attach"><Icon name="attach" size={12} />{input.attachments.length} {input.attachments.length === 1 ? 'attachment' : 'attachments'}</p>
      )}
      {actions && !editing && <QuestionActionsRow text={input.text} actions={actions} onEdit={() => setEditing(true)} />}
      {actions?.error && !editing && <p className="kb-inline-error kb-inline-error--flat kb-msg__error" role="alert">{actions.error}</p>}
    </article>
  );
}

export function renderInput(input: KbMessageInput): ReactNode {
  return inputPieces(input).map((piece, i) => {
    if (typeof piece === 'string') return piece;
    if (piece.kind === 'mention') {
      const { ref } = piece;
      return <span key={`m${i}`} className="kb-token kb-token--mention" data-icon={ref.type === 'chat' ? 'chat' : ref.type === 'material' ? 'material' : 'page'}>{ref.title}</span>;
    }
    return <span key={`q${i}`} className="kb-token kb-token--quote" data-icon="quote" title={piece.quote.text}>{quoteLabel(piece.quote.text)}</span>;
  });
}

/** "Switched to Claude Code" and similar records in the conversation; "Study" from a deck page (S12). */
export function SystemMessage({ chatId, message }: { chatId: string; message: KbMessage }) {
  const studies = message.parts.filter((p): p is KbStudyPart => p.type === 'study');
  if (studies.length) {
    return (
      <article className="kb-msg kb-msg--study" aria-label="Study">
        {studies.map((p) => <StudyInChat key={p.id} chatId={chatId} part={p} />)}
      </article>
    );
  }
  const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return (
    <p className="kb-msg kb-msg--system" role="note">
      {message.engine && <EngineBadge engine={message.engine} size={16} />}
      <span>{text}</span>
    </p>
  );
}
