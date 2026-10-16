import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { m } from 'motion/react';
import { Button, Icon } from '../ui';
import { SPRING_SMALL } from '../ui/motion';
import { useServices } from '../state/context';
import type { KbQuestionAnswer, KbQuestionPart } from '../api/permissions';
import { agentName } from './permission';

/** Rows the digit keys pick (Q-A3: 1–4). */
const KEYS = 4;

/**
 * An agent's question in the chat (Q-A3, view 1 «Rows with descriptions»): the recommended option
 * first and marked, numbered rows with a line of description, «Other answer…» at the bottom. With
 * the block focused, 1–4 pick a row. Nothing waits on it: the composer stays free, and a message of
 * your own closes the question (Q-A2) — an option can still be picked later, as a new message.
 */
export function QuestionBlock({ chatId, part }: { chatId: string; part: KbQuestionPart }) {
  const { chats } = useServices();
  const agent = agentName(part.engine);
  const baseId = useId();
  const blockRef = useRef<HTMLElement | null>(null);
  const [picking, setPicking] = useState(false);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The recommended option first; each keeps its own index for the answer.
  const rows = useMemo(() => part.options.map((o, index) => ({ ...o, index }))
    .sort((a, b) => Number(b.recommended) - Number(a.recommended)), [part.options]);

  const send = async (body: KbQuestionAnswer) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await chats.getState().answer(chatId, part.id, body);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else setPicking(false);
  };

  const asked = `${agent} asked: ${part.question}`;
  if (part.status === 'answered' || part.status === 'cancelled' || (part.status === 'superseded' && !picking)) {
    const chose = part.status === 'answered' && part.options.some((o) => o.label === part.answer);
    return (
      <m.div className="kb-q-done" role="group" aria-label={asked} data-status={part.status}
        initial={{ opacity: 0 }} animate={{ opacity: 1, transition: SPRING_SMALL }}>
        <Icon name={part.status === 'answered' ? 'allowed' : part.status === 'cancelled' ? 'cancelled' : 'about'} size={15} />
        <span className="kb-q-done__text" title={part.question}>
          {asked} ·{' '}
          {part.status === 'answered' && <>{chose ? 'You chose' : 'You answered'} <b>{part.answer}</b></>}
          {part.status === 'cancelled' && 'Cancelled'}
          {part.status === 'superseded' && 'You wrote your own message'}
        </span>
        {part.status === 'superseded' && (
          <Button size="sm" onClick={() => { setPicking(true); window.setTimeout(() => blockRef.current?.focus(), 0); }}>Pick an option</Button>
        )}
      </m.div>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const n = Number(event.key);
    if (!Number.isInteger(n) || n < 1 || n > Math.min(KEYS, rows.length)) return;
    event.preventDefault();
    void send({ option_index: rows[n - 1]!.index });
  };
  const submitOther = (event: FormEvent) => {
    event.preventDefault();
    const text = other.trim();
    if (text) void send({ text });
  };

  return (
    <m.section ref={blockRef} className="kb-q" tabIndex={0} aria-label={picking ? asked : `${agent} asks: ${part.question}`}
      aria-keyshortcuts={rows.slice(0, KEYS).map((_, i) => String(i + 1)).join(' ')} onKeyDown={onKeyDown}
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0, transition: SPRING_SMALL }}>
      <div className="kb-q__head">
        <Icon name="agent" size={14} />
        {picking ? `${agent} asked · your pick goes to ${agent} as a new message` : `${agent} asks · answer now or later — you can just type`}
      </div>
      <p className="kb-q__text">{part.question}</p>
      <ol className="kb-q__opts" aria-label="Options">
        {rows.map((o, i) => (
          <li key={o.index}>
            <button type="button" className="kb-q__opt" disabled={busy}
              aria-label={`${o.label}${o.recommended ? ', recommended' : ''}`}
              aria-describedby={o.description ? `${baseId}-d${o.index}` : undefined}
              aria-keyshortcuts={i < KEYS ? String(i + 1) : undefined}
              onClick={() => void send({ option_index: o.index })}>
              <span className="kb-q__num" aria-hidden="true">{i + 1}</span>
              <span>
                <span className="kb-q__label">{o.label}{o.recommended && <span className="kb-q__rec">recommended</span>}</span>
                {o.description && <span className="kb-q__desc" id={`${baseId}-d${o.index}`}>{o.description}</span>}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {part.allow_other && (
        <form className="kb-q__other" onSubmit={submitOther}>
          <Icon name="pencil" size={14} />
          <input value={other} onChange={(e) => setOther(e.target.value)} aria-label="Other answer" placeholder="Other answer…"
            disabled={busy} maxLength={2000}
            onKeyDown={(e) => { if (e.key === 'Escape' && other) { e.preventDefault(); e.stopPropagation(); setOther(''); } }} />
        </form>
      )}
      {error && <p className="kb-inline-error kb-q__error" role="alert">{error}</p>}
    </m.section>
  );
}
