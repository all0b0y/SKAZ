import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  KbHermesCatalogItem, KbHermesCredential, KbHermesProvider, KbHermesProviders,
} from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Button, Icon, IconButton, Menu, Modal, type MenuItem } from '../ui';
import { ProviderIcon } from '../ui/ProviderIcon';
import { useAgents, useServices } from '../state/context';

/** While a Terminal window SKAZ opened is still running, the list is read again this often. */
export const TERMINAL_POLL_MS = 2_000;

const GROUP_TITLE: Record<KbHermesCatalogItem['group'], string> = {
  subscription: 'Subscriptions · sign in in the browser',
  api_key: 'API keys',
  cloud: 'Cloud platforms · set up in Hermes',
};

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function stateText(c: KbHermesCredential): { tone: 'ok' | 'warn' | 'err'; text: string } {
  if (c.state === 'ready') return { tone: 'ok', text: 'Ready' };
  if (c.state === 'limited') return { tone: 'warn', text: c.until ? `Limit until ${hhmm(c.until)}` : 'Limit reached' };
  if (c.state === 'signed_out') return { tone: 'err', text: 'Signed out' };
  return { tone: 'err', text: c.detail ? `Not working · ${c.detail}` : 'Not working' };
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

/**
 * Hermes' providers in SKAZ's own Hermes folder (0.3.1 K1/K3, decisions Q2/Q3/Q13): numbered in the
 * order Hermes tries them (main, then its fallback chain), each credential with its state and a ⋯
 * menu (move, sign in again, remove). Adding and signing in again open Hermes in Terminal: the key or
 * the browser sign-in goes to Hermes, never through SKAZ.
 */
export function HermesProviders() {
  const hermes = useAgents((s) => s.agents?.agents.find((a) => a.id === 'hermes'));
  const { agents } = useServices();
  const { value, setValue, error, read } = useHermesProviders();
  const { client } = useServices();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [removing, setRemoving] = useState<{ pool: KbHermesProvider; credential: KbHermesCredential } | null>(null);

  // A Terminal window that just finished: the agent's own state may have changed (a provider now set up).
  const terminalState = value?.terminal?.state;
  const previous = useRef(terminalState);
  useEffect(() => {
    if (previous.current === 'running' && terminalState && terminalState !== 'running') void agents.getState().check('hermes');
    previous.current = terminalState;
  }, [terminalState, agents]);

  if (!hermes || hermes.state === 'not_installed') return null;

  const run = async (key: string, call: () => Promise<KbHermesProviders>, done?: string) => {
    setBusy(key);
    setMessage(null);
    try {
      setValue(await call());
      if (done) setMessage({ text: done, error: false });
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
      void read();
    } finally {
      setBusy(null);
    }
  };

  const pools = value?.providers ?? [];
  const ordered = pools.filter((p) => p.order !== null);
  const others = pools.filter((p) => p.order === null);
  const terminal = value?.terminal;

  return (
    <div className="kb-hproviders" data-testid="hermes-providers">
      <div className="kb-hproviders__head">
        <span className="kb-hproviders__title">Providers</span>
        <span className="kb-muted kb-hproviders__sub">in the order Hermes tries them · keys and sign-ins stay in Hermes</span>
        <span className="kb-head__spacer" />
        <Button size="sm" variant="quiet" icon="arrows" busy={busy === 'order'} disabled={!value || value.state !== 'ready'}
          onClick={() => void run('order', () => client.call('POST /kb/agents/hermes/providers/order'),
            'Terminal opened with Hermes’ fallback providers. Change the order there.')}>Change order…</Button>
        <Button size="sm" icon="plus" disabled={!value || value.state !== 'ready'} onClick={() => setAdding(true)}>Add provider…</Button>
      </div>
      {error && !value && (
        <p className="kb-inline-error kb-inline-error--flat" role="alert">
          {error} <Button size="sm" variant="quiet" icon="retry" onClick={() => void read()}>Try again</Button>
        </p>
      )}
      {!value && !error && <p className="kb-muted" role="status">Reading Hermes’ providers…</p>}
      {value && value.state !== 'ready' && (
        <p className="kb-inline-error kb-inline-error--flat" role="alert">
          {value.reason} <Button size="sm" variant="quiet" icon="retry" onClick={() => void read()}>Try again</Button>
        </p>
      )}
      {terminal && terminal.state === 'running' && (
        <div className="kb-hproviders__terminal" role="status">
          <span className="kb-spinner kb-spinner--inline" aria-hidden="true" />
          <span><b>Finish in Terminal.</b> {terminal.title}</span>
          <Button size="sm" variant="quiet" onClick={() => void read()}>Check now</Button>
        </div>
      )}
      {terminal && terminal.state === 'failed' && (
        <p className="kb-agentcard__msg" role="status">Hermes stopped before it finished in Terminal. Nothing changed unless the list says so.</p>
      )}
      {value?.state === 'ready' && pools.length === 0 && (
        <p className="kb-muted kb-hproviders__empty">No providers yet. Add one: Hermes asks for the key or opens the sign-in page in Terminal.</p>
      )}
      {(ordered.length > 0 || others.length > 0) && (
        <ol className="kb-hproviders__list">
          {ordered.map((pool) => (
            <ProviderBlock key={pool.id} pool={pool} number={pool.order! + 1} busy={busy}
              onRun={run} onRemove={(credential) => setRemoving({ pool, credential })} />
          ))}
          {others.map((pool) => (
            <ProviderBlock key={pool.id} pool={pool} number={null} busy={busy}
              onRun={run} onRemove={(credential) => setRemoving({ pool, credential })} />
          ))}
        </ol>
      )}
      {others.length > 0 && ordered.length > 0 && (
        <p className="kb-muted kb-hproviders__note">Unnumbered providers aren’t in Hermes’ order yet: Hermes uses them when its setup chooses them.</p>
      )}
      {message && (
        <p className={message.error ? 'kb-inline-error kb-inline-error--flat' : 'kb-agentcard__msg'} role={message.error ? 'alert' : 'status'}>{message.text}</p>
      )}
      <AddProviderModal open={adding} catalog={value?.catalog ?? []} checked={value?.catalog_checked ?? ''}
        onClose={() => setAdding(false)}
        onPick={(item) => {
          setAdding(false);
          void run(`add-${item.id}`, () => client.call('POST /kb/agents/hermes/providers/add', { body: { provider: item.id, group: item.group } }),
            item.group === 'cloud' ? `Terminal opened with the Hermes setup. Choose ${item.name} there.`
              : item.group === 'subscription' ? `Terminal opened with Hermes. Finish signing in to ${item.name} in your browser.`
                : `Terminal opened with Hermes. Paste the ${item.name} key there — SKAZ never sees it.`);
        }}
        onOther={() => {
          setAdding(false);
          void run('other', () => client.call('POST /kb/agents/hermes/providers/other'),
            'Terminal opened with Hermes’ credential manager. Choose “Add a credential” there.');
        }} />
      <Modal open={removing !== null} onClose={() => setRemoving(null)} title="Remove this credential from Hermes?" className="kb-confirm" testId="confirm-remove-credential">
        {removing && (
          <>
            <div className="kb-confirm__body">
            <p>
              Hermes forgets <b>{removing.credential.label}</b> ({removing.credential.auth_type === 'oauth' ? 'sign-in' : 'API key'}) for {removing.pool.name}.
              {removing.pool.credentials.length === 1 ? ' It is this provider’s only credential: Hermes can’t use the provider until you add it again.' : ''}
            </p>
            </div>
            <footer className="kb-confirm__foot">
              <Button onClick={() => setRemoving(null)}>Cancel</Button>
              <Button variant="danger" busy={busy === `remove-${removing.credential.id}`} onClick={async () => {
                const { pool, credential } = removing;
                await run(`remove-${credential.id}`, () => client.call('DELETE /kb/agents/hermes/providers/{provider}/credentials/{credential_id}',
                  { path: { provider: pool.id, credential_id: credential.id } }), `Removed ${credential.label} from Hermes.`);
                setRemoving(null);
              }}>Remove</Button>
            </footer>
          </>
        )}
      </Modal>
    </div>
  );
}

function ProviderBlock({ pool, number, busy, onRun, onRemove }: {
  pool: KbHermesProvider;
  number: number | null;
  busy: string | null;
  onRun: (key: string, call: () => Promise<KbHermesProviders>, done?: string) => Promise<void>;
  onRemove: (credential: KbHermesCredential) => void;
}) {
  return (
    <li className="kb-hprovider" data-provider={pool.id}>
      <div className="kb-hprovider__head">
        <span className="kb-hprovider__num" aria-label={number ? `Tried ${number === 1 ? 'first' : `${number}th`}` : 'Not in Hermes’ order'}>{number ?? '·'}</span>
        <ProviderIcon provider={pool.id} name={pool.name} size={18} />
        <b className="kb-hprovider__name">{pool.name}</b>
        {number === 1 && <span className="kb-tag kb-tag--static">Main</span>}
      </div>
      {pool.free_tier && <div className="kb-hcred kb-muted"><span className="kb-hcred__label">{pool.free_tier}</span></div>}
      {pool.credentials.length > 0 && (
        <ul className="kb-hcreds">
          {pool.credentials.map((c) => (
            <CredentialRow key={c.id} pool={pool} credential={c} busy={busy} onRun={onRun} onRemove={() => onRemove(c)} />
          ))}
        </ul>
      )}
    </li>
  );
}

function CredentialRow({ pool, credential: c, busy, onRun, onRemove }: {
  pool: KbHermesProvider;
  credential: KbHermesCredential;
  busy: string | null;
  onRun: (key: string, call: () => Promise<KbHermesProviders>, done?: string) => Promise<void>;
  onRemove: () => void;
}) {
  const { client } = useServices();
  const more = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const status = stateText(c);
  const last = pool.credentials.length - 1;
  const place = pool.credentials.indexOf(c);
  const move = (to: number) => onRun(`move-${c.id}`, () => client.call('POST /kb/agents/hermes/providers/{provider}/credentials/{credential_id}/priority',
    { path: { provider: pool.id, credential_id: c.id }, body: { priority: to } }));
  const signIn = () => onRun(`signin-${c.id}`, () => client.call('POST /kb/agents/hermes/providers/{provider}/credentials/{credential_id}/sign-in',
    { path: { provider: pool.id, credential_id: c.id } }),
  `Terminal opened with Hermes. ${c.auth_type === 'oauth' ? 'Finish signing in in your browser' : 'Paste the new key there'}; the old one is removed after that.`);
  const items: MenuItem[] = [
    { id: 'up', label: 'Move up', icon: 'chevronUp', disabled: place <= 0, onSelect: () => void move(place - 1) },
    { id: 'down', label: 'Move down', icon: 'chevronDown', disabled: place >= last, onSelect: () => void move(place + 1) },
    { id: 'signin', label: 'Sign in again…', icon: 'signIn', onSelect: () => void signIn() },
    { id: 'remove', label: 'Remove…', icon: 'trash', danger: true, onSelect: onRemove },
  ];
  return (
    <li className="kb-hcred" data-credential={c.id} data-state={c.state}>
      <span className="kb-hcred__label" title={c.label}>{pool.credentials.length > 1 ? `${c.index}. ` : ''}{c.label}</span>
      <span className="kb-muted kb-hcred__type">{c.auth_type === 'oauth' ? 'Sign-in' : 'API key'}{c.current && pool.credentials.length > 1 ? ' · next' : ''}</span>
      <span className="kb-head__spacer" />
      <span className={`kb-status kb-status--${status.tone}`} title={c.detail ?? undefined}>
        <Icon name={status.tone === 'ok' ? 'check' : status.tone === 'err' ? 'error' : 'clock'} size={13} />{status.text}
      </span>
      {c.state === 'signed_out' && (
        <Button size="sm" variant="fill" busy={busy === `signin-${c.id}`} onClick={() => void signIn()}>Sign in again</Button>
      )}
      <IconButton ref={more} icon="more" size="sm" label={`More for ${c.label}`} aria-haspopup="menu" aria-expanded={open}
        disabled={busy === `move-${c.id}`} onClick={() => setOpen((v) => !v)} />
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={more} label={`${pool.name} · ${c.label}`}
        items={items.map((item) => ({ ...item, onSelect: () => { setOpen(false); item.onSelect(); } }))} />
    </li>
  );
}

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** "Add provider…" (K3): search over Hermes' providers, grouped by how they connect. */
export function AddProviderModal({ open, catalog, checked, onClose, onPick, onOther }: {
  open: boolean;
  catalog: ReadonlyArray<KbHermesCatalogItem>;
  checked: string;
  onClose: () => void;
  onPick: (item: KbHermesCatalogItem) => void;
  onOther: () => void;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement | null>(null);
  const id = useId();
  useEffect(() => { if (!open) setQuery(''); }, [open]);
  const groups = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    const shown = catalog.filter((item) => words.every((w) => fold(`${item.name} ${item.id} ${item.keywords}`).includes(w)));
    return (['subscription', 'api_key', 'cloud'] as const)
      .map((group) => ({ group, items: shown.filter((item) => item.group === group) }))
      .filter((g) => g.items.length > 0);
  }, [catalog, query]);
  return (
    <Modal open={open} onClose={onClose} title="Add a provider to Hermes" className="kb-addprovider" testId="add-provider" initialFocusRef={search}>
      <p className="kb-muted kb-addprovider__intro">
        SKAZ opens Hermes in Terminal for the provider you pick. You sign in or paste the key there; SKAZ never sees it.
      </p>
      <div className="kb-settings__search kb-addprovider__search">
        <Icon name="search" size={14} />
        <label className="kb-visually-hidden" htmlFor={`${id}-q`}>Find a provider</label>
        <input id={`${id}-q`} ref={search} type="search" placeholder="Find a provider" value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); } }} />
      </div>
      <div className="kb-addprovider__list">
        {groups.length === 0 && <p className="kb-muted">No provider matches “{query.trim()}”. Try “Other provider…”.</p>}
        {groups.map((g) => (
          <section key={g.group} className="kb-addprovider__group" aria-label={GROUP_TITLE[g.group]}>
            <h4 className="kb-sgroup__title">{GROUP_TITLE[g.group]}</h4>
            <ul>
              {g.items.map((item) => (
                <li key={`${item.group}-${item.id}`}>
                  <button type="button" className="kb-row kb-addprovider__item" onClick={() => onPick(item)} data-provider={item.id} data-group={item.group}>
                    <ProviderIcon provider={item.id} name={item.name} size={18} />
                    <span className="kb-row__text">{item.name}</span>
                    <Icon name={item.group === 'subscription' ? 'signIn' : item.group === 'cloud' ? 'terminal' : 'key'} size={14} className="kb-muted" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="kb-addprovider__foot">
        <Button size="sm" variant="quiet" icon="terminal" onClick={onOther}>Other provider…</Button>
        <span className="kb-head__spacer" />
        {checked && <span className="kb-muted kb-addprovider__checked">List checked {checked}</span>}
      </div>
    </Modal>
  );
}
