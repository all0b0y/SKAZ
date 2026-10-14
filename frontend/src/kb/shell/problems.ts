import { useMemo } from 'react';
import { useLibrary } from '../state/context';
import type { SettingsSection } from '../state/ui';

export interface Problem {
  id: string;
  tone: 'warning' | 'error';
  section: SettingsSection;
  /** For the gear tooltip. */
  short: string;
}

/**
 * Problems known to the window right now, from real backend answers only. Each marks its settings
 * section and the gear with a dot. U1 knows only the library; agents/speech/models come later.
 */
export function useProblems(): Problem[] {
  const library = useLibrary((s) => s.library);
  const libraryLoad = useLibrary((s) => s.libraryLoad);
  return useMemo(() => {
    const out: Problem[] = [];
    if (libraryLoad === 'error') {
      out.push({ id: 'library-read', tone: 'error', section: 'storage', short: 'library state could not be read' });
    } else if (library?.state === 'not_configured') {
      out.push({ id: 'library-missing', tone: 'warning', section: 'storage', short: 'library isn’t connected' });
    } else if (library?.state === 'unavailable') {
      out.push({ id: 'library-unavailable', tone: 'error', section: 'storage', short: 'library folder unavailable' });
    }
    return out;
  }, [library, libraryLoad]);
}
