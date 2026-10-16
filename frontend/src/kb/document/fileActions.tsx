import { useState, type ReactNode } from 'react';
import { Button, Icon } from '../ui';
import { useServices } from '../state/context';

export const OBSIDIAN_DOWNLOAD = 'https://obsidian.md/download';

type ObsidianTarget = { kind: 'library' } | { kind: 'page'; id: string };

/**
 * "Open in Obsidian" (B20): main builds `obsidian://open?path=…` from the library root or the page's
 * file and opens it; without Obsidian on this Mac it says so and links to the download page.
 * Null where the host can't do it (outside the desktop app).
 */
export function useOpenInObsidian(): { open: ((target: ObsidianTarget) => Promise<void>) | null; message: ReactNode } {
  const { bridge } = useServices();
  const [state, setState] = useState<'not_installed' | 'unavailable' | null>(null);
  const message = state === 'not_installed' ? (
    <span className="kb-inline-error kb-inline-error--flat" role="alert">
      Obsidian isn’t installed on this Mac.{' '}
      <a className="kb-link" href={OBSIDIAN_DOWNLOAD} target="_blank" rel="noreferrer noopener">Download Obsidian<Icon name="external" size={12} /></a>
    </span>
  ) : state === 'unavailable' ? (
    <span className="kb-inline-error kb-inline-error--flat" role="alert">Obsidian couldn’t be opened for this. Check that the library is connected.</span>
  ) : null;
  if (!bridge.openInObsidian) return { open: null, message: null };
  return {
    open: async (target) => {
      const result = await bridge.openInObsidian!(target).catch(() => ({ ok: false as const, reason: 'unavailable' as const }));
      setState(result.ok ? null : result.reason);
    },
    message,
  };
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
