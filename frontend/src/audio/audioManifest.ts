import type { AudioChunkManifest, AudioManifestPage } from '../api/types';

export interface AudioPlaybackApi {
  getAudioManifestPage(
    sessionId: string,
    afterSequence?: number,
    limit?: number,
  ): Promise<AudioManifestPage>;
  fetchAudio(sessionId: string, sequence: number): Promise<ArrayBuffer>;
}

const PAGE_LIMIT = 100;
const MAX_PAGES = 10_000;

/** Fetch metadata only. Audio bytes remain chunk-lazy in the playback controller. */
export async function loadAudioManifest(
  api: AudioPlaybackApi,
  sessionId: string,
): Promise<AudioChunkManifest[]> {
  const chunks: AudioChunkManifest[] = [];
  let cursor: number | undefined;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = await api.getAudioManifestPage(sessionId, cursor, PAGE_LIMIT);
    for (const chunk of page.chunks) {
      const previous = chunks.at(-1);
      if (previous && chunk.sequence <= previous.sequence) {
        throw new Error('Audio manifest sequence order is invalid.');
      }
      chunks.push(chunk);
    }

    const next = page.next_after_sequence;
    if (next === null) return chunks;
    if (!Number.isInteger(next) || next < 0 || (cursor !== undefined && next <= cursor)) {
      throw new Error('Audio manifest returned an invalid or repeated cursor.');
    }
    const last = page.chunks.at(-1);
    if (last && next !== last.sequence) {
      throw new Error('Audio manifest cursor does not match the last sequence.');
    }
    cursor = next;
  }

  throw new Error('Audio manifest pagination exceeded the safety limit.');
}
