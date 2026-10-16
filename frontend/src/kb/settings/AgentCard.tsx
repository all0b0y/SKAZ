import { useEffect, useState } from 'react';
import type { KbAgent } from '../../api/kb/types.gen';
import type { EngineId } from '../api/names';
import { Button, Icon } from '../ui';
import { EngineBadge } from '../ui/EngineBadge';
import { useAgents, useServices } from '../state/context';

const ACCOUNT: Record<EngineId, string> = {
  codex: 'ChatGPT subscription',
  claude_code: 'Claude subscription or Anthropic key',
  hermes: 'Models and keys from Hermes settings',
};

const STATE_TEXT: Record<KbAgent['state'], string> = {
  ready: 'Connected',
  not_installed: 'Not installed',
  outdated: 'Needs an update',
  signed_out: 'Not signed in',
  unavailable: 'Unavailable',
  preparing: 'Checking',
};

function tone(state: KbAgent['state']): 'ok' | 'warn' | 'err' {
  if (state === 'ready') return 'ok';
  if (state === 'unavailable') return 'err';
  return 'warn';
}

/**
 * One agent with its real state (v21): Connected / Not installed / Not signed in / Needs an
 * update, the action that fixes it, and the install log while a task runs. Hermes says that SKAZ
 * checks it once with SKAZ's own folder before starting it (nothing is downloaded: it runs on the
 * user's own Hermes). Used by first launch and Settings → Accounts & keys.
 */
