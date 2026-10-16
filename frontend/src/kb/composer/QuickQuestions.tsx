import { Fragment, useId } from 'react';
import { Tooltip } from '../ui/Tooltip';

/**
 * Quick questions over the message field while a recording runs (v39 rec/limit). Two go to the chat
 * at once with the recording attached; "Explain a term" starts the question in the field instead.
 */
export const QUICK_QUESTIONS = [
  { id: 'missed', label: 'What did I miss?', ask: 'What did I miss?' },
  { id: 'term', label: 'Explain a term', prefill: 'Explain the term: ' },
  { id: 'summary', label: 'Summary so far', ask: 'Summarise the recording so far.' },
] as const;

export type QuickQuestion = (typeof QUICK_QUESTIONS)[number];

export function QuickQuestions({ disabledReason, onAsk, onPrefill }: {
  /** Why the agent can't take a question now (shown in each chip's tooltip); null = enabled. */
  disabledReason: string | null;
  onAsk: (question: string) => void;
  onPrefill: (text: string) => void;
}) {
  const reasonId = useId();
  const disabled = disabledReason !== null;
  return (
    <div className="kb-quick" role="group" aria-label="Quick questions about the recording" data-testid="quick-questions">
      {QUICK_QUESTIONS.map((q) => {
        const chip = (
          <button type="button" className="kb-quick__chip" aria-disabled={disabled || undefined}
            aria-describedby={disabled ? reasonId : undefined}
            onClick={() => {
              if (disabled) return;
              if ('ask' in q) onAsk(q.ask);
              else onPrefill(q.prefill);
            }}>
            {q.label}
          </button>
        );
        return disabled
          ? <Tooltip key={q.id} text={disabledReason} placement="top">{chip}</Tooltip>
          : <Fragment key={q.id}>{chip}</Fragment>;
      })}
      {disabled && <span id={reasonId} className="kb-visually-hidden">{disabledReason}</span>}
    </div>
  );
}
