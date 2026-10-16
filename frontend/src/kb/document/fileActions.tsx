import { useState, type ReactNode } from 'react';
import { Button, Icon } from '../ui';
import { useServices } from '../state/context';
import type { ObsidianFailure } from '../../api/bridge';

export const OBSIDIAN_DOWNLOAD = 'https://obsidian.md/download';

type ObsidianTarget = { kind: 'library' } | { kind: 'page'; id: string };

/**
 * "Open in Obsidian" (B20): main builds `obsidian://open?path=…` from the library root or the page's
 * file and opens it. Obsidian only opens folders it knows as vaults, so main first adds the library
 * to Obsidian's vault list; while Obsidian runs that needs the user's yes to restart it (Obsidian
 * would overwrite the list otherwise). Without Obsidian it says so and links to the download page.
 * Null where the host can't do it (outside the desktop app).
 */
export function useOpenInObsidian(): { open: ((target: ObsidianTarget) => Promise<void>) | null; message: ReactNode } {
  const { bridge } = useServices();
  const [state, setState] = useState<{ reason: ObsidianFailure; target: ObsidianTarget } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (target: ObsidianTarget, restart: boolean) => {
    setBusy(true);
    const result = await (restart ? bridge.openInObsidian!(target, { restart: true }) : bridge.openInObsidian!(target))
      .catch(() => ({ ok: false as const, reason: 'unavailable' as const }));
    setBusy(false);
    setState(result.ok ? null : { reason: result.reason, target });
  };
  const reason = state?.reason;
  const message = reason === 'not_installed' ? (
    <span className="kb-inline-error kb-inline-error--flat" role="alert">
      Obsidian isn’t installed on this Mac.{' '}
      <a className="kb-link" href={OBSIDIAN_DOWNLOAD} target="_blank" rel="noreferrer noopener">Download Obsidian<Icon name="external" size={12} /></a>
    </span>
  ) : reason === 'obsidian_running' ? (
    <span className="kb-obsidian-ask" role="alert">
      <span className="kb-muted">Obsidian is open and doesn’t know the library yet. To add it as a vault, Obsidian has to close and open again.</span>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(state!.target, true)}>
        {busy ? 'Restarting Obsidian…' : 'Restart Obsidian and open'}
      </Button>
      <Button size="sm" variant="quiet" disabled={busy} onClick={() => setState(null)}>Cancel</Button>
    </span>
  ) : reason === 'obsidian_config' ? (
    <span className="kb-inline-error kb-inline-error--flat" role="alert">Obsidian’s vault list couldn’t be read or changed. In Obsidian, choose “Open folder as vault” and pick the library folder.</span>
  ) : reason === 'unavailable' ? (
    <span className="kb-inline-error kb-inline-error--flat" role="alert">Obsidian couldn’t be opened for this. Check that the library is connected.</span>
  ) : null;
  if (!bridge.openInObsidian) return { open: null, message: null };
  return { open: (target) => run(target, false), message };
}

/** Settings → Storage → Open in Obsidian: the library folder as an Obsidian vault. */
export function ObsidianRow() {
  const { open, message } = useOpenInObsidian();
  if (!open) return <span className="kb-muted">Works in the SKAZ desktop app.</span>;
  return (
    <span className="kb-sound">
      <Button size="sm" icon="external" onClick={() => void open({ kind: 'library' })}>Open in Obsidian</Button>
      {message}
    </span>
  );
}
