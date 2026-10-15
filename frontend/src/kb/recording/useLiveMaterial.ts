import { useEffect, useMemo, useRef } from 'react';
import type { KbFragment, KbMaterial } from '../../api/kb/types.gen';
import { useRecording } from '../state/context';
import { lastSeg } from './liveText';
import { isLive } from './recordingStore';

/** `material` with the fragments it gained while recording appended (seg order, no duplicates). */
export function withFragments(material: KbMaterial, added: readonly KbFragment[]): KbMaterial {
  const seg = lastSeg(material.fragments);
  const newer = added.filter((f) => f.seg > seg);
  return newer.length ? { ...material, fragments: [...material.fragments, ...newer] } : material;
}

/**
 * A material that is being recorded right now, without re-reading it: the recording store's live
 * poll brings the fragments it gains (`GET /kb/recordings/{id}/live?since_seg=`), they are appended
 * here. `followed` is true while that poll covers this material — the caller must not poll the
 * whole material then. When the recording ends the material is read once more (`reload`): the end
 * closes the last monologue and changes the status.
 */
export function useLiveMaterial(materialId: string, material: KbMaterial | null, reload: () => void) {
  const recMaterial = useRecording((s) => s.materialId);
  const phase = useRecording((s) => s.phase);
  const liveFragments = useRecording((s) => s.liveFragments);
  const followed = recMaterial === materialId && (isLive(phase) || phase === 'finishing' || phase === 'starting');
  const was = useRef(followed);
  useEffect(() => {
    if (was.current && !followed) reload();
    was.current = followed;
  }, [followed, reload]);
  const merged = useMemo(
    () => (material && followed && liveFragments.length ? withFragments(material, liveFragments) : material),
    [material, followed, liveFragments],
  );
  return { material: merged, followed };
}
