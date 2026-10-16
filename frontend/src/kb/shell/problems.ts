import { useMemo } from 'react';
import { useLibrary, useSettings } from '../state/context';
import { HEALTH_TO_SECTION } from '../state/settings';
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
 * section and the gear with a dot: the library state plus `/kb/settings/health` (S3).
 */
export function useProblems(): Problem[] {
  const library = useLibrary((s) => s.library);
  const libraryLoad = useLibrary((s) => s.libraryLoad);
  const health = useSettings((s) => s.health.value);
  return useMemo(() => {
    const out: Problem[] = [];
    if (libraryLoad === 'error') {
      out.push({ id: 'library-read', tone: 'error', section: 'storage', short: 'Library state couldn’t be read' });
    } else if (library?.state === 'not_configured') {
      out.push({ id: 'library-missing', tone: 'warning', section: 'storage', short: 'Library isn’t connected' });
    } else if (library?.state === 'unavailable') {
      out.push({ id: 'library-unavailable', tone: 'error', section: 'storage', short: 'Library folder unavailable' });
    }
    for (const section of health?.sections ?? []) {
      if (section.state !== 'warning' && section.state !== 'error') continue;
      const first = section.problems[0];
      const id = `health-${section.id}`;
      if (out.some((p) => p.section === HEALTH_TO_SECTION[section.id])) continue;
      out.push({ id, tone: section.state, section: HEALTH_TO_SECTION[section.id], short: first ? first.title.replace(/\.$/, '') : 'Needs attention' });
    }
    // Errors first: the gear opens the most urgent section.
    return out.sort((a, b) => Number(b.tone === 'error') - Number(a.tone === 'error'));
  }, [library, libraryLoad, health]);
}
