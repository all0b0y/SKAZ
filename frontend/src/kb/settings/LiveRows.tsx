import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { KbDecisions, KbProblem, KbSpeechSettings } from '../../api/kb/types.gen';
import type { EngineId, KeyProviderId } from '../api/names';
import { KbApiError, errorText } from '../api/client';
import { Banner, Button, Icon, Modal, Segmented, Switch } from '../ui';
import { ENGINE_NAME, ENGINE_ORDER, agentOf } from '../state/agents';
import { HEALTH_TO_SECTION } from '../state/settings';
import { useAgents, useServices, useSettings, useUi } from '../state/context';
import type { SettingsSection } from '../state/ui';
import { AgentCard } from './AgentCard';
import { LANGUAGES, languageName } from './Languages';

/** Visible, honest "not here yet" (no dummy buttons). */
export function NotYet({ text = 'Not connected yet' }: { text?: string }) {
  return <span className="kb-pending"><Icon name="error" size={13} />{text}</span>;
}

function Failed({ error, retry }: { error: string; retry: () => void }) {
  return (
    <span className="kb-inline-error kb-inline-error--flat kb-srow__fail" role="alert">
      Couldn’t read: {error}
      <Button size="sm" variant="quiet" icon="retry" onClick={retry}>Try again</Button>
    </span>
  );
}

const Reading = () => <span className="kb-muted" role="status">Reading…</span>;

function useResult(): [ReactNode, (r: { ok: boolean; error?: string }, okText?: string) => void] {
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const node = msg ? <span className={msg.error ? 'kb-inline-error kb-inline-error--flat' : 'kb-muted'} role={msg.error ? 'alert' : 'status'}>{msg.text}</span> : null;
  return [node, (r, okText) => setMsg(r.ok ? (okText ? { text: okText, error: false } : null) : { text: r.error ?? 'Failed', error: true })];
}

// ---- Problem plates (S3 health) --------------------------------------------------------------

