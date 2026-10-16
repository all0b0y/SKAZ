import { errorText, type KbClient } from '../api/client';

const POLL_MS = 3000;
const POLL_LIMIT = 600;

/**
 * Add a material to the wiki now, or once it is ready (an audio/video import still being processed).
 * Used where the user decides after the material was created (the composer's "In wiki" until send).
 */
export function ingestWhenReady(client: KbClient, materialId: string, ready: boolean, onError: (text: string) => void): void {
  const go = () => {
    client.call('POST /kb/materials/{material_id}/ingest', { path: { material_id: materialId } }).catch((e: unknown) => onError(errorText(e)));
  };
  if (ready) { go(); return; }
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    client.call('GET /kb/materials/{material_id}', { path: { material_id: materialId } }).then((m) => {
      if (m.status === 'ready') { clearInterval(timer); go(); }
      else if (m.status === 'failed' || tries > POLL_LIMIT) clearInterval(timer);
    }, () => { if (tries > 5) clearInterval(timer); });
  }, POLL_MS);
}
