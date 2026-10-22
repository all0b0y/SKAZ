import { useEffect, useRef, useState } from 'react';
import { m } from 'motion/react';
import { Button, Icon, Spinner } from '../ui';
import { SPRING_SMALL } from '../ui/motion';
import { SourceMarks } from '../cite/SourceMarks';
import { useServices } from '../state/context';
import { agentName } from '../chat/permission';
import { formatScore, studyApi, type KbStudyPart, type KbStudyQuestion } from './api';
import type { StudyActions } from './useStudy';
import type { KbPermissionPart } from '../api/permissions';

export const QUESTION_LABEL: Record<KbStudyQuestion['type'], string> = {
  choice: 'Choose one', multi: 'Choose all that apply', short: 'Short answer', open: 'Open answer · checked by the agent',
};

const VERDICT: Record<string, string> = { right: 'Right.', partly: 'Partly right.', wrong: 'Not right.' };

/** The key badge of option `i`: A, B, C… (the same letter, or its number 1, 2, 3…, picks it). */
export const optionKey = (i: number): string => String.fromCharCode(65 + i);

/** Which option a key picks: A/B/C… or 1/2/3…; null for any other key. */
function optionIndex(key: string): number | null {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0) - 65;
  if (/^[1-9]$/.test(key)) return Number(key) - 1;
  return null;
}

/**
 * A test in the block (S4): one question at a time. Choice, multi and short answers are checked by
 * SKAZ against the source; an open answer goes to the agent, whose verdict is shown as its opinion,
 * not a fact. Wrong options are said to be made up by the agent once the answer is checked.
 * A/B/C… (or 1/2/3…) pick an option while the block has the focus and no text field does.
 */
export function TestRunner({ part, actions, onError, keys }: {
  part: KbStudyPart; actions: StudyActions; onError: (e: string | null) => void;
  /** The block's key handler slot: keys reach the focused block, not this inner element. */
  keys: { current: ((event: React.KeyboardEvent) => void) | null };
}) {
  const { client } = useServices();
  /** Picks option `i` of the question on screen (set by it; null when there is nothing to pick). */
  const pick = useRef<((index: number) => boolean) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** A question looked at again from the result (the attempt is finished; nothing is sent). */
  const [review, setReview] = useState<number | null>(null);
  useEffect(() => { if (!part.result) setReview(null); }, [part.result]);
  const total = part.questions.length;
  const index = review ?? Math.min(part.position, Math.max(0, total - 1));
  const question = part.questions[index] ?? null;
  const act = async (what: string, call: () => Promise<KbStudyPart>) => {
    if (busy) return false;
    setBusy(what);
    onError(null);
    const res = await actions.run(call);
    setBusy(null);
    if (!res.ok) onError(res.error);
    return res.ok;
  };
  const go = (position: number) => {
    const next = Math.max(0, Math.min(total - 1, position));
    if (review !== null) { setReview(next); return; }
    if (next === part.position) return;
    actions.optimistic({ ...part, position: next });
    void act('move', () => studyApi.move(client, part.id, { position: next }));
  };

  keys.current = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const i = optionIndex(event.key);
    if (i !== null && pick.current?.(i)) event.preventDefault();
  };

  if (part.result && review === null) {
    pick.current = null;
    return <TestResult part={part} busy={busy}
      onRetake={(mistakes) => void act(mistakes ? 'mistakes' : 'retake', () => studyApi.retake(client, part.id, mistakes))}
      onReview={setReview} />;
  }
  if (!question) return <div className="kb-st-stage"><p className="kb-st-empty">This test has no questions left.</p></div>;

  const answeredAll = part.questions.every((q) => q.response?.checked || (q.type === 'open' && q.response?.text));
  const last = index === total - 1;
  return (
    <div className="kb-st-stage">
      <m.div key={question.id} className="kb-st-face kb-st-face--flat" initial={{ opacity: 0, x: 24 }}
        animate={{ opacity: 1, x: 0, transition: SPRING_SMALL }}>
        <QuestionView key={question.id} part={part} question={question} busy={review !== null ? 'review' : busy} pick={pick}
          onAnswer={(body) => act('check', () => studyApi.answer(client, part.id, { item_id: question.id, ...body }))}
          onAskAgent={(text) => act('judge', () => studyApi.checkOpen(client, part.id, question.id, text))} />
      </m.div>
      <div className="kb-st-tact">
        <button type="button" className="kb-st-ib" aria-label="Previous question" disabled={index === 0 || !!busy} onClick={() => go(index - 1)}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <span className="kb-st-spacer" />
        {review !== null && <Button size="sm" variant="fill" onClick={() => setReview(null)}>Back to result</Button>}
        {review === null && (last || answeredAll) && (
          <Button size="sm" variant={last ? 'fill' : 'outline'} busy={busy === 'finish'} disabled={!!busy}
            onClick={() => void act('finish', () => studyApi.finish(client, part.id))}>See result</Button>
        )}
        <button type="button" className="kb-st-ib" aria-label="Next question" disabled={last || !!busy} onClick={() => go(index + 1)}>
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
    </div>
  );
}