/** Problem plates of one settings section: what happened, what still works, what stopped. */
export function HealthPlates({ section }: { section: SettingsSection }) {
  const { settings } = useServices();
  const toSection = useUi((s) => s.setSettingsSection);
  const health = useSettings((s) => s.health);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const problems: KbProblem[] = (health.value?.sections ?? []).filter((s) => HEALTH_TO_SECTION[s.id] === section).flatMap((s) => s.problems);
  if (!problems.length) return null;
  return (
    <div className="kb-plates">
      {problems.map((p) => (
        <Banner key={p.id} tone={p.severity} title={p.title}
          progress={p.progress !== null ? p.progress * 100 : undefined} progressLabel={p.title}
          actions={p.actions.length || p.id === 'speech-soniox-key' ? (
            <>
              {/* No key: the fix is in Accounts & keys — one click there (QA A31). */}
              {p.id === 'speech-soniox-key' && (
                <Button size="sm" variant="fill" onClick={() => toSection('conn')}>Add key…</Button>
              )}
              {p.actions.map((a) => (
                <Button key={a.id} size="sm" variant={a.primary ? 'fill' : 'outline'} busy={busy === `${p.id}/${a.id}`}
                  onClick={async () => {
                    setBusy(`${p.id}/${a.id}`);
                    const r = await settings.getState().healthAction(p.id, a.id);
                    setBusy(null);
                    setError(r.ok ? null : r.error);
                    // A speech fix changes the service or the Soniox consent: the rows and Privacy follow.
                    if (r.ok && section === 'rec') await Promise.all([settings.getState().loadSpeech(), settings.getState().loadPrivacy()]);
                  }}>{a.label}</Button>
              ))}
            </>
          ) : undefined}>
          {p.reason}
          {(p.still_works || p.stopped) && (
            <span className="kb-plate__works">
              {p.still_works && <span><Icon name="check" size={12} />Still works: {p.still_works}</span>}
              {p.stopped && <span><Icon name="close" size={12} />Stopped: {p.stopped}</span>}
            </span>
          )}
        </Banner>
      ))}
      {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
    </div>
  );
}

// ---- Accounts & keys -------------------------------------------------------------------------

export function AgentRow({ engine }: { engine: EngineId }) {
  const agent = useAgents((s) => agentOf(s.agents, engine));
  const load = useAgents((s) => s.load);
  const error = useAgents((s) => s.error);
  const { agents } = useServices();
  if (!agent) return load === 'error' ? <Failed error={error ?? ''} retry={() => void agents.getState().refresh()} /> : <Reading />;
  return <AgentCard agent={agent} variant="row" />;
}

const KEY_NAME: Record<KeyProviderId, string> = { openrouter: 'OpenRouter', soniox: 'Soniox', openai: 'OpenAI' };

/** API key: whether one is saved and whether it worked; a new key is sent once and never shown. */
export function KeyRow({ provider }: { provider: KeyProviderId }) {
  const { settings } = useServices();
  const keys = useSettings((s) => s.keys);
  const row = keys.value?.providers.find((p) => p.id === provider);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<'save' | 'check' | null>(null);
  const [result, show] = useResult();
  const id = useId();
  if (!keys.value) return keys.error ? <Failed error={keys.error} retry={() => void settings.getState().loadKeys()} /> : <Reading />;
  const status = !row?.configured ? { tone: 'warn', text: 'No key' }
    : row.valid === false ? { tone: 'err', text: 'Key didn’t work' }
      : row.valid ? { tone: 'ok', text: 'Key works' } : { tone: 'ok', text: 'Key saved' };
  if (editing) {
    return (
      <form className="kb-keyform" onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation(); // QA A17: Esc leaves the key form; the typed key is dropped, Settings stays
        setEditing(false); setValue('');
      }} onSubmit={async (e) => {
        e.preventDefault();
        if (!value.trim()) return;
        setBusy('save');
        const r = await settings.getState().saveKey(provider, value.trim());
        setBusy(null);
        show(r, 'Saved.');
        if (r.ok) { setEditing(false); setValue(''); }
      }}>
        <label htmlFor={id} className="kb-visually-hidden">{KEY_NAME[provider]} key</label>
        <input id={id} className="kb-attachform__input kb-keyform__input" type="password" autoComplete="off" spellCheck={false}
          placeholder="Paste the key" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        <Button size="sm" variant="fill" type="submit" busy={busy === 'save'} disabled={!value.trim()}>Save</Button>
        <Button size="sm" variant="quiet" onClick={() => { setEditing(false); setValue(''); }}>Cancel</Button>
        {result}
      </form>
    );
  }
  return (
    <>
      <span className={`kb-status kb-status--${status.tone}`}><Icon name={status.tone === 'ok' ? 'check' : status.tone === 'err' ? 'error' : 'warning'} size={13} />{status.text}</span>
      {row?.configured && (
        <Button size="sm" variant="quiet" busy={busy === 'check'} onClick={async () => {
          setBusy('check');
          const r = await settings.getState().checkKey(provider);
          setBusy(null);
          const now = settings.getState().keys.value?.providers.find((p) => p.id === provider);
          show(r, now?.valid === false ? undefined : 'The key works.');
          if (r.ok && now?.valid === false) show({ ok: false, error: 'The key didn’t work. Paste a new one.' });
        }}>Check</Button>
      )}
      <Button size="sm" onClick={() => setEditing(true)}>{row?.configured ? 'Replace…' : 'Add key…'}</Button>
      {result}
    </>
  );
}

const mb = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/**
 * The local Whisper model's state. With `offerDownload` (first launch, where there is no health
 * plate — QA A2) it also offers the download right there, with the model's real size, and follows
 * the progress; in Settings the plate of Recording & speech offers it instead.
 */
