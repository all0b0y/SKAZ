import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { ApiClient } from '../../api/client';
import type { Citation, ProactiveCard, ProactiveView } from '../../api/types';
import { webSearch, type SearchApproval } from '../../api/webSearch';
import { formatTimecode } from '../../lib/time';
import { useStore } from '../../state/store';
import { AnswerMarkdown } from '../assistant/AnswerMarkdown';
import { useProactiveCards } from './useProactiveCards';
import './proactive.css';

const QUOTE_PREVIEW = 140;

function speaker(citation: Citation): string {
  return citation.speaker == null ? 'Speaker not identified' : `Speaker ${citation.speaker}`;
}

function SourceLink({ citation, onCite, label }: {
  citation: Citation; onCite: (citation: Citation) => void; label?: string;
}) {
  const quote = citation.text.length > QUOTE_PREVIEW
    ? `${citation.text.slice(0, QUOTE_PREVIEW).trimEnd()}…` : citation.text;
  return (
    <button type="button" className="proactive__source" onClick={() => onCite(citation)}
      title={`Open in the transcript at ${formatTimecode(citation.start_ms)}`}>
      <span className="proactive__time tabular">{formatTimecode(citation.start_ms)}</span>
      <span className="proactive__speaker">{speaker(citation)}</span>
      <span className="proactive__quote">{label ?? quote}</span>
    </button>
  );
}

function statusLine(card: ProactiveCard): string | null {
  switch (card.status) {
    case 'listening': return card.finished ? 'Question heard.' : 'Listening to the rest of the question…';
    case 'answering': return 'Preparing context and a draft answer from what was said…';
    default: return null;
  }
}

