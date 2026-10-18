import { useEffect, useState } from 'react';
import type { UpdateState } from '../../api/bridge';
import { Button, Icon, Modal } from '../ui';
import { useServices } from '../state/context';
import { relativeTime } from '../document/text';

/**
 * Settings → About → Updates (B20): what main last learned from GitHub Releases (current version,
 * the newer one if any, "Couldn't check" when offline), "Check now", and Update — download with
 * progress, checks of size, checksum and signature, then "SKAZ will close to update" before the
 * installer runs. Development builds show the check result; Update says it works in the installed app.
 */
export function UpdatesRow() {
  const { bridge } = useServices();
  const [state, setState] = useState<UpdateState | null>(null);
  const [asking, setAsking] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge.updateState) return undefined;
    let live = true;
    void bridge.updateState().then((s) => { if (live && s) setState(s); }, () => undefined);
    const off = bridge.onUpdateState?.((s) => { if (live) setState(s); });
    return () => { live = false; off?.(); };
  }, [bridge]);

  // A verified download asks once whether SKAZ may close now.
  useEffect(() => { if (state?.phase === 'ready') setAsking(true); }, [state?.phase]);

  if (!bridge.updateState) return <span className="kb-muted">Updates work in the SKAZ desktop app.</span>;
  if (!state) return <span className="kb-muted" role="status">Reading…</span>;

  const check = async () => { const s = await bridge.checkForUpdates?.().catch(() => null); if (s) setState(s); };
  const update = async () => { setInstallError(null); const s = await bridge.prepareUpdate?.().catch(() => null); if (s) setState(s); };
  const checked = state.checkedAt ? ` · checked ${relativeTime(state.checkedAt)}` : '';
  const checking = state.phase === 'checking';
  const working = ['downloading', 'verifying', 'ready', 'installing'].includes(state.phase);
  const pct = state.progress === null ? null : Math.round(state.progress * 100);

  return (
    <span className="kb-updates">
      {state.phase === 'off' && <span className="kb-muted">Update checks are off in this run.</span>}
      {state.phase === 'idle' && <span className="kb-muted">SKAZ {state.current} · not checked yet</span>}
      {checking && <span className="kb-muted" role="status">Checking…</span>}
      {state.phase === 'up_to_date' && (
        <span className="kb-status kb-status--ok"><Icon name="check" size={13} />SKAZ {state.current} is up to date{checked}</span>
      )}
      {state.phase === 'couldnt_check' && (
        <span className="kb-status kb-status--warn"><Icon name="warning" size={13} />Couldn’t check for updates{checked}</span>
      )}
      {state.available && (state.phase === 'available' || state.phase === 'failed' || working) && (
        <span className="kb-status kb-status--ok" role="status">
          <Icon name="ready" size={13} />SKAZ {state.available.version} is available (you have {state.current})
          {' '}<a className="kb-link" href={state.available.page} target="_blank" rel="noreferrer noopener">What’s new<Icon name="external" size={12} /></a>
        </span>
      )}
      {state.phase === 'downloading' && (
        <span className="kb-progress-row">
          <span className="kb-progress" role="progressbar" aria-label="Downloading the update" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
            <i style={{ width: `${pct ?? 5}%` }} />
          </span>
          <span className="kb-muted">{pct === null ? '…' : `${pct}%`}</span>
          {bridge.cancelUpdate && (
            <Button size="sm" variant="quiet" onClick={async () => { const s = await bridge.cancelUpdate?.().catch(() => null); if (s) setState(s); }}>Cancel</Button>
          )}
        </span>
      )}
      {state.phase === 'verifying' && <span className="kb-muted" role="status">Checking the download…</span>}
      {state.phase === 'installing' && <span className="kb-muted" role="status">Installing — SKAZ will close and open again…</span>}
      {state.available && (state.phase === 'available' || state.phase === 'failed') && (
        state.canInstall
          ? <Button size="sm" variant="fill" onClick={() => void update()}>{state.phase === 'failed' ? 'Try again' : 'Update'}</Button>
          : <Button size="sm" variant="fill" disabled title={state.disabledReason ?? undefined}>Update</Button>
      )}
      {state.available && !state.canInstall && state.disabledReason && <span className="kb-muted">{state.disabledReason}</span>}
      {state.phase !== 'off' && !working && (
        <Button size="sm" variant="quiet" icon="retry" busy={checking} onClick={() => void check()}>Check now</Button>
      )}
      {state.phase === 'failed' && state.error && <span className="kb-inline-error kb-inline-error--flat" role="alert">{state.error}</span>}
      {installError && <span className="kb-inline-error kb-inline-error--flat" role="alert">{installError}</span>}
      <Modal open={asking && state.phase === 'ready'} onClose={() => setAsking(false)} title="SKAZ will close to update"
        className="kb-confirm" testId="confirm-update">
        <div className="kb-confirm__body">
          <p>SKAZ {state.available?.version} is downloaded and checked. SKAZ closes, installs it and opens again.</p>
          <p className="kb-muted">A running recording is stopped and saved first; SKAZ asks before closing if anything isn’t saved yet.</p>
        </div>
        <footer className="kb-confirm__foot">
          <Button onClick={() => setAsking(false)}>Later</Button>
          <Button variant="fill" onClick={async () => {
            setAsking(false);
            const ok = await bridge.installUpdate?.().catch(() => false);
            if (!ok) setInstallError('The update couldn’t start. Try again from here.');
          }}>Update and restart</Button>
        </footer>
      </Modal>
      {state.phase === 'ready' && !asking && (
        <Button size="sm" variant="fill" onClick={() => setAsking(true)}>Install…</Button>
      )}
    </span>
  );
}
