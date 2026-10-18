import { useMemo, useState, type ReactNode } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import type { KbCitation, KbMessage, KbMessageInput, KbMessagePart } from '../../api/kb/types.gen';
import { Button, Icon, IconButton } from '../ui';
import { EngineBadge } from '../ui/EngineBadge';
import { quoteAttrs } from '../ui/Selection';
import { quoteLabel } from '../composer/editor';
import { useOpenDocument } from '../state/document';
import { useServices } from '../state/context';
import { InlineMarkdown } from './Markdown';
import { ConnectionBlock, InlinePart } from './parts';
import { SourcesProvider, SourcesRow } from '../cite/SourceMarks';
import { indexSources } from '../cite/sources';
import type { AnyMessagePart, KbPermissionPart, KbQuestionPart } from '../api/permissions';
import { PermissionCard } from './permission';
import { QuestionBlock } from './QuestionBlock';
import { StudyInChat } from '../study/StudyBlock';
import type { KbStudyPart } from '../study/api';

/** An inline slot: a run of source citations (one claim) or a wiki page chip. */
export type InlineSlot =
  | { type: 'cites'; citations: KbCitation[] }
  | Extract<KbMessagePart, { type: 'page' }>;

type Block =
  | { kind: 'inline'; pieces: Array<string | number>; slots: InlineSlot[] }
  | { kind: 'connection'; part: Extract<KbMessagePart, { type: 'connection' }> }
  | { kind: 'permission'; part: KbPermissionPart }
  | { kind: 'question'; part: KbQuestionPart }
  | { kind: 'study'; part: KbStudyPart };

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
        return <InlineMarkdown key={i} pieces={b.pieces} slot={(index, key) => <InlinePart key={key} part={b.slots[index]!} />} />;
      })}
    </>
  );
}

/** What the agent looked at ("Read page Entropy"), folded. */
function Tools({ parts }: { parts: KbMessagePart[] }) {
  const tools = parts.filter((p): p is Extract<KbMessagePart, { type: 'tool' }> => p.type === 'tool');
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
  const [copied, setCopied] = useState(false);
  const open = useOpenDocument();
  const empty = message.parts.filter((p) => p.type !== 'tool').length === 0;
  const interrupted = message.state === 'interrupted' || message.state === 'failed';
  const sources = useMemo(() => indexSources(answerCitations(message.parts)), [message.parts]);
  return (
    <article className="kb-msg kb-msg--assistant" data-state={message.state} aria-label="Answer">
      <Tools parts={message.parts} />
      <div className="kb-msg__body" {...quoteAttrs({ source: 'chat', id: chatId, message_id: message.id })}>
        {empty && message.state === 'streaming' && <p className="kb-msg__wait" role="status">Writing an answer…</p>}
        <SourcesProvider index={sources}>
          <Parts chatId={chatId} parts={message.parts} />
        </SourcesProvider>
      </div>
      <SourcesRow index={sources} />
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
          <IconButton icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : 'Copy'} size="sm"
            onClick={async () => setCopied(await copyToClipboard(plainText(message.parts)))} />
          <IconButton icon="retry" label="Regenerate" size="sm" disabled={actions.busy === 'regenerate'} onClick={actions.onRegenerate} />
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

/** The question as typed: mentions and quotes stay tokens (decision 23). */
export function UserMessage({ message }: { message: KbMessage }) {
  const input: KbMessageInput = message.input ?? {
    text: message.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''), mentions: [], quotes: [], attachments: [],
  };
  return (
    <article className="kb-msg kb-msg--user" aria-label="Your question">
      <div className="kb-msg__bubble">{renderInput(input)}</div>
      {input.attachments.length > 0 && (
        <p className="kb-msg__attach"><Icon name="attach" size={12} />{input.attachments.length} {input.attachments.length === 1 ? 'attachment' : 'attachments'}</p>
      )}
    </article>
  );
}

export function renderInput(input: KbMessageInput): ReactNode {
  const marks: Array<{ at: number; len: number; node: ReactNode }> = [];
  const used = new Set<number>();
  const find = (needle: string, node: ReactNode) => {
    let from = 0;
    for (;;) {
      const at = input.text.indexOf(needle, from);
      if (at < 0) return;
      if (![...used].some((u) => u >= at && u < at + needle.length)) {
        for (let i = at; i < at + needle.length; i += 1) used.add(i);
        marks.push({ at, len: needle.length, node });
        return;
      }
      from = at + 1;
    }
  };
  input.mentions.forEach((ref, i) => find(`@${ref.title}`, <span key={`m${i}`} className="kb-token kb-token--mention" data-icon={ref.type === 'chat' ? 'chat' : ref.type === 'material' ? 'material' : 'page'}>{ref.title}</span>));
  input.quotes.forEach((q, i) => find(`“${quoteLabel(q.text)}”`, <span key={`q${i}`} className="kb-token kb-token--quote" data-icon="quote" title={q.text}>{quoteLabel(q.text)}</span>));
  marks.sort((a, b) => a.at - b.at);
  const out: ReactNode[] = [];
  let pos = 0;
  for (const mk of marks) {
    if (mk.at > pos) out.push(input.text.slice(pos, mk.at));
    out.push(mk.node);
    pos = mk.at + mk.len;
  }
  if (pos < input.text.length) out.push(input.text.slice(pos));
  return out;
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
