import { useEffect, useState } from 'react';
import type { KbMaterial } from '../../api/kb/types.gen';
import { Button, Icon } from '../ui';
import { formatTime } from '../library/materialMeta';
import { useServices } from '../state/context';

const SPEECH: ReadonlyArray<KbMaterial['kind']> = ['recording', 'audio', 'video', 'video_link'];

/** Why "Add to wiki" is off for a finished recording/import without any recognised speech. */
export const NO_SPEECH_REASON = 'No speech was recognised, so there is nothing to add.';

/** A finished recording or import in which nothing was recognised (user bug 1016-2). */
export function isWithoutSpeech(material: KbMaterial): boolean {
  return SPEECH.includes(material.kind) && material.status === 'ready' && material.fragments.length === 0;
}

/** Says honestly that nothing was recognised, how long the audio is, and offers Delete. */
export function NoSpeech({ material, onDelete }: { material: KbMaterial; onDelete: () => void }) {
  const { client } = useServices();
  const [length, setLength] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    client.call('GET /kb/recordings/{material_id}', { path: { material_id: material.id } }).then(
      (view) => { if (live) setLength(view.duration_ms ?? null); },
      () => { /* the length is a detail: without it the message stands */ },
    );
    return () => { live = false; };
  }, [client, material.id]);
  const what = material.kind === 'recording' ? 'recording' : 'file';
  return (
    <div className="kb-excl kb-nospeech" role="note" aria-label="No speech">
      <p className="kb-excl__toggle">
        <Icon name="mic" size={14} />
        <span>No speech was recognised in this {what}</span>
      </p>
      {length !== null && length > 0 && <p className="kb-muted">Length {formatTime(length)}</p>}
      <p className="kb-muted">There is no text to read, ask about or add to the wiki. If nothing worth keeping was said, delete it.</p>
      <Button size="sm" variant="outline" icon="trash" onClick={onDelete}>Delete</Button>
    </div>
  );
}
