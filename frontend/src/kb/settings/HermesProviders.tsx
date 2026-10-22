import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  KbHermesCatalogItem, KbHermesCredential, KbHermesProvider, KbHermesProviders, KbHermesTerminal,
} from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Button, Icon, IconButton, Menu, Modal, type MenuItem } from '../ui';
import { ProviderIcon } from '../ui/ProviderIcon';
import { useAgents, useServices } from '../state/context';

/** While a Terminal window SKAZ opened is still running, the list is read again this often. */
export const TERMINAL_POLL_MS = 2_000;

type Tone = 'ok' | 'warn' | 'err';
type Group = KbHermesCatalogItem['group'];

/** What SKAZ opened Terminal for: the line while it runs and the one after it ends. */
interface Launch {
  kind: 'add' | 'key' | 'signin' | 'other' | 'order';
  provider: string | null;
  name: string;
  group?: Group;
  oauth?: boolean;
}

type Run = (key: string, call: () => Promise<KbHermesProviders>, launch?: Launch) => Promise<boolean>;

const GROUPS: ReadonlyArray<{ id: Group; tab: string; title: string; how: string }> = [
  { id: 'subscription', tab: 'Subscriptions', title: 'Subscriptions', how: 'sign in in the browser' },
  { id: 'api_key', tab: 'API keys', title: 'API keys', how: 'paste a key in Terminal' },
  { id: 'cloud', tab: 'Cloud', title: 'Cloud platforms', how: 'set up in Hermes' },
];

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function agoText(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const minutes = Math.floor((now - t) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

const credTone = (c: KbHermesCredential): Tone => (c.state === 'ready' ? 'ok' : c.state === 'limited' ? 'warn' : 'err');
const isKey = (c: KbHermesCredential) => c.auth_type !== 'oauth';

/** The dot of a chip: green ready, amber a limit (or some keys failing), red nothing works (needs sign-in). */
function poolTone(pool: KbHermesProvider): Tone {
  if (pool.credentials.length === 0) return 'ok';
  const tones = pool.credentials.map(credTone);
  if (tones.every((t) => t === 'ok')) return 'ok';
  if (tones.every((t) => t === 'err')) return 'err';
  return 'warn';
}

function poolStatus(pool: KbHermesProvider): string {
  const tone = poolTone(pool);
  if (tone === 'ok') return 'ready';
  if (tone === 'err') return pool.credentials.every(isKey) ? 'key not working' : 'needs sign-in';
  return pool.credentials.length > 1 ? 'some keys wait or fail' : 'at its limit';
}

/** The credential Hermes picks now (its "←"), else the first ready one. */
function inUse(pool: KbHermesProvider): KbHermesCredential | undefined {
  return pool.credentials.find((c) => c.current) ?? pool.credentials.find((c) => c.state === 'ready');
}

/** The provider Hermes uses instead of `pool` (the next one it tries that works). */
function insteadOf(pools: ReadonlyArray<KbHermesProvider>, pool: KbHermesProvider): string | null {
  const usable = pools.filter((p) => p.id !== pool.id
    && (p.free_tier !== null || p.credentials.some((c) => c.state === 'ready' || c.state === 'limited')));
  const next = [...usable].sort((a, b) => (a.order ?? 1e6) - (b.order ?? 1e6))[0];
  if (!next) return null;
  return next.order !== null ? `${next.name} (tried ${ordinal(next.order + 1)})` : next.name;
}

function terminalText(launch: Launch | null, terminal: KbHermesTerminal): string {
  if (!launch) return terminal.title;
  switch (launch.kind) {
    case 'add':
      return launch.group === 'cloud' ? `Choose ${launch.name} in Hermes’ setup there.`
        : launch.group === 'subscription' ? `Sign in to ${launch.name} in your browser — SKAZ never sees it.`
          : `Paste the ${launch.name} key there — SKAZ never sees it.`;
    case 'key':
      return `Paste the key for “${launch.name}” there — SKAZ never sees it.`;
    case 'signin':
      return launch.oauth ? `Sign in to ${launch.name} again in your browser.` : 'Paste the new key there — SKAZ never sees it.';
    case 'other':
      return 'Choose “Add a credential” there.';
    default:
      return 'Hermes shows its provider order there.';
  }
}

/** One line after Terminal ended, from what SKAZ opened it for and what Hermes lists now. */
function resultLine(launch: Launch | null, state: KbHermesTerminal['state'], pools: ReadonlyArray<KbHermesProvider>): { text: string; error: boolean } | null {
  if (state === 'failed') return { text: 'Hermes stopped before it finished in Terminal. Nothing changed.', error: true };
  if (!launch || launch.kind === 'order') return null;
  const pool = pools.find((p) => p.id === launch.provider);
  if (launch.kind === 'add') {
    if (!pool) return { text: `Terminal finished, but Hermes doesn’t list ${launch.name} yet.`, error: true };
    if (poolTone(pool) !== 'ok') return { text: `${pool.name} added, but it isn’t ready: ${poolStatus(pool)}.`, error: true };
    return { text: `${pool.name} added and ready.${pool.order !== null ? ` Hermes tries it ${ordinal(pool.order + 1)}.` : ''}`, error: false };
  }
  if (launch.kind === 'key') return { text: `Key “${launch.name}” added.`, error: false };
  if (launch.kind === 'signin') return { text: launch.oauth ? 'Signed in again.' : 'Key replaced.', error: false };
  return { text: 'Terminal finished. Hermes’ providers were read again.', error: false };
}

/** Reads the providers; re-reads while SKAZ's Terminal window runs and when the window gets focus. */
function useHermesProviders() {
  const { client } = useServices();
  const [value, setValue] = useState<KbHermesProviders | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(false);
  const read = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      setValue(await client.call('GET /kb/agents/hermes/providers'));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      reading.current = false;
    }
  }, [client]);
  useEffect(() => { void read(); }, [read]);
  const running = value?.terminal?.state === 'running';
  useEffect(() => {
    const onFocus = () => { void read(); };
    window.addEventListener('focus', onFocus);
    const id = running ? window.setInterval(() => { if (document.visibilityState === 'visible') void read(); }, TERMINAL_POLL_MS) : undefined;
    return () => { window.removeEventListener('focus', onFocus); if (id !== undefined) window.clearInterval(id); };
  }, [read, running]);
  return { value, setValue, error, read };
}