export function LocalWhisperRow({ offerDownload = false }: { offerDownload?: boolean } = {}) {
  const speech = useSettings((s) => s.speech);
  const { settings } = useServices();
  const [busy, setBusy] = useState(false);
  const [result, show] = useResult();
  const state = speech.value?.local_model.state;
  // Follow a running download (one read at a time, only while it runs and only where it was offered).
  useEffect(() => {
    if (!offerDownload || state !== 'downloading') return undefined;
    let live = true;
    let timer: number | undefined;
    const tick = async () => {
      await settings.getState().loadSpeech();
      if (live) timer = window.setTimeout(() => void tick(), 1500);
    };
    timer = window.setTimeout(() => void tick(), 1500);
    return () => { live = false; window.clearTimeout(timer); };
  }, [offerDownload, state, settings]);
  if (!speech.value) return speech.error ? <Failed error={speech.error} retry={() => void settings.getState().loadSpeech()} /> : <Reading />;
  const m = speech.value.local_model;
  if (m.state === 'ready') return <span className="kb-status kb-status--ok"><Icon name="check" size={13} />Downloaded</span>;
  if (m.state === 'downloading') return <Progress value={m.progress} label="Downloading the speech model" />;
  const status = <span className={`kb-status kb-status--${m.state === 'failed' ? 'err' : 'warn'}`}><Icon name={m.state === 'failed' ? 'error' : 'warning'} size={13} />{m.state === 'failed' ? m.reason ?? 'Download failed' : 'Not downloaded'}</span>;
  if (!offerDownload) return status;
  const action = m.state === 'failed' ? 'retry' : 'download';
  return (
    <>
      {status}
      <Button size="sm" variant="fill" icon={m.state === 'failed' ? 'retry' : undefined} busy={busy} onClick={async () => {
        setBusy(true);
        const r = await settings.getState().healthAction('speech-local-model', action);
        if (r.ok) await settings.getState().loadSpeech();
        setBusy(false);
        show(r);
      }}>
        {m.state === 'failed' ? 'Try again' : `Download${m.size_bytes ? ` · about ${decimalSize(m.size_bytes)}` : ''}`}
      </Button>
      {result}
    </>
  );
}

