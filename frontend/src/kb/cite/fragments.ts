import { useEffect, useState } from 'react';
import type { KbClient } from '../api/client';
import { useServices } from '../state/context';

/** How much of a cited fragment a source popup shows when the answer gave no exact words. */
export const EXCERPT_CHARS = 300;

/** Fragment texts by material, read once per client (one request per material, shared by every popup). */
const cache = new WeakMap<KbClient, Map<string, Promise<Map<number, string>>>>();

function fragmentsOf(client: KbClient, materialId: string): Promise<Map<number, string>> {
  let byMaterial = cache.get(client);
  if (!byMaterial) { byMaterial = new Map(); cache.set(client, byMaterial); }
  let pending = byMaterial.get(materialId);
  if (!pending) {
    pending = client.call('GET /kb/materials/{material_id}', { path: { material_id: materialId } })
      .then((m) => new Map(m.fragments.map((f) => [f.seg, f.text])));
    // A failed read is not remembered: the next popup tries again.
    pending.catch(() => byMaterial!.delete(materialId));
    byMaterial.set(materialId, pending);
  }
  return pending;
}

/** The start of a fragment, cut at a word boundary near `max` characters. */
export function excerpt(text: string, max = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/, '')}…`;
}

export type FragmentText = { state: 'loading' } | { state: 'ready'; text: string } | { state: 'missing' };

/** The cited fragment's text, loaded only while `enabled` (the popup is open). */
export function useFragmentText(materialId: string, seg: number, enabled: boolean): FragmentText {
  const { client } = useServices();
  const [value, setValue] = useState<FragmentText>({ state: 'loading' });
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    fragmentsOf(client, materialId).then((map) => {
      if (!live) return;
      const text = map.get(seg);
      setValue(text ? { state: 'ready', text: excerpt(text) } : { state: 'missing' });
    }, () => { if (live) setValue({ state: 'missing' }); });
    return () => { live = false; };
  }, [client, materialId, seg, enabled]);
  return value;
}
