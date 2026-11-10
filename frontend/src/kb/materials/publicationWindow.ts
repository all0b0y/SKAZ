// N7-5 for the library (decision N7 #7): the materials list can be narrowed to a publication window.
// The window is whole years, shown as "Looking at 2024–2026" like the chat's time window; the backend
// answers from real publication dates and lists materials whose date is unknown separately.
import { useEffect, useState } from 'react';
import type { KbDatedMaterials } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { useMarksClients } from '../material/marksClients';

export interface YearWindow { from: number; to: number }

export const windowDates = (w: YearWindow) => ({ from_date: `${w.from}-01-01`, to_date: `${w.to}-12-31`, unknown: 'separate' as const });

/** "Last 3 years" ending this year. */
export const lastYears = (years: number, now = new Date().getFullYear()): YearWindow => ({ from: now - years + 1, to: now });

export interface DatedIds {
  /** Published inside the window. */
  inside: ReadonlySet<string>;
  /** Publication date unknown: listed apart, never silently counted in or out. */
  unknown: ReadonlySet<string>;
}

export type DatedState = { load: 'idle' } | { load: 'loading' } | { load: 'ready'; ids: DatedIds } | { load: 'error'; error: string };

const MAX_PAGES = 20;

/** The ids inside a window and the ids with no known date; idle while there is no window. */
export function useDatedMaterials(window: YearWindow | null): DatedState {
  const { freshness } = useMarksClients();
  const [state, setState] = useState<DatedState>({ load: 'idle' });
  const from = window?.from;
  const to = window?.to;
  useEffect(() => {
    if (from === undefined || to === undefined) { setState({ load: 'idle' }); return undefined; }
    let live = true;
    setState({ load: 'loading' });
    (async () => {
      const inside = new Set<string>();
      const unknown = new Set<string>();
      let cursor: string | null | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const res: KbDatedMaterials = await freshness.filter_dates({ dates: windowDates({ from, to }), ...(cursor ? { cursor } : {}) });
        for (const m of res.materials) inside.add(m.material_id);
        for (const m of res.unknown_date) unknown.add(m.material_id);
        cursor = res.next_cursor;
        if (!cursor) break;
      }
      if (live) setState({ load: 'ready', ids: { inside, unknown } });
    })().catch((e: unknown) => { if (live) setState({ load: 'error', error: errorText(e) }); });
    return () => { live = false; };
  }, [freshness, from, to]);
  return state;
}
