import { useCallback, useEffect, useRef, useState } from 'react';
import type { KbFreshnessMark, KbFreshnessMarks, KbLinkCheck, KbLinkObservation } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Button, Icon } from '../ui';
import { useUi } from '../state/context';
import { useMarksClients } from './marksClients';
import './marks.css';

/**
 * N1 on a material (v4 states 20–23): when a source has a newer version, was retracted, is contradicted by
 * a newer source or its original link is gone, one quiet block says so — with the reason, where the fact
 * comes from, and only the actions that make sense. A timeout or a refusal is a check result, never a mark.
 * "Check links" is manual (decision 3f): SKAZ never visits a source site by itself.
 */

const POLL_MS = 1000;

function checkedLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return 'checked today';
  if (diff === 1) return 'checked yesterday';
  return `checked ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

const COULD_NOT: Record<NonNullable<KbLinkObservation['reason']>, string> = {
  http_403: 'The site refused the check.',
  http_429: 'The site asked for fewer requests.',
  timeout: 'The site did not respond.',
  http_404: 'The check did not finish.',
  http_410: 'The check did not finish.',
  no_domain: 'The check did not finish.',
  other: 'The check did not finish.',
};

function openOutside(url: string) {
  window.open(url, '_blank', 'noopener');
}

function Statements({ mark }: { mark: KbFreshnessMark }) {
  const open = useUi((s) => s.openDocument);
  if (mark.affected_statements.length === 0) return null;
  return (
    <section className="kb-fresh__claims" aria-label="Claims using this source">
      <h3 className="kb-fresh__claims-head">Claims using this source</h3>
      <ul>
        {mark.affected_statements.map((s) => (
          <li key={`${s.page_id}:${s.block_id ?? ''}`}>
            <span className="kb-fresh__claim-note">
              {s.sole_source
                ? `${mark.kind === 'retracted' ? 'Retracted source · ' : ''}only supporting source`
                : `Also supported by ${s.also_supported_by.map((m) => m.title).join(', ') || 'other sources'}`}
            </span>
            <button type="button" className="kb-rep__link" onClick={() => open({ type: 'page', id: s.page_id, block_id: s.block_id })}>{s.title}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MarkBlock({ mark, onDelete, onChanged }: {
  mark: KbFreshnessMark;
  onDelete: () => void;
  onChanged: (mark: KbFreshnessMark, ingestJobId: string | null) => void;
}) {
  const { maintenance } = useMarksClients();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: 'replace_version' | 'keep_marked') => {
    setBusy(action);
    setError(null);
    try {
      const res = await maintenance.act(mark.id, { action });
      onChanged(res.mark, res.ingest_job_id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const keepLabel = mark.kind === 'link_gone' ? 'Keep' : 'Keep, marked';
  const evidence = [mark.evidence_label, checkedLabel(mark.checked_at)].filter(Boolean).join(' · ');
  return (
    <div className="kb-fresh" data-mark-kind={mark.kind}>
      <div className="kb-fresh__block">
        <p className="kb-fresh__reason">{mark.reason}</p>
        {mark.kind === 'link_gone'
          ? <p className="kb-fresh__evidence">Not found on two checks, one day apart.</p>
          : evidence && <p className="kb-fresh__evidence">{evidence}</p>}
        {mark.kept_marked ? (
          <p className="kb-fresh__evidence">Kept · the warning stays on this source.</p>
        ) : (
          <div className="kb-fresh__actions">
            {mark.actions.includes('replace_version') && (
              <Button size="sm" variant="outline" busy={busy === 'replace_version'} onClick={() => void act('replace_version')}>
                {mark.version ? `Replace with ${mark.version}` : 'Replace with the new version'}
              </Button>
            )}
            {mark.actions.includes('delete_source') && (
              <Button size="sm" variant="outline" onClick={onDelete}>Delete source…</Button>
            )}
            {mark.actions.includes('keep_marked') && (
              <Button size="sm" variant="outline" busy={busy === 'keep_marked'} onClick={() => void act('keep_marked')}>{keepLabel}</Button>
            )}
            {mark.evidence_url && (
              <a className="kb-rep__link kb-fresh__out" href={mark.evidence_url} rel="noreferrer noopener"
                onClick={(e) => { e.preventDefault(); openOutside(mark.evidence_url!); }}>
                Open on publisher site<Icon name="external" size={12} />
              </a>
            )}
          </div>
        )}
        {error && <p className="kb-inline-error" role="alert">{error}</p>}
      </div>
      <Statements mark={mark} />
    </div>
  );
}

type Run = { phase: 'idle' } | { phase: 'running'; id: string } | { phase: 'stopped' } | { phase: 'failed'; message: string };

/** The marks of one material, the last link check, and the manual "Check links". */
export function FreshnessNotice({ materialId, originUrl, onDelete, onReplaced }: {
  materialId: string;
  /** Only a material with an original link can be link-checked. */
  originUrl: string | null;
  onDelete: () => void;
  /** A "Replace with vN" started a re-ingest: the material view reads the material again. */
  onReplaced: () => void;
}) {
  const { maintenance, freshness } = useMarksClients();
  const [data, setData] = useState<KbFreshnessMarks | null>(null);
  // Nothing is drawn until the marks were asked for once, so a button never jumps when the answer arrives.
  const [asked, setAsked] = useState(false);
  const [run, setRun] = useState<Run>({ phase: 'idle' });
  const [note, setNote] = useState<string | null>(null);
  const [observation, setObservation] = useState<KbLinkObservation | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const load = useCallback(() => {
    // Marks are an extra: when they cannot be read the material simply shows none.
    maintenance.marks(materialId).then((d) => { if (live.current) { setData(d); setAsked(true); } }, () => { if (live.current) setAsked(true); });
  }, [maintenance, materialId]);
  useEffect(() => { setData(null); setAsked(false); setRun({ phase: 'idle' }); setNote(null); setObservation(null); load(); }, [load]);

  const settle = useCallback((check: KbLinkCheck) => {
    const mine = check.observations.find((o) => o.material_id === materialId) ?? null;
    if (check.state === 'done') { setObservation(mine); setRun({ phase: 'idle' }); load(); }
    else if (check.state === 'paused' || check.state === 'cancelled') setRun({ phase: 'stopped' });
    else if (check.state === 'error') setRun({ phase: 'failed', message: 'The link check could not finish.' });
  }, [load, materialId]);

  const runId = run.phase === 'running' ? run.id : null;
  useEffect(() => {
    if (!runId) return undefined;
    const timer = setInterval(() => {
      freshness.link_check(runId).then((check) => { if (live.current) settle(check); }, (e: unknown) => {
        if (live.current) setRun({ phase: 'failed', message: errorText(e) });
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [freshness, runId, settle]);

  const checkLinks = async () => {
    setNote(null);
    setObservation(null);
    try {
      const check = await freshness.check_links({ material_ids: [materialId] });
      if (!live.current) return;
      if (check.state === 'running' || check.state === 'queued') setRun({ phase: 'running', id: check.id });
      else settle(check);
    } catch (e) {
      if (live.current) setRun({ phase: 'failed', message: errorText(e) });
    }
  };

  const changed = (mark: KbFreshnessMark, ingestJobId: string | null) => {
    setData((d) => (d ? { ...d, marks: d.marks.map((m) => (m.id === mark.id ? mark : m)) } : d));
    if (ingestJobId) { setNote(`Replacing with ${mark.version ?? 'the new version'} — the wiki follows when it is done.`); onReplaced(); }
  };

  const marks = data?.marks ?? [];
  const last = observation ?? data?.last_link_check ?? null;
  const goneMark = marks.some((m) => m.kind === 'link_gone');
  const couldNot = !goneMark && last?.outcome === 'could_not_check';
  const checking = run.phase === 'running';

  const checkButton = (
    <Button size="sm" variant="outline" busy={checking} disabled={checking} onClick={() => void checkLinks()}>Check links</Button>
  );
  if (!asked || (marks.length === 0 && !originUrl && !couldNot)) return null;

  return (
    <div className="kb-freshwrap" data-testid="freshness">
      {originUrl && !couldNot && (
        <div className="kb-freshwrap__bar">
          {checking && <span className="kb-fresh__evidence" role="status">Checking the link…</span>}
          <button type="button" className="kb-rep__link" disabled={checking} onClick={() => void checkLinks()}>Check links</button>
        </div>
      )}
      {marks.map((m) => <MarkBlock key={m.id} mark={m} onDelete={onDelete} onChanged={changed} />)}
      {couldNot && last && (
        <div className="kb-fresh" data-mark-kind="could_not_check">
          <div className="kb-fresh__block">
            <p className="kb-fresh__reason">Link check: couldn’t check</p>
            <p className="kb-fresh__evidence">{COULD_NOT[last.reason ?? 'other']} Your source has not been marked as outdated.</p>
            <div className="kb-fresh__actions">{checkButton}</div>
            {checking && <p className="kb-fresh__evidence" role="status">Checking the link…</p>}
          </div>
        </div>
      )}
      {!couldNot && !goneMark && observation?.outcome === 'ok' && (
        <p className="kb-fresh__evidence" role="status">The original link works · {checkedLabel(observation.checked_at)}.</p>
      )}
      {!couldNot && !goneMark && observation?.outcome === 'suspected_gone' && (
        <p className="kb-fresh__evidence" role="status">The original link did not answer. It will be checked again before anything is marked.</p>
      )}
      {run.phase === 'stopped' && <p className="kb-fresh__evidence" role="status">The link check stopped. Check links again to retry.</p>}
      {run.phase === 'failed' && <p className="kb-inline-error" role="alert">{run.message}</p>}
      {note && <p className="kb-fresh__evidence" role="status">{note}</p>}
    </div>
  );
}