export function AgentCard({ agent, variant = 'card' }: { agent: KbAgent; variant?: 'card' | 'row' }) {
  const { agents: store } = useServices();
  const install = useAgents((s) => s.installs[agent.id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean; url?: string | null } | null>(null);
  const [consent, setConsent] = useState(false);
  const [checkedHere, setCheckedHere] = useState(false);

  const running = install?.task.state === 'running';
  const taskId = install?.task.id ?? agent.install_task;

  // Pick up a task that was already running (after a reload) and follow the one just started.
  useEffect(() => {
    if (!taskId) return undefined;
    if (install && install.task.state !== 'running') return undefined;
    return store.getState().followInstall(agent.id, taskId);
  }, [store, agent.id, taskId, install?.task.state]);

  const act = async (what: 'install' | 'update' | 'first_check' | 'login' | 'check' | 'cancel' | 'logout') => {
    setBusy(what);
    setMessage(null);
    const s = store.getState();
    if (what === 'install' || what === 'update' || what === 'first_check') {
      const r = await s.install(agent.id, what);
      if (!r.ok) setMessage({ text: r.error, error: true });
    } else if (what === 'cancel') {
      const r = await s.cancelInstall(agent.id);
      if (!r.ok) setMessage({ text: r.error, error: true });
    } else if (what === 'logout') {
      const r = await s.logoutCodex();
      setMessage(r.ok ? { text: 'Signed out of Codex in SKAZ. Codex in other apps stays signed in.', error: false } : { text: r.error, error: true });
    } else if (what === 'login') {
      const r = await s.login(agent.id, consent || undefined);
      if (!r.ok) setMessage({ text: r.error, error: true });
      else setMessage({ text: r.value.message, error: false, url: r.value.url });
    } else {
      setCheckedHere(true);
      const r = await s.check(agent.id);
      if (!r.ok) setMessage({ text: r.error, error: true });
      else setMessage({ text: r.value.state === 'ready' ? 'Connected.' : r.value.reason ?? STATE_TEXT[r.value.state], error: r.value.state !== 'ready' });
    }
    setBusy(null);
  };

  // "Nothing starts until you press Check" is gone once Check was pressed and found no Hermes (QA A5).
  const firstCheck = agent.id === 'hermes' && agent.first_run && !agent.first_run.checked
    && !(checkedHere && agent.state === 'not_installed');
  const action = agent.action;
  const label = action === 'install' ? 'Install' : action === 'update' ? 'Update' : action === 'login' ? 'Sign in' : action === 'check' ? 'Check again'
    : action === 'first_check' ? 'Check' : null;
  const finished = install && install.task.state !== 'running' ? install.task : null;

  const status = (
    <span className={`kb-status kb-status--${tone(agent.state)}`}>
      <Icon name={agent.state === 'ready' ? 'check' : agent.state === 'unavailable' ? 'error' : 'warning'} size={13} />
      {STATE_TEXT[agent.state]}{agent.version && agent.state === 'ready' ? ` · ${agent.version}` : ''}
    </span>
  );
  const when = <CheckedWhen engine={agent.id} checkedAt={agent.checked_at} />;
  const buttons = running ? (
    <Button size="sm" busy={busy === 'cancel'} onClick={() => void act('cancel')}>Cancel</Button>
  ) : (
    <>
      {label && action && (
        <Button size="sm" variant="fill" busy={busy === action} onClick={() => void act(action)}>{label}</Button>
      )}
      {/* "Look again" means nothing before the first check: that check is the only "Check". */}
      {action !== 'check' && action !== 'first_check' && (
        <Button size="sm" variant="quiet" busy={busy === 'check'} onClick={() => void act('check')}>Check</Button>
      )}
      {/* Only Codex signs in inside SKAZ (its own Codex profile); the others sign out in their own apps. */}
      {agent.id === 'codex' && agent.signed_in && (
        <Button size="sm" variant="quiet" busy={busy === 'logout'} onClick={() => void act('logout')}>Sign out</Button>
      )}
    </>
  );
  const details = (
    <>
      {agent.reason && agent.state !== 'ready' && agent.state !== 'not_installed' && variant === 'card' && <p className="kb-agentcard__reason">{agent.reason}</p>}
      {firstCheck && agent.first_run && (
        <p className="kb-agentcard__note" role="note">
          <Icon name="shield" size={13} />
          {agent.first_run.note || 'SKAZ checks Hermes once with its own Hermes folder. Nothing starts until you press Check.'}
        </p>
      )}
      {(running || finished) && install && (
        <div className="kb-installlog">
          <div className="kb-installlog__head">
            {running ? <span className="kb-spinner kb-spinner--inline" aria-hidden="true" /> : <Icon name={finished?.state === 'succeeded' ? 'check' : 'error'} size={13} />}
            <span role="status">
              {running ? (install.task.action === 'update' ? 'Updating…' : install.task.action === 'first_check' ? 'Checking…' : 'Installing…')
                : finished?.state === 'succeeded' ? `Done${finished.version ? ` · ${finished.version}` : ''}`
                  : finished?.state === 'cancelled' ? 'Cancelled' : `Failed${finished?.reason ? `: ${finished.reason}` : ''}`}
            </span>
          </div>
          <pre className="kb-installlog__lines" aria-label="Install log" tabIndex={0}>
            {install.task.dropped > 0 && `… ${install.task.dropped} earlier lines\n`}
            {install.lines.map((l) => l.text).join('\n')}
          </pre>
          {finished?.state === 'failed' && (
            <p className="kb-agentcard__manual">
              Install it yourself: <code>{finished.install.manual_command}</code>{' '}
              <a className="kb-md__link" href={finished.install.docs_url} target="_blank" rel="noreferrer noopener">instructions</a>
            </p>
          )}
        </div>
      )}
      {message && (
        <p className={message.error ? 'kb-inline-error kb-inline-error--flat' : 'kb-agentcard__msg'} role={message.error ? 'alert' : 'status'}>
          {message.text}
          {message.url && <> <a className="kb-md__link" href={message.url} target="_blank" rel="noreferrer noopener">Open the sign-in page</a></>}
        </p>
      )}
      {action === 'login' && agent.id === 'codex' && (
        <label className="kb-agentcard__consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          I understand that questions and material text go to OpenAI through my ChatGPT account
        </label>
      )}
    </>
  );

  if (variant === 'row') {
    // Settings → Accounts & keys (v21): status and actions on the right; details under them.
    return (
      <div className="kb-agentrow" data-engine={agent.id} data-state={agent.state}>
        <div className="kb-agentrow__line">{status}{buttons}</div>
        <div className="kb-agentrow__when">{when}</div>
        {details}
      </div>
    );
  }
  return (
    <li className="kb-agentcard" data-engine={agent.id} data-state={agent.state}>
      <div className="kb-agentcard__head">
        <EngineBadge engine={agent.id} size={32} />
        <b className="kb-agentcard__name">{agent.name}</b>
        <span className="kb-muted kb-agentcard__account">· {ACCOUNT[agent.id]}</span>
        <span className="kb-head__spacer" />
        <span className="kb-agentcard__st">{status}{when}</span>
        <span className="kb-agentcard__acts">{buttons}</span>
      </div>
      {details}
    </li>
  );
}

/** "Checked just now" / "Checked 4 min ago" / "Checking…" (minutes tick only while the window is visible). */
export function checkedText(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const minutes = Math.floor((now - t) / 60_000);
  if (minutes < 1) return 'Checked just now';
  if (minutes < 60) return `Checked ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Checked ${hours} h ago` : `Checked ${Math.floor(hours / 24)} d ago`;
}

function CheckedWhen({ engine, checkedAt }: { engine: EngineId; checkedAt: string }) {
  const checking = useAgents((s) => s.checking[engine] ?? false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => { if (document.visibilityState === 'visible') setNow(Date.now()); }, 30_000);
    return () => clearInterval(id);
  }, [checkedAt]);
  const text = checking ? 'Checking…' : checkedText(checkedAt, now);
  return text ? <span className="kb-agentcard__checked" aria-live="polite">{text}</span> : null;
}

/** All three agents; a short honest line when they can't be read. */
export function AgentCards() {
  const { agents: store } = useServices();
  const agents = useAgents((s) => s.agents);
  const load = useAgents((s) => s.load);
  const error = useAgents((s) => s.error);
  // The agents screen checks by itself when it opens (reads them first if not read yet).
  useEffect(() => { store.getState().autoCheck('open'); }, [store]);
  if (!agents) {
    return load === 'error' ? (
      <p className="kb-inline-error kb-inline-error--flat" role="alert">
        Agents couldn’t be checked: {error} <Button size="sm" variant="quiet" icon="retry" onClick={() => void store.getState().refresh()}>Try again</Button>
      </p>
    ) : <p className="kb-muted" role="status">Checking agents…</p>;
  }
  return <ul className="kb-agentcards">{agents.agents.map((a) => <AgentCard key={a.id} agent={a} />)}</ul>;
}
