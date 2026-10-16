import { useEffect, useRef, useState, type FormEvent } from 'react';
import { m } from 'motion/react';
import { Button, Icon, IconButton, type IconName } from '../ui';
import { SPRING_SMALL } from '../ui/motion';
import { useChats, useServices } from '../state/context';
import { ENGINE_NAME } from '../state/agents';
import type { KbPermissionChange, KbPermissionDecision, KbPermissionKind, KbPermissionPart } from '../api/permissions';

/** «Codex», «Claude Code», «Hermes»: the agent as the card names it. */
export const agentName = (engine: KbPermissionPart['engine']): string => ENGINE_NAME[engine].replace(/ Agent$/, '');

const VERB: Record<KbPermissionKind, string> = { create: 'create', edit: 'edit', rename: 'rename', delete: 'delete' };
const PAST: Record<KbPermissionKind, string> = { create: 'Created', edit: 'Edited', rename: 'Renamed', delete: 'Deleted' };
const OP: Record<KbPermissionChange['op'], { tag: string; cls: string }> = {
  add: { tag: 'Added', cls: 'add' },
  replace: { tag: 'Changed', cls: 'chg' },
  remove: { tag: 'Removed', cls: 'del' },
};
/** What the user should know beyond the blocks (the contract has no counts of links). */
const NOTE: Partial<Record<KbPermissionKind, string>> = {
  delete: 'Links to this page are removed; the words stay. Sources stay.',
  rename: 'Links to this page follow the new name.',
};
/** Changes shown before «Show all N changes». */
const FIRST = 2;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** «Codex wants to edit Entropy» — the card's and the review panel's name. */
export const requestTitle = (part: KbPermissionPart) => `${agentName(part.engine)} wants to ${VERB[part.kind]} ${part.title}`;

export function summaryPills(part: KbPermissionPart): Array<{ text: string; tone: '' | 'add' | 'chg' | 'del' }> {
  if (part.kind === 'delete') return [{ text: 'page removed', tone: 'del' }];
  if (part.kind === 'rename') return [{ text: 'new name', tone: 'chg' }];
  const { added, changed, removed, user_notes_untouched: untouched } = part.summary;
  const out: Array<{ text: string; tone: '' | 'add' | 'chg' | 'del' }> = [];
  if (added) out.push({ text: `+${plural(added, 'block', 'blocks')}`, tone: 'add' });
  if (changed) out.push({ text: `${changed} changed`, tone: 'chg' });
  if (removed) out.push({ text: `${removed} removed`, tone: 'del' });
  if (untouched) out.push({ text: 'your notes untouched', tone: '' });
  return out;
}

export function SummaryPills({ part }: { part: KbPermissionPart }) {
  return (
    <ul className="kb-perm__sum" aria-label="Summary">
      {summaryPills(part).map((p) => <li key={p.text} className={`kb-perm__pill${p.tone ? ` kb-perm__pill--${p.tone}` : ''}`}>{p.text}</li>)}
    </ul>
  );
}

/** The change by block: Added / Changed / Removed in words (never colour only) and the block's label. */
export function ChangeList({ part, limit }: { part: KbPermissionPart; limit?: number }) {
  const list = limit ? part.changes.slice(0, limit) : part.changes;
  return (
    <ol className="kb-perm__changes" aria-label="Changes">
      {list.map((c, i) => {
        const op = OP[c.op] ?? OP.replace;
        return (
          <li key={`${c.block_id ?? 'new'}-${i}`} className={`kb-perm__blk kb-perm__blk--${op.cls}`} data-block-kind={c.block_kind}>
            <div className="kb-perm__lab"><span className="kb-perm__tag">{op.tag}</span> · {c.label || c.block_kind}</div>
            {c.op === 'replace' && c.before && <del className="kb-perm__old">{c.before}</del>}
            {c.op === 'remove' ? <p className="kb-perm__text">{c.before ?? c.after}</p>
              : c.after && <p className="kb-perm__text">{c.after}</p>}
          </li>
        );
      })}
    </ol>
  );
}

export function KindNote({ part }: { part: KbPermissionPart }) {
  const note = NOTE[part.kind];
  return note ? <p className="kb-perm__note">{note}</p> : null;
}

/**
 * Deny / Allow in this chat / Allow (Delete page for a delete — always asked, P3). Deny opens an
 * optional reason for the agent: Enter sends it, Esc goes back to the buttons. The same bar sits at
 * the bottom of the card and of the review beside the chat.
 */
