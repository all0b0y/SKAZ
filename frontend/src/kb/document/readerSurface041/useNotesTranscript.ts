import { useEffect, useState } from 'react';
import type { KbPage } from '../../../api/kb/types.gen';
import { hasSpeechTranscript } from '../../material/Transcript';
import { useLibrary, useServices } from '../../state/context';

/** Notes front matter supplies the relation. Material detail says whether there is speech to read. */
export function useNotesTranscript(page: KbPage | null) {
  const { client } = useServices();
  const soleSource = page?.kind === 'note' && page.sources.length === 1 ? page.sources[0] : undefined;
  const deleted = useLibrary((s) => soleSource !== undefined && s.gone.includes(soleSource));
  const sourceId = deleted ? undefined : soleSource;
  const [checked, setChecked] = useState<{ page: KbPage | null; source: string; available: boolean }>();
  useEffect(() => {
    if (!sourceId) return;
    let current = true;
    void client.call('GET /kb/materials/{material_id}', { path: { material_id: sourceId } }).then(
      (material) => {
        if (current) setChecked({ page, source: sourceId, available: material.id === sourceId && hasSpeechTranscript(material) });
      },
      () => { if (current) setChecked({ page, source: sourceId, available: false }); },
    );
    return () => { current = false; };
  }, [client, page, sourceId]);

  // While reading the same relation again, keep its confirmed action mounted.
  const available = checked?.available && checked.source === sourceId && checked.page?.id === page?.id;
  return { id: available ? sourceId : undefined, checking: Boolean(sourceId && checked?.page !== page) };
}
