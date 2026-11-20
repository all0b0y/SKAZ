import { SPEECH_EXTENSIONS } from '../../api/bridge';
import type { KbClient } from '../api/client';

export interface Attachment {
  key: string;
  name: string;
  source: 'file' | 'link' | 'text' | 'existing';
  state: 'adding' | 'confirming' | 'ready' | 'failed';
  materialId: string | null;
  error: string | null;
  inWiki: boolean;
  /** The material can be added to the wiki now (an audio/video import is still processing). */
  materialReady: boolean;
  /** A long paste kept as a card (Composer): saved to Materials only when the message is sent. */
  text?: string;
  /** N2: the same file / link was already in the library — this is that material; never sent to the wiki again. */
  alreadyInLibrary?: boolean;
}

const SPEECH_EXT = new Set<string>(SPEECH_EXTENSIONS);

export function isSpeechFile(name: string): boolean {
  return SPEECH_EXT.has(/\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '');
}

/** Create the material for one attachment, kept out of the wiki until the message is sent. */
export async function addMaterial(client: KbClient, source: 'file' | 'text', value: string, folderId: string): Promise<{ id: string; ready: boolean; existing?: boolean }> {
  const hold = { folder_id: folderId, to_wiki: false };
  if (source === 'file') {
    if (isSpeechFile(value)) {
      const res = await client.call('POST /kb/imports', { body: { path: value, ...hold } });
      return { id: res.material_id, ready: res.status === 'ready', existing: res.already_in_library === true };
    }
    const res = await client.call('POST /kb/materials/file', { body: { path: value, ...hold } });
    // N2: the same file already in the library — that material, attached as an existing one (no second ingest).
    return { id: res.material.id, ready: res.material.status === 'ready', existing: res.already_in_library === true };
  }
  const res = await client.call('POST /kb/materials/text', { body: { text: value, ...hold } });
  return { id: res.material.id, ready: res.material.status === 'ready' };
}

let seq = 0;
export const attachmentKey = () => `att-${++seq}`;