/** Inline approval of the exact query, the same one-use consent the assistant uses. */
function WebApproval({ card }: { card: ProactiveCard }) {
  const [pending, setPending] = useState<SearchApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const chatId = `proactive-${card.id}`;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await webSearch.pending();
        if (alive) setPending(result.requests.find((request) => request.chat_id === chatId) ?? null);
      } catch {
        if (alive) setError('Search approval is unavailable. Nothing was sent.');
      }
      if (alive) timer = setTimeout(() => void poll(), 750);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [chatId]);
  const decide = async (approved: boolean) => {
    if (!pending || busy) return;
    setBusy(true); setError('');
    try { await webSearch.decide(pending, approved); setPending(null); }
    catch { setError('The approval was not accepted or expired. Nothing was sent.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="proactive__web-approval" role="group" aria-label="Approve web lookup">
      <p>Only this query will be sent to Brave Search. Search API charges may apply.</p>
      <pre>{card.web?.query}</pre>
      <div className="proactive__actions">
        <button className="btn btn--ghost" type="button" disabled={busy || !pending} onClick={() => void decide(false)}>
          Don’t search
        </button>
        <button className="btn" type="button" disabled={busy || !pending} onClick={() => void decide(true)}>
          Allow this request
        </button>
      </div>
      {error && <p role="alert" className="proactive__error">{error}</p>}
    </div>
  );
}

function WebLookup({ card, onView }: { card: ProactiveCard; onView: (view: ProactiveView) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(card.public_query);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const web = card.web;
  if (web?.status === 'awaiting_approval') return <WebApproval card={card} />;
  const prepare = async () => {
    setBusy(true); setError('');
    try {
      onView(await new ApiClient(window.skaz).proactiveWebLookup(card.session_id, card.id, query.trim()));
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The lookup could not be prepared.');
    } finally { setBusy(false); }
  };
  return (
    <div className="proactive__web">
      {web?.status === 'completed' && (
        <section aria-label="Web results" className="proactive__addition">
          <h4>From the web — assistant’s addition, not said in the session</h4>
          <p className="proactive__hint">Searched for: {web.query}</p>
          {web.results.length === 0 ? <p>No results.</p> : (
            <ul>
              {web.results.map((result) => (
                <li key={result.url}>
                  <a href={result.url} target="_blank" rel="noreferrer noopener">{result.title || result.url}</a>
                  {result.description && <span> — {result.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {web?.status === 'declined' && <p className="proactive__hint">The web lookup was not allowed. Nothing was sent.</p>}
      {web?.status === 'failed' && <p className="proactive__hint">Web lookup failed: {web.error ?? 'nothing was found'}.</p>}
      {!open ? (
        <button type="button" className="btn btn--ghost proactive__web-open" onClick={() => setOpen(true)}>
          {web ? 'Look up again…' : 'Look up on the web…'}
        </button>
      ) : (
        <div className="proactive__web-form">
          <label className="field">
            <span>Public part of the question</span>
            <input value={query} maxLength={400} disabled={busy} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <p className="proactive__hint">
            Only this text is sent, after you approve it. Remove names, company and project details.
          </p>
          <div className="proactive__actions">
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="btn" disabled={busy || !query.trim()} onClick={() => void prepare()}>
              Continue
            </button>
          </div>
          {error && <p role="alert" className="proactive__error">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function ProactiveCardView({ card, activeSessionId, onCite, onDismiss, onView }: {
  card: ProactiveCard;
  activeSessionId: string | null;
  onCite: (citation: Citation) => void;
  onDismiss: () => void;
  onView: (view: ProactiveView) => void;
}) {
  const line = statusLine(card);
  const settled = card.status !== 'listening' && card.status !== 'answering';
  const hasContext = card.context.trim().length > 0;
  return (
    <article className={clsx('proactive__card', `proactive__card--${card.status}`)}
      aria-label={card.addressed === 'direct' ? 'You’re being asked' : 'Possibly addressed to you'}>
      <header className="proactive__head">
        <strong>{card.addressed === 'direct' ? 'You’re being asked…' : 'Possibly addressed to you'}</strong>
        <button type="button" className="proactive__dismiss" aria-label="Hide this card" onClick={onDismiss}>×</button>
      </header>
      {card.addressed === 'possible' && (
        <p className="proactive__hint">The recognised speech does not make it certain this was said to you.</p>
      )}
      <blockquote className="proactive__question">
        <SourceLink citation={card.question_citation} onCite={onCite} label={`“${card.question}”`} />
      </blockquote>
      {line && <p className="proactive__status" role="status">{line}</p>}

      <section aria-label="Context">
        <h4>Context</h4>
        {hasContext
          ? <AnswerMarkdown content={card.context} citations={card.citations} activeSessionId={activeSessionId} onCite={onCite} />
          : null}
        {(!hasContext || !settled) && card.context_citations.length > 0 && (
          <div className="proactive__sources">
            {card.context_citations.map((citation) => (
              <SourceLink key={`${citation.segment_id}-${citation.start_ms}`} citation={citation} onCite={onCite} />
            ))}
          </div>
        )}
        {!hasContext && card.context_citations.length === 0 && (
          <p className="proactive__hint">Nothing was said before the question.</p>
        )}
      </section>

      {card.answer && (
        <section aria-label="Draft answer">
          <h4>Draft answer — from what was said</h4>
          <AnswerMarkdown content={card.answer} citations={card.citations} activeSessionId={activeSessionId} onCite={onCite} />
        </section>
      )}
      {settled && !card.answer && (
        <p className="proactive__missing">{card.missing || 'There is no answer in the recording so far.'}</p>
      )}
      {card.answer && card.missing && (
        <p className="proactive__missing"><strong>Not in the recording:</strong> {card.missing}</p>
      )}
      {card.outside_recording && (
        <section aria-label="Assistant’s addition" className="proactive__addition">
          <h4>Assistant’s addition — not said in the session</h4>
          <p>{card.outside_recording}</p>
        </section>
      )}
      {card.notice && <p className="proactive__notice">{card.notice}</p>}
      {settled && card.status !== 'stopped' && <WebLookup card={card} onView={onView} />}
    </article>
  );
}

/**
 * The proactive assistant for the open session: a card when someone directly
 * asks the user something. Shown only when enabled in settings and only for a
 * live recording; imported audio never triggers it.
 */
export function ProactiveCards({ onCite }: { onCite: (citation: Citation) => void }) {
  const activeId = useStore((s) => s.activeSessionId);
  const enabled = useStore((s) => s.settings?.proactive?.enabled === true);
  const capturing = useStore((s) => ['recording', 'paused', 'processing'].includes(s.recorderState));
  const { view, error, accept } = useProactiveCards(activeId, enabled, capturing);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  useEffect(() => { setHidden(new Set()); }, [activeId]);

  if (!enabled || !activeId || !view || !view.live) return null;
  const cards = view.cards.filter((card) => !hidden.has(card.id));
  if (!cards.length && !capturing && view.session_enabled && !error) return null;

  const toggle = async () => {
    setSwitching(true); setSwitchError(null);
    try { accept(await new ApiClient(window.skaz).setProactiveSession(activeId, !view.session_enabled)); }
    catch { setSwitchError('Could not change the proactive assistant for this session.'); }
    finally { setSwitching(false); }
  };

  return (
    <section className="proactive" aria-label="Proactive assistant" aria-live="polite">
      <div className="proactive__bar">
        <span className="proactive__title">
          {view.session_enabled ? 'Proactive assistant is listening for questions to you' : 'Proactive assistant is off for this session'}
        </span>
        <button type="button" className="btn btn--ghost" disabled={switching} onClick={() => void toggle()}>
          {view.session_enabled ? 'Turn off for this session' : 'Turn on for this session'}
        </button>
      </div>
      {(error || switchError) && <p role="alert" className="proactive__error">{switchError ?? error}</p>}
      {cards.map((card) => (
        <ProactiveCardView key={card.id} card={card} activeSessionId={activeId} onCite={onCite} onView={accept}
          onDismiss={() => setHidden((current) => new Set(current).add(card.id))} />
      ))}
    </section>
  );
}
