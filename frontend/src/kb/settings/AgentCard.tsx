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
  preparing: 'Preparing',
};

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function tone(state: KbAgent['state']): 'ok' | 'warn' | 'err' {
  if (state === 'ready') return 'ok';
  if (state === 'unavailable') return 'err';
  return 'warn';
}

/**
 * One agent with its real state (v21): Connected / Not installed / Not signed in / Needs an
 * update, the action that fixes it, and the install log while a task runs. Hermes says honestly
 * that its first run prepares ~1.5 GB. Used by first launch and Settings → Accounts & keys.
 */
export function AgentCard({ agent, variant = 'card' }: { agent: KbAgent; variant?: 'card' | 'row' }) {
  const { agents: store } = useServices();
  const install = useAgents((s) => s.installs[agent.id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean; url?: string | null } | null>(null);
  const [consent, setConsent] = useState(false);

  const running = install?.task.state === 'running';
  const taskId = install?.task.id ?? agent.install_task;

  // Pick up a task that was already running (after a reload) and follow the one just started.
  useEffect(() => {
    if (!taskId) return undefined;
    if (install && install.task.state !== 'running') return undefined;
    return store.getState().followInstall(agent.id, taskId);
  }, [store, agent.id, taskId, install?.task.state]);

  const act = async (what: 'install' | 'update' | 'prepare' | 'login' | 'check' | 'cancel' | 'logout') => {
    setBusy(what);
    setMessage(null);
    const s = store.getState();
    if (what === 'install' || what === 'update' || what === 'prepare') {
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
      const r = await s.check(agent.id);
      if (!r.ok) setMessage({ text: r.error, error: true });
      else setMessage({ text: r.value.state === 'ready' ? 'Connected.' : r.value.reason ?? STATE_TEXT[r.value.state], error: r.value.state !== 'ready' });
    }
    setBusy(null);
  };

  const hermesPrep = agent.id === 'hermes' && agent.first_run && !agent.first_run.prepared;
  const action = agent.action;
  const label = action === 'install' ? 'Install' : action === 'update' ? 'Update' : action === 'login' ? 'Sign in' : action === 'check' ? 'Check again'
    : action === 'prepare' ? 'Prepare' : null;
  const finished = install && install.task.state !== 'running' ? install.task : null;

  const status = (
    <span className={`kb-status kb-status--${tone(agent.state)}`}>
      <Icon name={agent.state === 'ready' ? 'check' : agent.state === 'unavailable' ? 'error' : 'warning'} size={13} />
      {STATE_TEXT[agent.state]}{agent.version && agent.state === 'ready' ? ` · ${agent.version}` : ''}
    </span>
  );
  const buttons = running ? (
    <Button size="sm" busy={busy === 'cancel'} onClick={() => void act('cancel')}>Cancel</Button>
  ) : (
    <>
      {label && action && (
        <Button size="sm" variant="fill" busy={busy === action} onClick={() => void act(action)}>{label}</Button>
      )}
      {action !== 'check' && (
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
      {hermesPrep && agent.first_run && (
        <p className="kb-agentcard__note" role="note">
          <Icon name="warning" size={13} />
          {agent.first_run.note || `The first check prepares Hermes’ environment: about ${gb(agent.first_run.required_bytes)}, a few minutes. Nothing starts until you press Prepare.`}
        </p>
      )}
      {(running || finished) && install && (
        <div className="kb-installlog">
          <div className="kb-installlog__head">
            {running ? <span className="kb-spinner kb-spinner--inline" aria-hidden="true" /> : <Icon name={finished?.state === 'succeeded' ? 'check' : 'error'} size={13} />}
            <span role="status">
              {running ? (install.task.action === 'update' ? 'Updating…' : install.task.action === 'prepare' ? 'Preparing…' : 'Installing…')
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
        {details}
      </div>
    );
  }
  return (
    <li className="kb-agentcard" data-engine={agent.id} data-state={agent.state}>
      <div className="kb-agentcard__head">
        <EngineBadge engine={agent.id} />
        <b className="kb-agentcard__name">{agent.name}</b>
        <span className="kb-muted kb-agentcard__account">· {ACCOUNT[agent.id]}</span>
        <span className="kb-head__spacer" />
        {status}
        <span className="kb-agentcard__acts">{buttons}</span>
      </div>
      {details}
    </li>
  );
}

/** All three agents; a short honest line when they can't be read. */
export function AgentCards() {
  const { agents: store } = useServices();
  const agents = useAgents((s) => s.agents);
  const load = useAgents((s) => s.load);
  const error = useAgents((s) => s.error);
  useEffect(() => { if (!agents) void store.getState().refresh(); }, [store, agents]);
  if (!agents) {
    return load === 'error' ? (
      <p className="kb-inline-error kb-inline-error--flat" role="alert">
        Agents couldn’t be checked: {error} <Button size="sm" variant="quiet" icon="retry" onClick={() => void store.getState().refresh()}>Try again</Button>
      </p>
    ) : <p className="kb-muted" role="status">Checking agents…</p>;
  }
  return <ul className="kb-agentcards">{agents.agents.map((a) => <AgentCard key={a.id} agent={a} />)}</ul>;
}
