import { useEffect, useRef, useState } from 'react';
import type { KbAgent } from '../../api/kb/types.gen';
import type { EngineId } from '../api/names';
import { Button, Icon, IconButton, Menu, Modal, type MenuItem } from '../ui';
import { EngineBadge } from '../ui/EngineBadge';
import { useAgents, useServices } from '../state/context';
import { WebSearchNote } from '../chat/webSearch';

const ACCOUNT: Record<EngineId, string> = {
  codex: 'ChatGPT subscription',
  claude_code: 'Claude subscription or Anthropic key',
  hermes: 'Models and keys from Hermes settings',
  opencode: 'Providers you sign in to through OpenCode',
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

/** Accounts & keys v3: what signing out stops, per agent SKAZ signs out in its own folder. */
const SIGN_OUT: Partial<Record<EngineId, { body: string; done: string }>> = {
  codex: {
    body: 'SKAZ forgets its own Codex sign-in. Chats and wiki updates on Codex stop until you sign in again. '
      + 'Nothing in your library is deleted. Codex in other apps stays signed in.',
    done: 'Signed out of Codex in SKAZ. Codex in other apps stays signed in.',
  },
  opencode: {
    body: 'SKAZ’s own OpenCode forgets the providers you signed in to. Chats and wiki updates on OpenCode stop until '
      + 'you sign in again. Nothing in your library is deleted. OpenCode outside SKAZ is not changed.',
    done: 'Signed out of OpenCode in SKAZ. OpenCode outside SKAZ is not changed.',
  },
};

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
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [consent, setConsent] = useState(false);
  const [checkedHere, setCheckedHere] = useState(false);
  const signIn = useAgents((s) => s.signIns[agent.id]);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);

  const running = install?.task.state === 'running';
  const taskId = install?.task.id ?? agent.install_task;

  // Pick up a task that was already running (after a reload) and follow the one just started.
  useEffect(() => {
    if (!taskId) return undefined;
    if (install && install.task.state !== 'running') return undefined;
    return store.getState().followInstall(agent.id, taskId);
  }, [store, agent.id, taskId, install?.task.state]);

  const act = async (what: 'install' | 'update' | 'first_check' | 'repair' | 'login' | 'check' | 'cancel' | 'logout') => {
    setBusy(what);
    setMessage(null);
    const s = store.getState();
    if (what === 'install' || what === 'update' || what === 'first_check' || what === 'repair') {
      const r = await s.install(agent.id, what);
      if (!r.ok) setMessage({ text: r.error, error: true });
    } else if (what === 'cancel') {
      const r = await s.cancelInstall(agent.id);
      if (!r.ok) setMessage({ text: r.error, error: true });
    } else if (what === 'logout') {
      setConfirmOut(false);
      const r = await s.logout(agent.id);
      setMessage(r.ok ? { text: SIGN_OUT[agent.id]?.done ?? `Signed out of ${agent.name} in SKAZ.`, error: false } : { text: r.error, error: true });
    } else if (what === 'login') {
      const r = await s.login(agent.id, consent || undefined);
      if (!r.ok) setMessage({ text: r.error, error: true });
      // Codex: the sign-in page this sign-in returned opens at once (the window's own external-link
      // rule hands only http(s) links to the browser); SKAZ then waits for Codex to say it is done.
      else if (r.value.method === 'browser' && r.value.url) window.open(r.value.url, '_blank', 'noopener');
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
    : action === 'first_check' ? 'Check' : action === 'repair' ? 'Repair' : null;
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
      {/* Accounts & keys v3: Sign out… (or why not) and Check again live in ⋯ next to Check. */}
      {agent.signed_in && (
        <>
          <IconButton ref={moreRef} icon="more" size="sm" label={`More for ${agent.name}`} aria-haspopup="menu"
            aria-expanded={menuOpen} disabled={busy === 'logout'} onClick={() => setMenuOpen((v) => !v)} />
          <Menu open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={moreRef} label={`${agent.name} account`}
            items={moreItems(agent).map((item) => ({ ...item, onSelect: () => {
              setMenuOpen(false);
              if (item.id === 'signout') setConfirmOut(true);
              else void act('check');
            } }))} />
        </>
      )}
    </>
  );
  const signOut = SIGN_OUT[agent.id];
  const confirm = signOut && (
    <Modal open={confirmOut} onClose={() => setConfirmOut(false)} title={`Sign out of ${agent.name}?`} className="kb-confirm" testId="confirm-sign-out">
      <div className="kb-confirm__body"><p>{signOut.body}</p></div>
      <footer className="kb-confirm__foot">
        <Button onClick={() => setConfirmOut(false)}>Cancel</Button>
        <Button variant="danger" busy={busy === 'logout'} onClick={() => void act('logout')}>Sign out</Button>
      </footer>
    </Modal>
  );
  const details = (
    <>
      {agent.reason && agent.state !== 'ready' && agent.state !== 'not_installed' && variant === 'card' && <p className="kb-agentcard__reason">{agent.reason}</p>}
      {variant === 'card' && agent.installed && <WebSearchNote agent={agent} />}
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
              {running ? (install.task.action === 'update' ? 'Updating…' : install.task.action === 'first_check' ? 'Checking…'
                : install.task.action === 'repair' ? 'Repairing…' : 'Installing…')
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
        </p>
      )}
      {!message && signIn && (
        <p className={`kb-agentcard__msg kb-signin kb-signin--${signIn.state}`} role="status">
          {signIn.state === 'waiting' && <span className="kb-spinner kb-spinner--inline" aria-hidden="true" />}
          {signIn.state === 'signed_in' && <Icon name="check" size={13} />}
          <span>
            {signIn.message}
            {signIn.state === 'waiting' && signIn.url && (
              <> <a className="kb-md__link" href={signIn.url} target="_blank" rel="noreferrer noopener">Open the sign-in page again</a></>
            )}
          </span>
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
        {confirm}
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
      {confirm}
    </li>
  );
}

/** ⋯ next to Check: Sign out… where SKAZ signs the agent out in its own folder; why not for Claude Code
 *  (this Mac's own sign-in); Hermes signs out per provider, so only Check again. */
function moreItems(agent: KbAgent): MenuItem[] {
  if (agent.id === 'hermes') return [{ id: 'check', label: 'Check again', icon: 'retry', onSelect: () => {} }];
  if (agent.id === 'claude_code') {
    return [{ id: 'signout', label: 'Sign out…', disabled: true, note: 'in Claude Code itself', onSelect: () => {} }];
  }
  return [{ id: 'signout', label: 'Sign out…', danger: true, onSelect: () => {} }];
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
      <div className="kb-inline-error kb-inline-error--flat" role="alert">
        Agents couldn’t be checked: {error} <Button size="sm" variant="quiet" icon="retry" onClick={() => void store.getState().refresh()}>Try again</Button>
      </div>
    ) : <p className="kb-muted" role="status">Checking agents…</p>;
  }
  return <ul className="kb-agentcards">{agents.agents.map((a) => <AgentCard key={a.id} agent={a} />)}</ul>;
}
