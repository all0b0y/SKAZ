import { describe, expect, it, vi } from 'vitest';
import { loadAudioManifest } from './audioManifest';
import type { AudioManifestPage } from '../api/types';

describe('loadAudioManifest', () => {
  it('loads every page in stable sequence order without loading audio bytes', async () => {
    const pages = new Map<number | undefined, AudioManifestPage>([
      [undefined, {
        chunks: [{ sequence: 0, start_ms: 0, end_ms: 1_000, status: 'pending', available: true, segment_ids: [], source_kind: 'original_captured_wav' }],
        next_after_sequence: 0,
      }],
      [0, {
        chunks: [{ sequence: 1, start_ms: 1_000, end_ms: 2_000, status: 'failed', available: true, segment_ids: ['real-segment-id'], source_kind: 'original_captured_wav' }],
        next_after_sequence: 1,
      }],
      [1, {
        chunks: [{ sequence: 2, start_ms: 2_000, end_ms: 3_000, status: 'done', available: false, segment_ids: [], source_kind: 'original_captured_wav' }],
        next_after_sequence: null,
      }],
    ]);
    const getAudioManifestPage = vi.fn(async (_id: string, cursor?: number) => pages.get(cursor)!);
    const fetchAudio = vi.fn();

    const chunks = await loadAudioManifest({ getAudioManifestPage, fetchAudio }, 's1');

    expect(chunks.map((chunk) => chunk.sequence)).toEqual([0, 1, 2]);
    expect(getAudioManifestPage).toHaveBeenCalledTimes(3);
    expect(fetchAudio).not.toHaveBeenCalled();
  });

  it('rejects an invalid repeated cursor instead of looping forever', async () => {
    const page: AudioManifestPage = { chunks: [], next_after_sequence: 4 };
    const api = { getAudioManifestPage: vi.fn(async () => page), fetchAudio: vi.fn() };

    await expect(loadAudioManifest(api, 's1')).rejects.toThrow(/cursor/i);
    expect(api.getAudioManifestPage).toHaveBeenCalledTimes(2);
  });
});