interface AnswerBody { choices?: string[]; text?: string }

function QuestionView({ part, question, busy, pick, onAnswer, onAskAgent }: {
  part: KbStudyPart; question: KbStudyQuestion; busy: string | null;
  pick: { current: ((index: number) => boolean) | null };
  onAnswer: (body: AnswerBody) => Promise<boolean>; onAskAgent: (text: string) => Promise<boolean>;
}) {
  const response = question.response;
  const checked = !!response?.checked;
  const [picked, setPicked] = useState<string[]>(response?.choices ?? []);
  const [text, setText] = useState(response?.text ?? '');
  useEffect(() => { if (response?.choices) setPicked(response.choices); }, [response?.choices]);
  const choose = (id: string) => {
    if (checked) return;
    setPicked((now) => (question.type === 'multi' ? (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]) : [id]));
  };
  const agent = agentName((part.engine ?? 'codex') as KbPermissionPart['engine']);
  const multi = question.type === 'multi';
  const options = question.type === 'choice' || multi ? question.options : [];
  // The keyboard picks what a click would: nothing once checked or while a request runs.
  pick.current = (index) => {
    const option = options[index];
    if (!option || checked || busy) return false;
    choose(option.id);
    return true;
  };

  return (
    <>
      <p className="kb-st-tq" id={`q-${question.id}`}>{question.question}</p>
      {(question.type === 'choice' || multi) && (
        <div className="kb-st-opts" role={multi ? 'group' : 'radiogroup'} aria-labelledby={`q-${question.id}`}>
          {question.options.map((o, i) => {
            const sel = picked.includes(o.id);
            const right = o.origin === 'source';
            const state = !checked ? (sel ? 'sel' : '') : right ? 'ok' : sel ? 'bad' : '';
            return (
              <button key={o.id} type="button" className={`kb-st-opt${state ? ` is-${state}` : ''}${sel ? ' is-picked' : ''}`}
                role={multi ? 'checkbox' : 'radio'} aria-checked={sel} aria-keyshortcuts={`${optionKey(i)} ${i + 1}`}
                disabled={checked || !!busy} onClick={() => choose(o.id)}>
                <span className="kb-st-key" aria-hidden="true">{optionKey(i)}</span>
                <span className="kb-st-opt__text">{o.text}</span>
                {checked && (
                  <span className="kb-st-tag">
                    {right ? <><Icon name="allowed" size={13} />{sel || !multi ? 'Correct · from source' : 'Missed · from source'}</>
                      : sel ? <><Icon name="denied" size={13} />Your answer · made up by {agent}</> : `made up by ${agent}`}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {question.type === 'short' && (
        <input className="kb-st-in" value={text} placeholder="Your answer" aria-label="Your answer" maxLength={500}
          disabled={checked || !!busy} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { e.preventDefault(); void onAnswer({ text }); } }} />
      )}
      {question.type === 'open' && (
        <textarea className="kb-st-in kb-st-ta" value={text} placeholder="Answer in your own words" aria-label="Your answer" maxLength={5000}
          disabled={!!response?.checking || !!busy} onChange={(e) => setText(e.target.value)} />
      )}

      {checked && question.type !== 'open' && (
        <div className={`kb-st-res ${response!.score === 1 ? 'is-ok' : 'is-bad'}`} role="status">
          <Icon name={response!.score === 1 ? 'allowed' : 'denied'} size={16} />
          <div>
            <span className="kb-st-rt">{response!.score === 1 ? 'Correct.' : 'Not quite.'}</span>{' '}
            {question.type === 'short' ? <>The source says: «{question.answers[0]}»</> : <>From the source</>}
            <SourceMarks citations={question.citations} />
          </div>
        </div>
      )}
      {question.type === 'open' && response?.checking && (
        <div className="kb-st-op kb-st-op--wait"><Spinner size="sm" label={`${agent} is checking your answer…`} /></div>
      )}
      {question.type === 'open' && response?.error && <p className="kb-inline-error" role="alert">{response.error}</p>}
      {question.type === 'open' && checked && response?.verdict && (
        <div className="kb-st-op" role="status">
          <div className="kb-st-opl"><Icon name="agent" size={13} />{agent}’s opinion · not a fact</div>
          <b>{VERDICT[response.verdict] ?? response.verdict}</b>
          {response.missing && <> Missing: {response.missing}</>}
          {response.comment && <> {response.comment}</>}
          <span className="kb-st-opsrc"> Source: «{question.answers[0]}»<SourceMarks citations={question.citations} /></span>
        </div>
      )}
      {(checked || response?.verdict) && question.explanation && (
        <p className="kb-st-ex"><Icon name="analysis" size={14} /><span><b>Agent explanation</b> · {question.explanation}</span></p>
      )}

      <div className="kb-st-check">
        {question.type === 'open' ? (
          <Button size="sm" variant="fill" busy={busy === 'judge' || !!response?.checking}
            disabled={!text.trim() || !!busy || !!response?.checking}
            onClick={() => void onAskAgent(text)}>{response?.verdict || response?.error ? 'Ask the agent again' : 'Ask the agent to check'}</Button>
        ) : !checked && (
          <Button size="sm" variant="fill" busy={busy === 'check'}
            disabled={!!busy || (question.type === 'short' ? !text.trim() : picked.length === 0)}
            onClick={() => void onAnswer(question.type === 'short' ? { text } : { choices: picked })}>Check</Button>
        )}
      </div>
    </>
  );
}

function TestResult({ part, busy, onRetake, onReview }: {
  part: KbStudyPart; busy: string | null; onRetake: (mistakesOnly: boolean) => void; onReview: (index: number) => void;
}) {
  const result = part.result!;
  const byId = new Map(part.questions.map((q, i) => [q.id, { q, i }]));
  return (
    <div className="kb-st-stage">
      <p className="kb-st-big">{formatScore(result.correct)} of {result.total}</p>
      {result.partly > 0 && (
        <p className="kb-st-note kb-st-note--flat">
          {result.partly === 1 ? 'One open answer is' : `${result.partly} open answers are`} half-right in the agent’s opinion.
        </p>
      )}
      <ul className="kb-st-sum" aria-label="Answers">
        {result.rows.map((row) => {
          const hit = byId.get(row.id);
          const icon = row.score === 1 ? 'allowed' : row.score === 0.5 ? 'concept' : 'denied';
          const said = row.score === 1 ? 'right' : row.score === 0.5 ? 'partly right' : row.score === null ? 'not answered' : 'wrong';
          return (
            <li key={row.id} className={`kb-st-sr kb-st-sr--${row.score === 1 ? 'ok' : row.score === 0.5 ? 'part' : 'bad'}`}>
              <Icon name={icon} size={15} label={said} />
              <span>{hit?.q.question ?? 'Question removed'}</span>
              {hit && <Button size="sm" onClick={() => onReview(hit.i)}>Review</Button>}
            </li>
          );
        })}
      </ul>
      <div className="kb-st-tact">
        <Button size="sm" icon="retry" busy={busy === 'retake'} disabled={!!busy} onClick={() => onRetake(false)}>Retake</Button>
        {result.mistakes > 0 && (
          <Button size="sm" variant="fill" busy={busy === 'mistakes'} disabled={!!busy} onClick={() => onRetake(true)}>
            Retake mistakes · {result.mistakes}
          </Button>
        )}
      </div>
    </div>
  );
}