function TerminalLine({ launch, terminal }: { launch: Launch | null; terminal: KbHermesTerminal }) {
  return (
    <div className="kb-hproviders__terminal" role="status">
      <span className="kb-spinner kb-spinner--inline" aria-hidden="true" />
      <span><b>Finish in Terminal.</b> {terminalText(launch, terminal)} SKAZ checks as soon as Terminal finishes.</span>
    </div>
  );
}

/**
 * Hermes' providers in SKAZ's own Hermes folder, Accounts & keys v3 (confirmed 2026-10-21): one line of
 * chips without numbers — the dot is the status — and "Add provider" at the end. A chip opens the
 * provider's window (its sign-ins or keys, order, Check, Sign in again / Replace key, Remove); adding
 * and signing in open Hermes in Terminal: the key or the browser sign-in goes to Hermes, never SKAZ.
 */
export function HermesProviders() {
  const hermes = useAgents((s) => s.agents?.agents.find((a) => a.id === 'hermes'));
  const { agents, client } = useServices();
  const { value, setValue, error, read } = useHermesProviders();
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [windowError, setWindowError] = useState<string | null>(null);

  // A Terminal window that just finished: Hermes is checked again and one line says what happened.
  const terminalState = value?.terminal?.state;
  const previous = useRef(terminalState);
  useEffect(() => {
    if (previous.current === 'running' && terminalState && terminalState !== 'running') {
      void agents.getState().check('hermes');
      setMessage(resultLine(launch, terminalState, value?.providers ?? []));
    }
    previous.current = terminalState;
  }, [terminalState, agents, launch, value]);

  const run: Run = useCallback(async (key, call, next) => {
    setBusy(key);
    setMessage(null);
    setWindowError(null);
    try {
      setValue(await call());
      if (next) setLaunch(next);
      return true;
    } catch (e) {
      const text = errorText(e);
      setMessage({ text, error: true });
      setWindowError(text);
      void read();
      return false;
    } finally {
      setBusy(null);
    }
  }, [read, setValue]);

  if (!hermes || hermes.state === 'not_installed') return null;

  const pools = value?.providers ?? [];
  const ready = value?.state === 'ready';
  const terminal = value?.terminal ?? null;
  const running = terminal?.state === 'running' ? terminal : null;
  const pending = running && launch?.kind === 'add' && launch.provider && !pools.some((p) => p.id === launch.provider) ? launch : null;
  const open = pools.find((p) => p.id === openId) ?? null;

  return (
    <div className="kb-hproviders" data-testid="hermes-providers">
      <div className="kb-hchips">
        <span className="kb-hchips__label" aria-hidden="true">Providers</span>
        <ul className="kb-hchips__list" aria-label="Hermes providers">
          {pools.map((pool) => (
            <li key={pool.id}>
              <button type="button" className="kb-hchip" data-provider={pool.id} aria-label={`${pool.name} · ${poolStatus(pool)}`}
                title={`${pool.name} · ${poolStatus(pool)}`} onClick={() => { setWindowError(null); setOpenId(pool.id); }}>
                <ProviderIcon provider={pool.id} name={pool.name} size={16} />
                <span className="kb-hchip__name">{pool.name}</span>
                <span className="kb-hchip__dot" data-tone={poolTone(pool)} aria-hidden="true" />
              </button>
            </li>
          ))}
          {pending && (
            <li>
              <span className="kb-hchip" data-adding="true" data-provider={pending.provider ?? undefined}>
                <ProviderIcon provider={pending.provider ?? ''} name={pending.name} size={16} />
                <span className="kb-hchip__name">{pending.name}</span>
                <span className="kb-spinner kb-spinner--inline" aria-hidden="true" />
              </span>
            </li>
          )}
          <li>
            <button type="button" className="kb-hchip kb-hchip--add" disabled={!ready} onClick={() => setAdding(true)}>
              <Icon name="plus" size={13} />Add provider
            </button>
          </li>
        </ul>
      </div>
      {error && !value && (
        <p className="kb-inline-error kb-inline-error--flat" role="alert">
          {error} <Button size="sm" variant="quiet" icon="retry" onClick={() => void read()}>Try again</Button>
        </p>
      )}
      {!value && !error && <p className="kb-muted kb-hproviders__note" role="status">Reading Hermes’ providers…</p>}
      {value && value.state !== 'ready' && (
        <p className="kb-inline-error kb-inline-error--flat" role="alert">
          {value.reason} <Button size="sm" variant="quiet" icon="retry" onClick={() => void read()}>Try again</Button>
        </p>
      )}
      {ready && pools.length === 0 && !running && (
        <p className="kb-muted kb-hproviders__note">No providers yet. Add one: Hermes asks for the key or opens the sign-in page in Terminal.</p>
      )}
      {running && <TerminalLine launch={launch} terminal={running} />}
      {!running && message && (
        <p className={message.error ? 'kb-inline-error kb-inline-error--flat kb-hproviders__msg' : 'kb-hproviders__msg kb-hproviders__msg--ok'}
          role={message.error ? 'alert' : 'status'}>
          {!message.error && <Icon name="check" size={13} />}{message.text}
        </p>
      )}
      {open && value && (
        <ProviderWindow pool={open} pools={pools} value={value} launch={launch} busy={busy} run={run} read={read}
          error={windowError} onClose={() => setOpenId(null)} />
      )}
      <AddProviderModal open={adding} catalog={value?.catalog ?? []} checked={value?.catalog_checked ?? ''}
        added={new Set(pools.filter((p) => p.credentials.length > 0).map((p) => p.id))}
        onClose={() => setAdding(false)}
        onOpenAdded={(id) => { setAdding(false); setOpenId(id); }}
        onPick={(item) => {
          setAdding(false);
          void run(`add-${item.id}`, () => client.call('POST /kb/agents/hermes/providers/add', { body: { provider: item.id, group: item.group } }),
            { kind: 'add', provider: item.id, name: item.name, group: item.group });
        }}
        onOther={() => {
          setAdding(false);
          void run('other', () => client.call('POST /kb/agents/hermes/providers/other'), { kind: 'other', provider: null, name: '' });
        }} />
    </div>
  );
}

