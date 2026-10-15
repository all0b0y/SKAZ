import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type { KbCitation, KbCorrection, KbNotification, KbNotificationAction } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Button, Chip, Icon, IconButton, Modal, Spinner } from '../ui';
import { CiteChip, useFolderTone } from '../chat/parts';
import { useNotifications, useServices, useUi } from '../state/context';
import { subjectRef } from '../state/document';
import { pendingDecisions } from '../state/notifications';
import {
  DECISION_SCREENS, kindOf, LOCAL_ACTIONS, type KbDiscrepancyPayload, type KbDoubtfulPayload, type KbLinkFailedPayload,
} from './kinds';

/** Actions after which the notification's material no longer exists (speech/link_failures.py). */
const GONE_AFTER = new Set(['delete_material', 'fix_url']);

interface ExcludedItem { seg: number; found: string; location_label?: string; reason?: string }

/**
 * Decision window (decision 18): modal, opened only by a click; ‹ › walks the decisions waiting,
 * "1 of N"; "Ask the agent about this" hands it to a new chat. Screens: discrepancy, doubtful
 * corrections, link failure, excluded instruction; other kinds show their text and actions.
 */
export function DecisionModal() {
  const { notifications, ui, chats, composer, library } = useServices();
  const decisionId = useUi((s) => s.decisionId);
  const items = useNotifications((s) => s.items);
  const [error, setError] = useState<string | null>(null);
  const [textFor, setTextFor] = useState<KbNotificationAction | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const textId = useId();

  const current = items.find((n) => n.id === decisionId) ?? null;
  const queue = useMemo(() => {
    const pending = pendingDecisions(items);
    return current && !pending.some((n) => n.id === current.id) ? [current, ...pending] : pending;
  }, [items, current]);
  const index = current ? queue.findIndex((n) => n.id === current.id) : -1;

  useEffect(() => { setError(null); setTextFor(null); setText(''); }, [decisionId]);

  const close = () => ui.getState().openDecision(null);
  const go = (delta: number) => {
    if (queue.length < 2) return;
    const next = queue[(index + delta + queue.length) % queue.length];
    if (next) ui.getState().openDecision(next.id);
  };
  const openSubject = (n: KbNotification) => {
    const ref = n.subject ? subjectRef(n.subject) : null;
    if (ref) ui.getState().openDocument(ref);
    close();
  };

  const run = async (action: KbNotificationAction) => {
    if (!current) return;
    if (LOCAL_ACTIONS.has(action.id)) { openSubject(current); return; }
    if (action.needs_text && textFor?.id !== action.id) {
      setTextFor(action);
      setText(action.id === 'fix_url' ? String((current.payload as Partial<KbLinkFailedPayload>).url ?? '') : '');
      return;
    }
    if (action.needs_text && !text.trim()) { setError('Enter the text first.'); return; }
    setBusy(action.id);
    setError(null);
    const res = await notifications.getState().resolve(current.id, action.id, action.needs_text ? text.trim() : null);
    setBusy(null);
    if (!res.ok) { setError(res.error); return; }
    // "Delete" and "Fix address" remove the failed material (a fixed address imports a new one).
    const subject = (current.payload as { material_id?: unknown }).material_id;
    if (typeof subject === 'string' && GONE_AFTER.has(action.id)) void library.getState().forgetMaterial(subject);
    else if (current.subject?.type === 'material') void library.getState().loadContent();
    const rest = pendingDecisions(notifications.getState().items).filter((n) => n.id !== current.id);
    const next = rest[Math.min(Math.max(0, index), rest.length - 1)];
    ui.getState().openDecision(next ? next.id : null);
  };

  const askAgent = () => {
    if (!current) return;
    const s = current.subject;
    const title = s?.type === 'page' ? String((current.payload as Partial<KbDiscrepancyPayload>).page_title ?? current.title)
      : String((current.payload as { material_title?: string }).material_title ?? current.title);
    chats.getState().open(null);
    ui.getState().showCenter('chat');
    composer.getState().push([
      ...(s && s.type !== 'chat' ? [{ kind: 'mention' as const, ref: { type: s.type, id: s.id, title } }] : []),
      { kind: 'text', text: `${current.title}. ${current.body} — what do you make of it?` },
    ], { focus: true });
    close();
  };

  const k = current ? kindOf(current) : null;
  const actions = current ? [...current.actions].sort((a, b) => Number(a.primary) - Number(b.primary)) : [];

  return (
    <Modal open={!!current} onClose={close} title={current?.title ?? 'Decision'} bare className="kb-decision" testId="decision" pane="decision">
      {current && k && (
        <>
          <header className="kb-decision__head">
            <span className={`kb-note__icon kb-tone--${k.tone}`} aria-hidden="true"><Icon name={k.icon} size={14} /></span>
            <h2 className="kb-decision__title">{current.title}</h2>
            {queue.length > 1 && index >= 0 && <span className="kb-decision__pos" aria-live="polite">{index + 1} of {queue.length}</span>}
            {queue.length > 1 && <IconButton icon="chevronLeft" label="Previous decision" onClick={() => go(-1)} />}
            {queue.length > 1 && <IconButton icon="chevronRight" label="Next decision" onClick={() => go(1)} />}
            <IconButton icon="close" label="Close" onClick={close} />
          </header>
          <div className="kb-decision__body">
            {current.resolved_at && (
              <p className="kb-decision__done" role="status"><Icon name="check" size={14} />Decided: {current.actions.find((a) => a.id === current.resolution)?.label ?? current.resolution}</p>
            )}
            {current.kind === 'discrepancy' && <Discrepancy payload={current.payload as unknown as KbDiscrepancyPayload} />}
            {current.kind === 'doubtful_corrections' && <Doubtful payload={current.payload as unknown as KbDoubtfulPayload} />}
            {current.kind === 'link_failed' && <LinkFailed payload={current.payload as unknown as KbLinkFailedPayload} />}
            {current.kind === 'excluded_instruction' && <Excluded notification={current} />}
            {!DECISION_SCREENS.has(current.kind) && <p className="kb-muted">{current.body}</p>}
            {textFor && (
              <div className="kb-decision__text">
                <label htmlFor={textId} className="kb-field__label">{textFor.id === 'fix_url' ? 'Correct address' : textFor.label}</label>
                {textFor.id === 'fix_url' ? (
                  <input id={textId} className="kb-attachform__input" type="url" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
                ) : (
                  <textarea id={textId} className="kb-attachform__input kb-attachform__area" rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
                )}
              </div>
            )}
            {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
            <button type="button" className="kb-decision__ask" onClick={askAgent}><Icon name="askAgent" size={14} />Ask the agent about this</button>
          </div>
          {!current.resolved_at && actions.length > 0 && (
            <footer className="kb-decision__foot">
              {actions.map((a) => (
                <Button key={a.id} size="sm" variant={a.primary || textFor?.id === a.id ? 'fill' : a.id.startsWith('delete') ? 'danger' : 'outline'}
                  icon={a.primary ? 'check' : undefined} busy={busy === a.id} onClick={() => void run(a)}>
                  {textFor?.id === a.id ? (a.id === 'fix_url' ? 'Use this address' : 'Save note') : a.label}
                </Button>
              ))}
            </footer>
          )}
        </>
      )}
    </Modal>
  );
}

function Quote({ side, citation, folder, title }: { side: string; citation: KbCitation | null; folder: string; title: string }) {
  const tone = useFolderTone();
  return (
    <figure className="kb-quotecard">
      <figcaption className="kb-quotecard__head">
        <i className={`kb-fdot kb-fdot--${tone(folder)}`} aria-hidden="true" />
        <span>{title}</span>
        {citation && <CiteChip citation={citation} />}
      </figcaption>
      <blockquote className="kb-quotecard__text">“{side}”</blockquote>
    </figure>
  );
}

function Discrepancy({ payload }: { payload: KbDiscrepancyPayload }) {
  const sides = payload.sides ?? [];
  return (
    <>
      <p className="kb-muted">The sources define “{payload.page_title}” differently. The agent doesn’t choose on its own.</p>
      {sides.map((s, i) => <Quote key={s.block_id ?? i} side={s.text} citation={s.citation} folder={s.folder_name} title={s.material_title} />)}
      {payload.explanation && (
        <p className="kb-decision__expl"><Icon name="models" size={14} /><span><b>Agent explanation:</b> {payload.explanation}</span></p>
      )}
    </>
  );
}

function Doubtful({ payload }: { payload: KbDoubtfulPayload }) {
  const { client, ui } = useServices();
  const [list, setList] = useState<KbCorrection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.call('GET /kb/materials/{material_id}/corrections', { path: { material_id: payload.material_id } }).then(
      (all) => { if (live) setList(all.filter((c) => payload.correction_ids.includes(c.id))); },
      (e: unknown) => { if (live) setError(errorText(e)); },
    );
    return () => { live = false; };
  }, [client, payload.material_id, payload.correction_ids]);
  const decide = async (c: KbCorrection, how: 'accept' | 'keep') => {
    setBusy(c.id);
    try {
      const res = await client.call(how === 'accept' ? 'POST /kb/corrections/{correction_id}/accept' : 'POST /kb/corrections/{correction_id}/keep',
        { path: { correction_id: c.id } });
      setList((l) => l?.map((x) => (x.id === c.id ? res.correction : x)) ?? null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <p className="kb-muted">“{payload.material_title}”: the model isn’t sure about {payload.correction_ids.length === 1 ? 'one correction' : `${payload.correction_ids.length} corrections`}.</p>
      {list === null && !error && <Spinner label="Loading corrections" size="sm" />}
      {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
      {list?.map((c) => (
        <div key={c.id} className="kb-fix">
          <div className="kb-fix__head">
            <Chip kind="recording" label={`Fragment ${c.seg}`} onClick={() => { ui.getState().openDocument({ type: 'material', id: c.material_id, seg: c.seg }); ui.getState().openDecision(null); }} />
            <span className="kb-head__spacer" />
            {c.confidence !== null && <span className="kb-fix__conf">confidence {Math.round(c.confidence * 100)}%</span>}
          </div>
          <p className="kb-fix__diff">
            <del aria-label={`was: ${c.before}`}>{c.before}</del> <Icon name="chevronRight" size={12} /> <ins aria-label={`becomes: ${c.after}`}>{c.after}</ins>
          </p>
          {c.state === 'doubtful' ? (
            <div className="kb-fix__acts">
              <Button size="sm" icon="check" busy={busy === c.id} onClick={() => void decide(c, 'accept')}>Accept</Button>
              <Button size="sm" variant="quiet" disabled={busy === c.id} onClick={() => void decide(c, 'keep')}>Keep as it was</Button>
            </div>
          ) : (
            <p className="kb-fix__state"><Icon name="check" size={12} />{c.state === 'applied' ? 'Accepted' : c.state === 'kept' ? 'Kept as it was' : c.state}</p>
          )}
        </div>
      ))}
    </>
  );
}

function LinkFailed({ payload }: { payload: KbLinkFailedPayload }) {
  return (
    <>
      <p className="kb-muted">{payload.reason}</p>
      <p className="kb-urlbox"><Icon name="link" size={14} /><span className="kb-urlbox__text">{payload.url}</span></p>
      <p className="kb-muted">The material is saved without text. You can retry, fix the address or delete it.</p>
    </>
  );
}

function Excluded({ notification }: { notification: KbNotification }) {
  const { client } = useServices();
  const payload = notification.payload as { material_id?: string; material_title?: string; items?: ExcludedItem[] };
  const [restored, setRestored] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const items = payload.items ?? [];
  const restore = async (seg: number) => {
    if (!payload.material_id) return;
    setBusy(seg);
    try {
      await client.call('POST /kb/materials/{material_id}/excluded/{seg}/restore', { path: { material_id: payload.material_id, seg } });
      setRestored((r) => ({ ...r, [seg]: 'Restored — the source is processed again with it.' }));
    } catch (e) {
      setRestored((r) => ({ ...r, [seg]: `Couldn’t restore: ${errorText(e)}` }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <p className="kb-muted">
        “{payload.material_title}”: text that addresses an AI was left out of processing. The original is kept unchanged.
      </p>
      {items.map((it) => (
        <figure key={it.seg} className="kb-quotecard">
          <figcaption className="kb-quotecard__head"><Icon name="shield" size={13} /><span>{it.location_label ?? `fragment ${it.seg}`}</span></figcaption>
          <blockquote className="kb-quotecard__text kb-quotecard__text--found">{it.found}</blockquote>
          {restored[it.seg] ? <p className="kb-fix__state" role="status">{restored[it.seg]}</p> : (
            <div className="kb-fix__acts">
              <Button size="sm" busy={busy === it.seg} onClick={() => void restore(it.seg)}>Not an instruction, restore</Button>
            </div>
          )}
        </figure>
      ))}
    </>
  );
}

export type { ReactNode };
