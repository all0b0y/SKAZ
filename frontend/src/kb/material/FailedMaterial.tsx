import { useState } from 'react';
import type { KbMaterial } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Button, Icon } from '../ui';
import { useServices } from '../state/context';

const SPEECH: ReadonlyArray<KbMaterial['kind']> = ['recording', 'audio', 'video', 'video_link'];

/** When nothing was recorded about the failure (an older material, a crash mid-write). */
export function fallbackReason(material: KbMaterial): string {
  return SPEECH.includes(material.kind)
    ? 'Recognition stopped before it finished.'
    : 'SKAZ couldn’t read any text from this material.';
}

/**
 * A material that failed (QA B5, E10): why, in the backend's words (a scanned PDF without a text
 * layer, the provider's error, an import interrupted when SKAZ closed), and what can be done —
 * Retry for an import that can start again, Delete always. Never "the text appears here soon".
 */
export function FailedMaterial({ material, onDelete, onRetried }: {
  material: KbMaterial;
  onDelete: () => void;
  onRetried: () => void;
}) {
  const { client } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const speech = SPEECH.includes(material.kind);
  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.call('POST /kb/imports/{material_id}/retry', { path: { material_id: material.id } });
      onRetried();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kb-excl kb-failed" role="note" aria-label={speech ? 'Recognition failed' : 'Couldn’t read'}>
      <p className="kb-excl__toggle">
        <Icon name="warning" size={14} />
        <span>{speech ? 'Recognition failed' : 'SKAZ couldn’t read this material'}</span>
      </p>
      <p className="kb-failed__reason">{material.failure_reason ?? fallbackReason(material)}</p>
      {speech && material.fragments.length > 0 && <p className="kb-muted">The text recognised before it stopped is kept below.</p>}
      <div className="kb-failed__actions">
        {material.can_retry && <Button size="sm" variant="fill" icon="retry" busy={busy} onClick={() => void retry()}>Retry</Button>}
        <Button size="sm" variant="outline" icon="trash" onClick={onDelete}>Delete</Button>
      </div>
      {error && <p className="kb-inline-error" role="alert">{error}</p>}
    </div>
  );
}