type Removing = { kind: 'provider' } | { kind: 'credential'; credential: KbHermesCredential };

/** A provider's own window (v3): its sign-ins or keys, order, Check, Sign in again / Replace key, Remove. */
function ProviderWindow({ pool, pools, value, launch, busy, run, read, error, onClose }: {
  pool: KbHermesProvider;
  pools: ReadonlyArray<KbHermesProvider>;
  value: KbHermesProviders;
  launch: Launch | null;
  busy: string | null;
  run: Run;
  read: () => Promise<void>;
  error: string | null;
  onClose: () => void;
}) {
  const { client } = useServices();
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [addingKey, setAddingKey] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const nameId = useId();
  const confirmId = useId();
  useEffect(() => { setNow(Date.now()); }, [value.read_at]);

  const creds = pool.credentials;
  const keysMode = creds.length > 1;
  const allKeys = creds.length > 0 && creds.every(isKey);
  const canAddKey = creds.some(isKey) || value.catalog.some((c) => c.id === pool.id && c.group === 'api_key');
  const ordered = pools.filter((p) => p.order !== null).length;
  const place = pool.order !== null ? ordinal(pool.order + 1) : null;
  const instead = insteadOf(pools, pool);
  const terminal = value.terminal?.state === 'running' && value.terminal.provider === pool.id ? value.terminal : null;
  const first = creds[0];
  const using = inUse(pool);
  const subtitle = keysMode ? (allKeys ? 'Hermes provider · API keys' : 'Hermes provider · sign-ins')
    : place ? `Hermes provider · tried ${place} of ${ordered}` : 'Hermes provider · not in Hermes’ order';

  const signInAgain = (c: KbHermesCredential) => run(`signin-${c.id}`,
    () => client.call('POST /kb/agents/hermes/providers/{provider}/credentials/{credential_id}/sign-in', { path: { provider: pool.id, credential_id: c.id } }),
    { kind: 'signin', provider: pool.id, name: pool.name, oauth: !isKey(c) });
  const useKey = (c: KbHermesCredential) => run(`use-${c.id}`,
    () => client.call('POST /kb/agents/hermes/providers/{provider}/credentials/{credential_id}/priority', { path: { provider: pool.id, credential_id: c.id }, body: { priority: 0 } }));
  const openOrder = () => run('order', () => client.call('POST /kb/agents/hermes/providers/order'), { kind: 'order', provider: null, name: '' });
  const addKey = async () => {
    const label = keyName.trim();
    if (!label) return;
    const ok = await run(`key-${pool.id}`, () => client.call('POST /kb/agents/hermes/providers/{provider}/keys', { path: { provider: pool.id }, body: { label } }),
      { kind: 'key', provider: pool.id, name: label });
    if (ok) { setAddingKey(false); setKeyName(''); }
  };
  const remove = async () => {
    if (!removing) return;
    if (removing.kind === 'provider') {
      const ok = await run(`remove-${pool.id}`, () => client.call('DELETE /kb/agents/hermes/providers/{provider}', { path: { provider: pool.id } }));
      if (ok) onClose();
    } else {
      const { credential } = removing;
      const ok = await run(`remove-${credential.id}`, () => client.call('DELETE /kb/agents/hermes/providers/{provider}/credentials/{credential_id}',
        { path: { provider: pool.id, credential_id: credential.id } }));
      if (ok) setRemoving(null);
    }
  };

  // What the user loses, and what Hermes does instead.
  const then = instead ? `Chats on Hermes then use ${instead}.` : 'Hermes then has no other provider, so chats on Hermes stop until you add one.';
  let confirmTitle = '';
  let confirmText = '';
  if (removing?.kind === 'provider') {
    confirmTitle = `Remove ${pool.name} from Hermes?`;
    const what = creds.length > 1 ? `its ${creds.length} ${allKeys ? 'keys' : 'sign-ins'}` : first && isKey(first) ? 'this key' : 'this sign-in';
    const kept = allKeys ? `The ${creds.length > 1 ? 'keys themselves still work' : 'key itself still works'} at ${pool.name}.`
      : `Your ${pool.name} account itself is not changed.`;
    confirmText = `Hermes forgets ${what}. ${then} ${kept}`;
  } else if (removing?.kind === 'credential') {
    const c = removing.credential;
    confirmTitle = `Remove the ${isKey(c) ? 'key' : 'sign-in'} “${c.label}” from Hermes?`;
    const other = creds.find((x) => x.id !== c.id && x.current) ?? creds.find((x) => x.id !== c.id && x.state === 'ready');
    confirmText = other ? `Hermes forgets it. ${pool.name} keeps using “${other.label}”.`
      : `Hermes forgets it, and ${pool.name} has no other working ${isKey(c) ? 'key' : 'sign-in'}. ${then}`;
  }

  // An expired sign-in or a dead key on top: what Hermes does meanwhile.
  let warn: string | null = null;
  if (creds.length > 0 && creds.every((c) => credTone(c) !== 'ok')) {
    const meanwhile = instead ? `uses ${instead.replace(/ \(tried .*\)$/, '')}` : 'has no other provider to use';
    if (creds.every((c) => c.state === 'limited')) {
      const until = creds.map((c) => c.until).filter(Boolean).sort()[0];
      warn = `${pool.name} is at its limit${until ? ` until ${hhmm(until)}` : ''}. Hermes ${meanwhile} meanwhile.`;
    } else if (allKeys) {
      warn = `The key stopped working. Hermes skips ${pool.name} and ${meanwhile} until you replace it.`;
    } else {
      warn = `The sign-in has expired. Hermes skips ${pool.name} and ${meanwhile} until you sign in again.`;
    }
  }

  return (
    <Modal open onClose={onClose} title={pool.name} bare className={`kb-pwin${keysMode ? ' kb-pwin--keys' : ''}`} testId="provider-window">
      <header className="kb-modal__head kb-pwin__head">
        <span className="kb-pwin__tile"><ProviderIcon provider={pool.id} name={pool.name} size={20} /></span>
        <div className="kb-pwin__titles">
          <b className="kb-pwin__name">{pool.name}</b>
          <span className="kb-pwin__sub">{subtitle}</span>
        </div>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </header>
      <div className="kb-pwin__body">
        {warn && !removing && <p className="kb-pwin__warn" role="note"><Icon name="warning" size={13} />{warn}</p>}
        {pool.free_tier && creds.length === 0 && (
          <div className="kb-pwin__box"><div className="kb-pwin__cred"><div className="kb-pwin__credtext"><b>{pool.free_tier}</b><small>Hermes’ free tier — not something you added</small></div></div></div>
        )}
        {creds.length > 0 && !keysMode && first && (
          <div className="kb-pwin__box">
            <div className="kb-pwin__cred" data-credential={first.id}>
              <div className="kb-pwin__credtext">
                <b title={first.label}>{first.label}</b>
                <small>{isKey(first) ? 'API key' : `${pool.name} account · sign-in`}</small>
              </div>
              <CredStatus c={first} />
            </div>
          </div>
        )}
        {keysMode && (
          <div className="kb-pwin__box" role="radiogroup" aria-label={allKeys ? 'Key in use' : 'Sign-in in use'}>
            {creds.map((c) => (
              <KeyRow key={c.id} pool={pool} c={c} using={using?.id === c.id} busy={busy}
                onUse={() => void useKey(c)} onReplace={() => void signInAgain(c)}
                onRemove={() => setRemoving({ kind: 'credential', credential: c })} />
            ))}
          </div>
        )}
        {canAddKey && !addingKey && creds.length > 0 && (
          <Button size="sm" variant="quiet" icon="plus" className="kb-pwin__addbtn" onClick={() => setAddingKey(true)}>Add another key…</Button>
        )}
        {addingKey && (
          <form className="kb-pwin__addkey" onSubmit={(e) => { e.preventDefault(); void addKey(); }}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setAddingKey(false); setKeyName(''); } }}>
            <div className="kb-pwin__field">
              <label htmlFor={nameId}>Name</label>
              <input id={nameId} className="kb-pwin__input" value={keyName} maxLength={40} autoFocus placeholder="Team"
                onChange={(e) => setKeyName(e.target.value)} />
            </div>
            <div className="kb-pwin__field">
              <span>Key</span>
              <span className="kb-pwin__input kb-pwin__input--ph">Paste it in Terminal — SKAZ never sees it</span>
            </div>
            <div className="kb-pwin__formfoot">
              <Button size="sm" variant="quiet" onClick={() => { setAddingKey(false); setKeyName(''); }}>Cancel</Button>
              <Button size="sm" variant="fill" icon="terminal" type="submit" disabled={!keyName.trim()} busy={busy === `key-${pool.id}`}>Add in Terminal…</Button>
            </div>
          </form>
        )}
        {keysMode && allKeys && (
          <p className="kb-pwin__note">Hermes uses the chosen key first. When it hits its limit or stops working, Hermes moves to the next ready key by itself and comes back later.</p>
        )}
        {terminal && <TerminalLine launch={launch} terminal={terminal} />}
        <dl className="kb-pwin__facts">
          <dt>Order</dt>
          <dd>
            {place ? <span>Tried {place}</span> : <span>Not in Hermes’ order yet</span>}
            {(pool.order === null || ordered > 1) && (
              <>
                {' · '}
                <button type="button" className="kb-linkbtn" disabled={busy === 'order'} onClick={() => void openOrder()}>
                  {pool.order === null ? 'Set the order…' : pool.order === 0 ? 'Try it later' : 'Try it earlier'}
                </button>
              </>
            )}
          </dd>
          <dt>Checked</dt>
          <dd>{agoText(value.read_at, now)}</dd>
        </dl>
        {removing && (
          <div className="kb-pwin__confirm" role="group" aria-labelledby={confirmId}>
            <b id={confirmId}>{confirmTitle}</b>
            <p>{confirmText}</p>
            <div className="kb-pwin__formfoot">
              <Button size="sm" onClick={() => setRemoving(null)}>Cancel</Button>
              <Button size="sm" variant="danger" icon="trash" busy={busy?.startsWith('remove-') ?? false} onClick={() => void remove()}>Remove</Button>
            </div>
          </div>
        )}
        {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
      </div>
      <footer className="kb-modal__foot kb-pwin__foot">
        {creds.length > 0 && (
          <Button size="sm" variant="danger" icon="trash" onClick={() => setRemoving({ kind: 'provider' })}>
            {keysMode ? 'Remove provider…' : 'Remove…'}
          </Button>
        )}
        <span className="kb-head__spacer" />
        <Button size="sm" variant="quiet" icon="retry" busy={checking}
          onClick={async () => { setChecking(true); await read(); setChecking(false); }}>Check</Button>
        {!keysMode && first && (
          <Button size="sm" variant={credTone(first) === 'err' ? 'fill' : 'outline'} icon={isKey(first) ? 'key' : 'signIn'}
            busy={busy === `signin-${first.id}`} onClick={() => void signInAgain(first)}>
            {isKey(first) ? 'Replace key…' : 'Sign in again…'}
          </Button>
        )}
      </footer>
    </Modal>
  );
}

