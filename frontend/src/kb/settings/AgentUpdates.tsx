import { useEffect, useState } from 'react';
import type { EngineId } from '../api/names';
import { Button, Icon, Switch } from '../ui';
import { useAgentUpdates, useServices } from '../state/context';
import { updateOf } from '../state/agentUpdates';
import { relativeTime } from '../document/text';
import { StippleRing } from '../fx/stipple/StippleWork';

/**
 * U1 on an agent's card (Settings → Accounts & keys): "Update available · X → Y" with what the update
 * touches (this whole Mac, Terminal included), **Update** (or "Update after current work" while the
 * agent is busy) and **Skip this version**; while it waits: Cancel; after a failed update: the reason,
 * the command's output, the exact Terminal command and Roll back (or how to roll back by hand).
 * The running update's log is the card's own install log.
 */
export function AgentUpdateOffer({ engine }: { engine: EngineId }) {
  const { agentUpdates, agents } = useServices();
  const update = useAgentUpdates((s) => updateOf(s.view, engine));
  const pending = useAgentUpdates((s) => s.pending[engine]);
  const [error, setError] = useState<string | null>(null);
  if (!update) return null;
  const run = async (what: 'update' | 'skip' | 'cancel' | 'rollback') => {
    setError(null);
    const s = agentUpdates.getState();
    const r = what === 'update' ? await s.update(engine)
      : what === 'skip' ? await s.skip(engine, update.latest ?? '')
        : what === 'cancel' ? await s.cancel(engine) : await s.rollback(engine);
    if (!r.ok) setError(r.error);
    else if (what === 'update' || what === 'rollback') agents.getState().showInstall(engine, 'update');
  };
  const failure = update.phase === 'idle' ? update.failure : null;
  const offer = update.available && update.phase === 'idle';
  if (!offer && !failure && update.phase === 'idle') return null;
  return (
    <div className="kb-agentupdate" data-testid={`agent-update-${engine}`}>
      {update.phase === 'queued' && (
        <p className="kb-agentcard__msg" role="status">
          <StippleRing className="kb-spinner kb-spinner--inline" />
          Updates after current work. New answers from {update.name} wait meanwhile.{' '}
          <Button size="sm" variant="quiet" onClick={() => agents.getState().showInstall(engine, 'update')}>Details</Button>
          <Button size="sm" variant="quiet" busy={pending === 'cancel'} onClick={() => void run('cancel')}>Cancel</Button>
        </p>
      )}
      {update.phase === 'updating' && (
        // Until the card's own install log takes over (it follows the task once the backend started it).
        <p className="kb-agentcard__msg" role="status">
          <StippleRing className="kb-spinner kb-spinner--inline" />
          {update.action === 'rollback' ? 'Rolling back…' : 'Updating…'} New answers from {update.name} wait meanwhile.
          <Button size="sm" variant="quiet" onClick={() => agents.getState().showInstall(engine, 'update')}>Details</Button>
        </p>
      )}
      {failure && (
        <div className="kb-agentupdate__failure">
          <p className="kb-inline-error kb-inline-error--flat" role="alert">{failure.reason}</p>
          <Button size="sm" variant="quiet" onClick={() => agents.getState().showInstall(engine, 'update')}>Details</Button>
        </div>
      )}
      {offer && (
        <>
          <p className="kb-agentupdate__offer" role="status">
            <Icon name="ready" size={13} />Update available · {update.installed} → {update.latest}
          </p>
          <p className="kb-agentcard__note">
            {update.note}{update.services_note ? ` ${update.services_note}` : ''}
          </p>
          <span className="kb-agentupdate__acts">
            <Button size="sm" variant="fill" busy={pending === 'update'} onClick={() => void run('update')}>
              {update.busy ? 'Update after current work' : 'Update'}
            </Button>
            <Button size="sm" variant="quiet" busy={pending === 'skip'} onClick={() => void run('skip')}>Skip this version</Button>
          </span>
        </>
      )}
      {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
    </div>
  );
}

/**
 * Settings → Accounts & keys → "Check for agent updates automatically" (U1 decision 9): one switch for
 * every agent (off: no background requests), "Last checked: …" and **Check for updates**. Opening
 * this section counts as having seen the offers (the dot goes).
 */
export function AgentUpdatesRow({ label }: { label: string }) {
  const { agentUpdates } = useServices();
  const view = useAgentUpdates((s) => s.view);
  const checking = useAgentUpdates((s) => s.checking || !!s.view?.checking);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    const stop = agentUpdates.getState().start();
    void agentUpdates.getState().load(); // fresh offers and "busy" each time the section opens
    return stop;
  }, [agentUpdates]);
  useEffect(() => { if (view?.unseen) void agentUpdates.getState().markSeen(); }, [agentUpdates, view?.unseen]);
  if (!view) return <span className="kb-muted" role="status">Reading…</span>;
  const check = async () => {
    setMessage(null);
    const r = await agentUpdates.getState().checkNow();
    if (!r.ok) { setMessage({ text: r.error, error: true }); return; }
    const found = agentUpdates.getState().view?.agents.filter((a) => a.available) ?? [];
    setMessage({ text: found.length ? `Update available for ${found.map((a) => a.name).join(', ')}.` : 'All installed agents are up to date.', error: false });
  };
  return (
    <span className="kb-agentupdates">
      <Switch label={label} checked={view.auto} onChange={async (on) => {
        const r = await agentUpdates.getState().setAuto(on);
        if (!r.ok) setMessage({ text: r.error, error: true });
      }} />
      <span className="kb-muted" aria-live="polite">
        {checking ? 'Checking…' : view.checked_at ? `Last checked: ${relativeTime(view.checked_at)}` : 'Last checked: never'}
      </span>
      <Button size="sm" variant="quiet" icon="retry" busy={checking} onClick={() => void check()}>Check for updates</Button>
      {message && (
        <span className={message.error ? 'kb-inline-error kb-inline-error--flat' : 'kb-muted'} role={message.error ? 'alert' : 'status'}>
          {message.text}
        </span>
      )}
    </span>
  );
}

/** Whether an agent update hasn't been seen yet (the dot); keeps the reads going while mounted. */
export function useAgentUpdatesDot(): boolean {
  const { agentUpdates } = useServices();
  useEffect(() => agentUpdates.getState().start(), [agentUpdates]);
  return useAgentUpdates((s) => !!s.view?.unseen);
}