export function DecisionBar({ chatId, part }: { chatId: string; part: KbPermissionPart }) {
  const { chats } = useServices();
  const agent = agentName(part.engine);
  const del = part.kind === 'delete';
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<KbPermissionDecision['decision'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const denyRef = useRef<HTMLButtonElement | null>(null);
  const backToDeny = useRef(false);

  useEffect(() => {
    if (!denying && backToDeny.current) {
      backToDeny.current = false;
      denyRef.current?.focus();
    }
  }, [denying]);

  const send = async (decision: KbPermissionDecision['decision'], why?: string) => {
    if (busy) return;
    setBusy(decision);
    setError(null);
    const body: KbPermissionDecision = why ? { decision, reason: why } : { decision };
    const res = await chats.getState().decide(chatId, part.id, body);
    setBusy(null);
    if (!res.ok) setError(res.error);
  };
  const cancelDeny = () => { backToDeny.current = true; setDenying(false); };
  const submitDeny = (event: FormEvent) => {
    event.preventDefault();
    void send('deny', reason.trim() || undefined);
  };

  return (
    <>
      {denying ? (
        <form className="kb-perm__deny" onSubmit={submitDeny}>
          <input
            className="kb-perm__reason" autoFocus value={reason} maxLength={500}
            aria-label={`Reason for ${agent} (optional)`} placeholder={`Tell ${agent} why (optional)`}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelDeny(); } }}
          />
          <Button type="submit" size="sm" variant="fill" busy={busy === 'deny'}>Send</Button>
          <Button size="sm" onClick={cancelDeny}>Cancel</Button>
        </form>
      ) : (
        <div className="kb-perm__foot" role="group" aria-label="Decision">
          <Button ref={denyRef} size="sm" onClick={() => setDenying(true)} disabled={!!busy}>Deny</Button>
          <span className="kb-perm__spacer" />
          {!del && <Button size="sm" busy={busy === 'allow_chat'} disabled={!!busy} onClick={() => void send('allow_chat')}>Allow in this chat</Button>}
          <Button size="sm" variant={del ? 'danger' : 'fill'} className={del ? 'kb-perm__delete' : undefined}
            busy={busy === 'allow'} disabled={!!busy} onClick={() => void send('allow')}>{del ? 'Delete page' : 'Allow'}</Button>
        </div>
      )}
      {error && <p className="kb-inline-error kb-perm__error" role="alert">{error}</p>}
    </>
  );
}

/** One line for a decided request: what happened, and Open / Undo where it makes sense. */
export function PermissionOutcome({ chatId, part, onOpen }: { chatId: string; part: KbPermissionPart; onOpen?: (pageId: string) => void }) {
  const { chats } = useServices();
  const decided = useChats((s) => s.decisions[part.id]);
  const agent = agentName(part.engine);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let icon: IconName = 'allowed';
  let state = 'Allowed';
  let line = part.title;
  let detail: string | null = null;
  if (part.status === 'allowed') {
    state = part.auto ? 'Allowed in this chat · no question' : decided === 'allow_chat' ? 'Allowed in this chat' : 'Allowed';
    line = `${PAST[part.kind]} ${part.title}`;
  } else if (part.status === 'denied') {
    icon = 'denied';
    state = 'Denied';
    detail = part.reason ? `Your reason was sent to ${agent}: “${part.reason}”` : `${agent} was told no`;
  } else if (part.status === 'cancelled') {
    icon = 'cancelled';
    state = 'Cancelled';
    detail = 'No change was made';
  } else if (part.status === 'undone') {
    icon = 'undo';
    state = 'Undone';
    detail = 'back as it was';
  }
  const canOpen = part.status === 'allowed' && !part.auto && part.kind !== 'delete' && !!part.page_id && !!onOpen;
  const canUndo = part.status === 'allowed' && part.auto;

  const undo = async () => {
    setBusy(true);
    setError(null);
    const res = await chats.getState().undo(chatId, part.id);
    setBusy(false);
    if (!res.ok) setError(res.error);
  };

  return (
    <m.div className="kb-perm-done" data-status={part.status} role="group" aria-label={`${state}: ${line}`}
      initial={{ opacity: 0 }} animate={{ opacity: 1, transition: SPRING_SMALL }}>
      <div className="kb-perm-done__row">
        <Icon name={icon} size={15} className="kb-perm-done__icon" />
        <b>{state}</b>
        <span className="kb-perm-done__line" title={line}>{line}</span>
        {detail && <span className="kb-perm-done__detail" title={detail}>{detail}</span>}
        <span className="kb-perm__spacer" />
        {canOpen && <Button size="sm" onClick={() => onOpen?.(part.page_id!)}>Open</Button>}
        {canUndo && <Button size="sm" icon="undo" busy={busy} onClick={() => void undo()}>Undo</Button>}
      </div>
      {error && <p className="kb-inline-error kb-perm__error" role="alert">{error}</p>}
    </m.div>
  );
}

/**
 * An agent's request to change the wiki, in the chat (P4 variant A): who wants what and where, a
 * one-line summary, the first changes by block, «Show all N changes»; the book icon opens the same
 * review beside the chat. Decided, it folds into one line.
 */
export function PermissionCard({ chatId, part, onOpen, onReview }: {
  chatId: string; part: KbPermissionPart; onOpen?: (pageId: string) => void; onReview?: () => void;
}) {
  const [all, setAll] = useState(false);
  if (part.status !== 'pending') return <PermissionOutcome chatId={chatId} part={part} onOpen={onOpen} />;
  const many = part.changes.length > FIRST && !all;
  const name = requestTitle(part);
  return (
    <m.section className="kb-perm" aria-label={name} data-kind={part.kind}
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0, transition: SPRING_SMALL }}>
      <header className="kb-perm__head">
        <Icon name="permission" size={16} />
        <b>{agentName(part.engine)} wants to {VERB[part.kind]}</b>
        <span className="kb-perm__path" title={part.title}>{part.title}</span>
        <span className="kb-perm__spacer" />
        {onReview && <IconButton icon="wiki" size="sm" label="Review beside the chat" onClick={onReview} />}
      </header>
      <SummaryPills part={part} />
      <div className="kb-perm__body">
        <ChangeList part={part} limit={many ? FIRST : undefined} />
        <KindNote part={part} />
        {many && (
          <button type="button" className="kb-perm__more" onClick={() => setAll(true)}>Show all {part.changes.length} changes</button>
        )}
      </div>
      <DecisionBar chatId={chatId} part={part} />
    </m.section>
  );
}