function CredStatus({ c }: { c: KbHermesCredential }) {
  const tone = credTone(c);
  const text = c.state === 'ready' ? 'Ready' : c.state === 'limited' ? (c.until ? `Limit until ${hhmm(c.until)}` : 'Limit reached')
    : c.state === 'signed_out' ? 'Signed out' : 'Not working';
  return (
    <span className={`kb-status kb-status--${tone}`} title={c.detail ?? undefined}>
      <Icon name={tone === 'ok' ? 'check' : 'warning'} size={13} />{text}
    </span>
  );
}

/** One of several keys: the radio marks the one in use; ⋯ has Replace key… / Sign in again… and Remove. */
function KeyRow({ pool, c, using, busy, onUse, onReplace, onRemove }: {
  pool: KbHermesProvider;
  c: KbHermesCredential;
  using: boolean;
  busy: string | null;
  onUse: () => void;
  onReplace: () => void;
  onRemove: () => void;
}) {
  const more = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const usable = c.state === 'ready';
  const sub = using ? 'New requests go here' : c.state === 'limited' ? 'Waits — limit reached' : usable ? 'Ready' : `Rejected by ${pool.name}`;
  const items: MenuItem[] = [
    { id: 'replace', label: isKey(c) ? 'Replace key…' : 'Sign in again…', icon: isKey(c) ? 'key' : 'signIn', onSelect: onReplace },
    { id: 'remove', label: 'Remove…', icon: 'trash', danger: true, onSelect: onRemove },
  ];
  return (
    <div className={`kb-krow${using ? ' is-using' : ''}`} data-credential={c.id} data-state={c.state}>
      <button type="button" role="radio" aria-checked={using} className="kb-krow__radio" aria-label={c.label}
        aria-disabled={!usable || undefined} disabled={busy === `use-${c.id}`}
        onClick={() => { if (usable && !using) onUse(); }} />
      <div className="kb-pwin__credtext">
        <b title={c.label}>{c.label}</b>
        <small>{sub}</small>
      </div>
      {using ? <span className="kb-status kb-status--ok"><Icon name="check" size={13} />In use</span>
        : c.state === 'limited' ? <CredStatus c={c} />
          : usable ? <Button size="sm" variant="quiet" busy={busy === `use-${c.id}`} onClick={onUse}>Use this key</Button>
            : <span className="kb-status kb-status--err" title={c.detail ?? undefined}><Icon name="warning" size={13} />Not working</span>}
      <IconButton ref={more} icon="more" size="sm" label={`More for ${c.label}`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)} />
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={more} label={`${pool.name} · ${c.label}`}
        items={items.map((item) => ({ ...item, onSelect: () => { setOpen(false); item.onSelect(); } }))} />
    </div>
  );
}

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** "Add provider" (v3): Hermes' whole catalogue in a grid by how it connects, tabs and search; ✓ on added ones. */
export function AddProviderModal({ open, catalog, checked, added, onClose, onPick, onOpenAdded, onOther }: {
  open: boolean;
  catalog: ReadonlyArray<KbHermesCatalogItem>;
  checked: string;
  added: ReadonlySet<string>;
  onClose: () => void;
  onPick: (item: KbHermesCatalogItem) => void;
  onOpenAdded: (provider: string) => void;
  onOther: () => void;
}) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Group | 'all'>('all');
  const search = useRef<HTMLInputElement | null>(null);
  const id = useId();
  useEffect(() => { if (!open) { setQuery(''); setTab('all'); } }, [open]);
  const groups = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    const shown = catalog.filter((item) => (tab === 'all' || item.group === tab)
      && words.every((w) => fold(`${item.name} ${item.id} ${item.keywords}`).includes(w)));
    return GROUPS.map((g) => ({ ...g, items: shown.filter((item) => item.group === g.id) })).filter((g) => g.items.length > 0);
  }, [catalog, query, tab]);
  return (
    <Modal open={open} onClose={onClose} title="Add a provider to Hermes" bare className="kb-addprovider" testId="add-provider" initialFocusRef={search}>
      <header className="kb-modal__head kb-pwin__head">
        <div className="kb-pwin__titles">
          <b className="kb-pwin__name">Add a provider to Hermes</b>
          <span className="kb-pwin__sub">Pick one: SKAZ opens Hermes in Terminal; you sign in or paste the key there. SKAZ never sees it.</span>
        </div>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </header>
      <div className="kb-addprovider__body">
        <div className="kb-settings__search kb-addprovider__search">
          <Icon name="search" size={14} />
          <label className="kb-visually-hidden" htmlFor={`${id}-q`}>Find a provider</label>
          <input id={`${id}-q`} ref={search} type="search" placeholder={`Find a provider — ${catalog.length} in Hermes`} value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); } }} />
        </div>
        <div className="kb-addprovider__tabs" role="group" aria-label="Show">
          {([['all', 'All'], ...GROUPS.map((g) => [g.id, g.tab])] as Array<[Group | 'all', string]>).map(([value, label]) => (
            <button key={value} type="button" className="kb-addprovider__tab" aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>
          ))}
        </div>
        <div className="kb-addprovider__list">
          {groups.length === 0 && <p className="kb-muted">No provider matches “{query.trim()}”. Try “Other provider…”.</p>}
          {groups.map((g) => (
            <section key={g.id} className="kb-addprovider__group" aria-label={g.title}>
              <h4 className="kb-addprovider__gtitle">{g.title} <em>· {g.how} · {g.items.length}</em></h4>
              <ul className="kb-addprovider__grid">
                {g.items.map((item) => {
                  const has = added.has(item.id);
                  return (
                    <li key={`${item.group}-${item.id}`}>
                      <button type="button" className={`kb-addprovider__item${has ? ' is-added' : ''}`} title={item.name}
                        data-provider={item.id} data-group={item.group} aria-label={has ? `${item.name}, added` : item.name}
                        onClick={() => (has ? onOpenAdded(item.id) : onPick(item))}>
                        <ProviderIcon provider={item.id} name={item.name} size={16} />
                        <span className="kb-addprovider__name">{item.name}</span>
                        {has && <Icon name="check" size={13} className="kb-addprovider__added" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
      <footer className="kb-modal__foot kb-addprovider__foot">
        <Button size="sm" variant="quiet" icon="terminal" onClick={onOther}>Other provider…</Button>
        {checked && <span className="kb-muted kb-addprovider__checked" title={`List checked with ${checked}`}>List checked with {checked}</span>}
      </footer>
    </Modal>
  );
}