/** Sizes as Finder shows them (1 MB = 1,000,000 bytes), so the number matches what the user sees there. */
const decimalSize = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB`
  : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

/**
 * Settings → Recording & speech: the downloaded Whisper model, with its size, and deleting it after
 * a confirmation (the old "Delete downloaded model"). Only that model's files are removed.
 */
export function SpeechModelRow() {
  const speech = useSettings((s) => s.speech);
  const { settings } = useServices();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, show] = useResult();
  if (!speech.value) return speech.error ? <Failed error={speech.error} retry={() => void settings.getState().loadSpeech()} /> : <Reading />;
  const m = speech.value.local_model;
  const size = m.size_bytes ? ` · about ${decimalSize(m.size_bytes)}` : '';
  const name = `Whisper ${m.model}`;
  // Ready, or a failed download that may have left partial files: both have something to delete.
  const deletable = m.state === 'ready' || m.state === 'failed';
  return (
    <>
      {m.state === 'downloading' ? <Progress value={m.progress} label="Downloading the speech model" />
        : deletable ? <span className="kb-muted">{name}{m.state === 'failed' ? ' · partly downloaded' : size}</span>
          : <span className="kb-muted">Not downloaded</span>}
      {deletable && (
        <Button size="sm" variant="outline" icon="trash" busy={busy} onClick={() => setAsking(true)}>Delete…</Button>
      )}
      {result}
      <Modal open={asking} onClose={() => setAsking(false)} title="Delete the speech model?" className="kb-confirm" testId="confirm-delete-speech-model">
        <div className="kb-confirm__body">
          <p>{name}{m.size_bytes ? ` (about ${decimalSize(m.size_bytes)})` : ''} will be removed from this Mac.</p>
          <p className="kb-muted">Recognition on this computer won’t work until you download it again. Recordings with Soniox and your materials are not affected.</p>
        </div>
        <footer className="kb-confirm__foot">
          <Button onClick={() => setAsking(false)}>Cancel</Button>
          <Button variant="danger" icon="trash" onClick={async () => {
            setAsking(false);
            setBusy(true);
            const r = await settings.getState().deleteLocalModel();
            setBusy(false);
            show(r.ok ? { ok: true } : r, r.ok ? (r.value > 0 ? `Deleted · ${decimalSize(r.value)} freed` : 'Deleted') : undefined);
          }}>Delete</Button>
        </footer>
      </Modal>
    </>
  );
}

function Progress({ value, label }: { value: number | null; label: string }) {
  const pct = value === null ? null : Math.round(value * 100);
  return (
    <span className="kb-progress-row">
      <span className="kb-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <i style={{ width: `${pct ?? 30}%` }} />
      </span>
      <span className="kb-muted">{pct === null ? '…' : `${pct}%`}</span>
    </span>
  );
}

export function LocalDecisionsRow() {
  const decisions = useSettings((s) => s.decisions);
  const { settings } = useServices();
  const [busy, setBusy] = useState(false);
  const [result, show] = useResult();
  useEffect(() => { if (!decisions.value && !decisions.error) void settings.getState().loadDecisions(); }, [settings, decisions.value, decisions.error]);
  if (!decisions.value) return decisions.error ? <Failed error={decisions.error} retry={() => void settings.getState().loadDecisions()} /> : <Reading />;
  const l = decisions.value.local;
  if (l.state === 'ready' || l.state === 'running') return <span className="kb-status kb-status--ok"><Icon name="check" size={13} />{l.model_title} · downloaded</span>;
  if (l.state === 'downloading') {
    return (
      <>
        <Progress value={l.progress} label="Downloading the decision model" />
        <Button size="sm" variant="quiet" busy={busy} onClick={async () => { setBusy(true); show(await settings.getState().cancelDecisionModel()); setBusy(false); }}>Cancel</Button>
        {result}
      </>
    );
  }
  return (
    <>
      {l.state === 'failed' && <span className="kb-status kb-status--err"><Icon name="error" size={13} />{l.message ?? 'Download failed'}</span>}
      <Button size="sm" busy={busy} onClick={async () => { setBusy(true); show(await settings.getState().downloadDecisionModel()); setBusy(false); }}>
        {l.state === 'failed' ? 'Try again' : `Download · ${mb(l.total_bytes || l.required_bytes)}`}
      </Button>
      {result}
    </>
  );
}

// ---- Models ------------------------------------------------------------------------------------

export function DefaultAgentRow({ label }: { label: string }) {
  const { agents } = useServices();
  const data = useAgents((s) => s.agents);
  const [result, show] = useResult();
  if (!data) return <Reading />;
  const ready = new Set(data.agents.filter((a) => a.state === 'ready').map((a) => a.id));
  return (
    <>
      <Segmented<EngineId> label={label} size="sm" value={data.default}
        onChange={async (v) => {
          if (!ready.has(v)) { show({ ok: false, error: `${ENGINE_NAME[v]} isn’t connected — set it up in Accounts & keys.` }); return; }
          show(await agents.getState().setDefault(v));
        }}
        options={ENGINE_ORDER.map((e) => ({ value: e, label: ENGINE_NAME[e].replace(' Agent', ''), name: `${ENGINE_NAME[e]}${ready.has(e) ? '' : ' (not connected)'}` }))} />
      {result}
    </>
  );
}

/** The chat model is chosen per chat in the message field (decision 34); here — what each agent uses now. */
export function ChatModelRow() {
  const data = useAgents((s) => s.agents);
  if (!data) return <Reading />;
  const a = agentOf(data, data.default);
  const model = a?.models.find((m) => m.id === a.current_model);
  return <span className="kb-muted">{a?.name}: {model?.label ?? (a?.id === 'hermes' ? 'as set in Hermes' : 'agent default')} · change it in the message field</span>;
}

export function WikiModelRow({ label }: { label: string }) {
  const { settings } = useServices();
  const wiki = useSettings((s) => s.wiki);
  const data = useAgents((s) => s.agents);
  const [result, show] = useResult();
  if (!wiki.value) return wiki.error ? <Failed error={wiki.error} retry={() => void settings.getState().loadWiki()} /> : <Reading />;
  const value = wiki.value.wiki_engine ?? 'default';
  return (
    <>
      <Segmented<string> label={label} size="sm" value={value}
        onChange={async (v) => {
          const engine = v === 'default' ? null : (v as EngineId);
          if (engine && agentOf(data, engine)?.state !== 'ready') { show({ ok: false, error: `${ENGINE_NAME[engine]} isn’t connected.` }); return; }
          show(await settings.getState().updateWiki({ wiki_engine: engine }));
        }}
        options={[{ value: 'default', label: 'Default agent' }, ...ENGINE_ORDER.map((e) => ({ value: e, label: ENGINE_NAME[e].replace(' Agent', '') }))]} />
      {result}
    </>
  );
}

type Provider = KbDecisions['provider'];

/** Decision layer (B7): OpenRouter·Jev (cloud, explicit consent) or on this computer, or off. */
export function DecisionsRow({ label }: { label: string }) {
  const { settings } = useServices();
  const decisions = useSettings((s) => s.decisions);
  const [consent, setConsent] = useState(false);
  const [result, show] = useResult();
  useEffect(() => { if (!decisions.value && !decisions.error) void settings.getState().loadDecisions(); }, [settings, decisions.value, decisions.error]);
  if (!decisions.value) return decisions.error ? <Failed error={decisions.error} retry={() => void settings.getState().loadDecisions()} /> : <Reading />;
  const d = decisions.value;
  const choose = async (provider: Provider, cloudConsent?: boolean) => {
    if (provider === 'openrouter_jev' && !d.openrouter_key) { show({ ok: false, error: 'Add an OpenRouter key in Accounts & keys first.' }); return; }
    if (provider === 'openrouter_jev' && !d.cloud_consent && !cloudConsent) { setConsent(true); return; }
    if (provider === 'local' && d.local.state !== 'ready' && d.local.state !== 'running') {
      show({ ok: false, error: 'Download the model first (Accounts & keys → On this computer).' });
      return;
    }
    show(await settings.getState().setDecisionProvider({ provider, ...(cloudConsent ? { cloud_consent: true } : {}) }));
  };
  return (
    <>
      <Segmented<Provider> label={label} size="sm" value={d.provider} onChange={(v) => void choose(v)}
        options={[{ value: 'openrouter_jev', label: 'OpenRouter · Jev' }, { value: 'local', label: 'On this computer' }, { value: 'off', label: 'Off' }]} />
      {result}
      <Modal open={consent} onClose={() => setConsent(false)} title="Send decision questions to OpenRouter?" className="kb-confirm" testId="confirm-cloud">
        <div className="kb-confirm__body">
          <p>Short questions about where to file a material and whether to merge pages — with page titles and short excerpts — go to {d.cloud_model} through your OpenRouter key.</p>
          <p className="kb-muted">You can switch back to “On this computer” or “Off” at any time.</p>
        </div>
        <footer className="kb-confirm__foot">
          <Button onClick={() => setConsent(false)}>Cancel</Button>
          <Button variant="fill" onClick={async () => { setConsent(false); await choose('openrouter_jev', true); }}>Allow and use</Button>
        </footer>
      </Modal>
    </>
  );
}

// ---- Recording & speech ----------------------------------------------------------------------

export function AsrRow({ label }: { label: string }) {
  const { settings } = useServices();
  const speech = useSettings((s) => s.speech);
  const [result, show] = useResult();
  if (!speech.value) return speech.error ? <Failed error={speech.error} retry={() => void settings.getState().loadSpeech()} /> : <Reading />;
  return (
    <>
      {/* The old app may have chosen OpenAI for speech; it is shown as is but not offered here. */}
      <Segmented<KbSpeechSettings['provider']> label={label} size="sm" value={speech.value.provider}
        onChange={async (v) => { if (v !== 'openai') show(await settings.getState().updateSpeech({ provider: v })); }}
        options={[{ value: 'soniox', label: 'Soniox' }, { value: 'local_whisper', label: 'On this computer' },
          ...(speech.value.provider === 'openai' ? [{ value: 'openai' as const, label: 'OpenAI' }] : [])]} />
      {result}
    </>
  );
}

/**
 * Consent to send audio to Soniox (review B2 #6): stored as the existing settings' cloud consent, given
 * only here (after saying what goes where) or by the plate's "Allow sending audio to Soniox", taken
 * back with one click. Choosing Soniox as the service never gives it.
 */
export function SonioxConsentRow({ label }: { label: string }) {
  const { settings } = useServices();
  const speech = useSettings((s) => s.speech);
  const [asking, setAsking] = useState(false);
  const [result, show] = useResult();
  if (!speech.value) return speech.error ? <Failed error={speech.error} retry={() => void settings.getState().loadSpeech()} /> : <Reading />;
  const set = async (consent: boolean) => {
    const r = await settings.getState().updateSpeech({ cloud_consent: consent });
    show(r);
    if (r.ok) await Promise.all([settings.getState().loadHealth(), settings.getState().loadPrivacy()]);
  };
  return (
    <>
      <span className="kb-muted">Audio of recordings, imports and dictation → Soniox (cloud speech recognition)</span>
      <Switch label={label} checked={speech.value.cloud_consent} onChange={(v) => { if (v) setAsking(true); else void set(false); }} />
      {result}
      <Modal open={asking} onClose={() => setAsking(false)} title="Send audio to Soniox?" className="kb-confirm" testId="confirm-soniox">
        <div className="kb-confirm__body">
          <p>While you record, import audio or video, or dictate, the sound goes to Soniox (cloud speech recognition) through your Soniox key; the recognised text comes back to this computer.</p>
          <p className="kb-muted">You can turn this off at any time, or recognise speech on this computer instead.</p>
        </div>
        <footer className="kb-confirm__foot">
          <Button onClick={() => setAsking(false)}>Cancel</Button>
          <Button variant="fill" onClick={async () => { setAsking(false); await set(true); }}>Allow</Button>
        </footer>
      </Modal>
    </>
  );
}

/**
 * Languages the user hears, as toggle chips (pressed = chosen), stored in the backend's speech
 * settings — the same list recording, imports and dictation use (QA A11: first launch and Settings
 * write the same place). The settings row (or `labelledBy`) names the group.
 */
export function SpeechLanguagesRow({ labelledBy }: { labelledBy?: string } = {}) {
  const { settings } = useServices();
  const speech = useSettings((s) => s.speech);
  const [result, show] = useResult();
  // Quick clicks build on each other, not on the answer of the previous one still on its way,
  // and are saved in the order they were made.
  const [pending, setPending] = useState<string[] | null>(null);
  const latest = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  if (!speech.value) return speech.error ? <Failed error={speech.error} retry={() => void settings.getState().loadSpeech()} /> : <Reading />;
  const chosen = pending ?? speech.value.languages;
  return (
    <>
      <div className="kb-tags" role={labelledBy ? 'group' : undefined} aria-labelledby={labelledBy}>
        {LANGUAGES.map((l) => {
          const on = chosen.includes(l.code);
          return (
            <button key={l.code} type="button" className={`kb-tag${on ? ' is-on' : ''}`} aria-pressed={on}
              onClick={async () => {
                const next = on ? chosen.filter((c) => c !== l.code) : [...chosen, l.code];
                if (!next.length) { show({ ok: false, error: 'Keep at least one language.' }); return; }
                const turn = ++latest.current;
                setPending(next);
                const saved = queue.current.then(() => settings.getState().updateSpeech({ languages: next }));
                queue.current = saved;
                const r = await saved;
                if (turn === latest.current) setPending(null);
                show(r);
              }}>
              {on && <Icon name="check" size={12} />}{l.name}
            </button>
          );
        })}
      </div>
      {result}
    </>
  );
}

/** Default translation of recordings, in the backend's speech settings (shared by first launch and Settings). */
export function TranslationRow({ optionPrefix = '' }: { optionPrefix?: string } = {}) {
  const { settings } = useServices();
  const speech = useSettings((s) => s.speech);
  const [result, show] = useResult();
  const id = useId();
  if (!speech.value) return speech.error ? <Failed error={speech.error} retry={() => void settings.getState().loadSpeech()} /> : <Reading />;
  const value = speech.value.translate_by_default ? speech.value.translation_language : '';
  return (
    <>
      <label htmlFor={id} className="kb-visually-hidden">Default translation</label>
      <span className="kb-select">
        <select id={id} value={value} onChange={async (e) => {
          const v = e.target.value;
          show(await settings.getState().updateSpeech(v ? { translate_by_default: true, translation_language: v } : { translate_by_default: false }));
        }}>
          <option value="">No translation</option>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{optionPrefix}{l.name}</option>)}
        </select>
        <Icon name="chevronDown" size={12} className="kb-select__chev" />
      </span>
      {result}
    </>
  );
}

// ---- Wiki ------------------------------------------------------------------------------------

type WikiFlag = 'auto_add_files_links' | 'auto_add_text' | 'auto_corrections';

export function WikiLanguageRow() {
  const { settings } = useServices();
  const wiki = useSettings((s) => s.wiki);
  const [result, show] = useResult();
  const id = useId();
  if (!wiki.value) return wiki.error ? <Failed error={wiki.error} retry={() => void settings.getState().loadWiki()} /> : <Reading />;
  return (
    <>
      <label htmlFor={id} className="kb-visually-hidden">Wiki language</label>
      <span className="kb-select">
        <select id={id} value={wiki.value.wiki_language} onChange={async (e) => show(await settings.getState().updateWiki({ wiki_language: e.target.value }))}>
          {!LANGUAGES.some((l) => l.code === wiki.value!.wiki_language) && <option value={wiki.value.wiki_language}>{languageName(wiki.value.wiki_language)}</option>}
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
        <Icon name="chevronDown" size={12} className="kb-select__chev" />
      </span>
      {result}
    </>
  );
}

export function WikiSwitchRow({ field, label }: { field: WikiFlag; label: string }) {
  const { settings } = useServices();
  const wiki = useSettings((s) => s.wiki);
  const [result, show] = useResult();
  if (!wiki.value) return wiki.error ? <Failed error={wiki.error} retry={() => void settings.getState().loadWiki()} /> : <Reading />;
  return (
    <>
      <Switch label={label} checked={wiki.value[field]} onChange={async (v) => show(await settings.getState().updateWiki({ [field]: v }))} />
      {result}
    </>
  );
}

/** Background search for connections: switched on only after an explicit "Allow" (W2 §2.5). */
export function BackgroundLinksRow({ label }: { label: string }) {
  const { settings } = useServices();
  const wiki = useSettings((s) => s.wiki);
  const [asking, setAsking] = useState(false);
  const [result, show] = useResult();
  if (!wiki.value) return wiki.error ? <Failed error={wiki.error} retry={() => void settings.getState().loadWiki()} /> : <Reading />;
  return (
    <>
      <Switch label={label} checked={wiki.value.background_connections} onChange={async (v) => {
        if (v) { setAsking(true); return; }
        show(await settings.getState().updateWiki({ background_connections: false }));
      }} />
      {result}
      <Modal open={asking} onClose={() => setAsking(false)} title="Look for connections in the background?" className="kb-confirm" testId="confirm-bg-links">
        <div className="kb-confirm__body">
          <p>When the app is idle, your agent reads pages from different folders and suggests connections. It uses your agent subscription; nothing is changed without a notification.</p>
        </div>
        <footer className="kb-confirm__foot">
          <Button onClick={() => setAsking(false)}>Cancel</Button>
          <Button variant="fill" onClick={async () => { setAsking(false); show(await settings.getState().updateWiki({ background_connections: true })); }}>Allow</Button>
        </footer>
      </Modal>
    </>
  );
}

export function FindLinksNowRow() {
  const { client } = useServices();
  const toSection = useUi((s) => s.setSettingsSection);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean; agent?: boolean } | null>(null);
  return (
    <>
      <Button size="sm" icon="graph" busy={busy} onClick={async () => {
        setBusy(true);
        try {
          await client.call('POST /kb/wiki/connections/find');
          setMsg({ text: 'Started. Found connections arrive as notifications.', error: false });
        } catch (e) {
          // 409: no ready agent — nothing started (QA A13); the fix is one click away.
          setMsg({ text: errorText(e), error: true, agent: e instanceof KbApiError && e.status === 409 && /agent/i.test(e.detail) });
        } finally {
          setBusy(false);
        }
      }}>Find now</Button>
      {msg && <span className={msg.error ? 'kb-inline-error kb-inline-error--flat' : 'kb-muted'} role={msg.error ? 'alert' : 'status'}>{msg.text}</span>}
      {msg?.agent && <Button size="sm" variant="outline" onClick={() => toSection('conn')}>Open Accounts &amp; keys</Button>}
    </>
  );
}

// ---- Privacy & About -------------------------------------------------------------------------

const FLOW_MATCH: Record<string, RegExp> = {
  'p-soniox': /soniox/i,
  'p-agent': /agent|codex|claude|hermes/i,
  'p-openrouter': /openrouter/i,
  'p-local': /computer|local|mac/i,
};

export function PrivacyRow({ rowId, fallback }: { rowId: string; fallback: string }) {
  const privacy = useSettings((s) => s.privacy);
  const flow = privacy.value?.flows.find((f) => FLOW_MATCH[rowId]?.test(f.where));
  if (!flow) return <span className="kb-muted">{fallback}</span>;
  return (
    <span className="kb-flow">
      <span>{flow.what}</span>
      <span className="kb-muted"> · {flow.when}</span>
      <span className={`kb-status kb-status--${flow.enabled ? 'ok' : 'off'}`}>{flow.enabled ? 'On' : 'Off'}</span>
    </span>
  );
}

export function VersionRow({ fallback }: { fallback: string }) {
  const about = useSettings((s) => s.about);
  return <span className="kb-muted">SKAZ {about.value ? `${about.value.version} · ${about.value.build}` : fallback}</span>;
}

export function Licenses() {
  const about = useSettings((s) => s.about);
  if (!about.value?.licenses.length) return null;
  return (
    <section className="kb-sgroup" aria-label="Open-source licences">
      <h4 className="kb-sgroup__title">Open-source licences</h4>
      <ul className="kb-licenses">
        {about.value.licenses.map((l) => (
          <li key={l.name}><a className="kb-md__link" href={l.url} target="_blank" rel="noreferrer noopener">{l.name}</a> <span className="kb-muted">{l.license}</span></li>
        ))}
      </ul>
    </section>
  );
}
