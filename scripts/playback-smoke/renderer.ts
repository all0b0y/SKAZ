import { ChunkPlaybackController, type PlaybackState } from '../../frontend/src/audio/chunkPlayback';
import type { AudioChunkManifest, AudioManifestPage } from '../../frontend/src/api/types';

interface PlaybackSmokeBridge {
  getManifest(): Promise<AudioManifestPage>;
  fetchAudio(sequence: number): Promise<ArrayBuffer>;
}

declare global {
  interface Window {
    playbackSmoke: PlaybackSmokeBridge;
  }
}

const resultNode = document.querySelector<HTMLPreElement>('#result');
if (!resultNode) throw new Error('missing smoke result node');

const waitFor = async (predicate: () => boolean, description: string): Promise<void> => {
  const deadline = performance.now() + 8_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

async function run(): Promise<void> {
  const raw = await window.playbackSmoke.getManifest();
  if (raw.chunks.length !== 3 || raw.chunks.some((chunk) => !chunk.available)) {
    throw new Error('real backend manifest did not expose all three stored chunks');
  }
  const chunks: AudioChunkManifest[] = raw.chunks.map((chunk, index) => ({
    ...chunk,
    // Persistence-only storage deliberately creates no ASR segments. The
    // synthetic link exercises exact/context selection without invoking ASR.
    segment_ids: index === 1 ? ['synthetic-middle-link'] : [],
  }));
  const audio = new Audio();
  audio.muted = true;
  document.body.append(audio);
  const states: PlaybackState[] = [];
  const fetched: number[] = [];
  const durations: number[] = [];
  let maxObservedTime = 0;
  audio.addEventListener('loadedmetadata', () => durations.push(audio.duration));
  audio.addEventListener('timeupdate', () => { maxObservedTime = Math.max(maxObservedTime, audio.currentTime); });

  const controller = new ChunkPlaybackController({
    sessionId: 'playback-smoke-session',
    chunks,
    audio,
    fetchAudio: async (_sessionId, sequence) => {
      fetched.push(sequence);
      return window.playbackSmoke.fetchAudio(sequence);
    },
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    onState: (state) => states.push({ ...state }),
  });

  await controller.playSegment('synthetic-middle-link', false);
  await waitFor(
    () => audio.ended && states.at(-1)?.mode === 'chunk' && !states.at(-1)?.playing && states.at(-1)?.selectedSequence === 20,
    'exact chunk end',
  );
  const exactFetches = [...fetched];
  const exactState = states.findLast((state) => state.mode === 'chunk');
  const exactEnded = audio.ended;
  const exactCurrentTime = audio.currentTime;
  const exactDuration = audio.duration;

  const contextStart = states.length;
  await controller.playSegment('synthetic-middle-link', true);
  await waitFor(
    () => audio.ended && states.at(-1)?.mode === 'context' && !states.at(-1)?.playing && states.at(-1)?.selectedSequence === 30,
    'context end',
  );
  const contextStates = states.slice(contextStart);
  const contextSelections: number[] = [];
  for (const state of contextStates) {
    if (
      state.playing &&
      state.selectedSequence !== null &&
      contextSelections.at(-1) !== state.selectedSequence
    ) {
      contextSelections.push(state.selectedSequence);
    }
  }
  const contextState = contextStates.find((state) => state.mode === 'context');
  const ended = audio.ended;
  const finalCurrentTime = audio.currentTime;
  const finalDuration = audio.duration;
  controller.destroy();

  const bridgeKeys = Object.keys(window.playbackSmoke).sort();
  const passed =
    exactState?.contextStartSequence === 20 &&
    exactState.contextEndSequence === 20 &&
    exactFetches.length === 1 && exactFetches[0] === 20 &&
    contextState?.contextStartSequence === 10 &&
    contextState.contextEndSequence === 30 &&
    contextSelections.join(',') === '10,20,30' &&
    durations.length >= 1 && durations.every((duration) => duration > 0.3 && duration < 0.5) &&
    maxObservedTime > 0.02 &&
    exactEnded && exactDuration > 0.3 && exactDuration < 0.5 &&
    exactCurrentTime > 0.02 && Math.abs(exactDuration - exactCurrentTime) < 0.05 &&
    ended && finalDuration > 0.3 && finalDuration < 0.5 &&
    finalCurrentTime > 0.02 && Math.abs(finalDuration - finalCurrentTime) < 0.05 &&
    bridgeKeys.join(',') === 'fetchAudio,getManifest' &&
    !JSON.stringify(window.playbackSmoke).includes('token');

  resultNode.textContent = JSON.stringify({
    passed,
    manifestSequences: raw.chunks.map((chunk) => chunk.sequence),
    sourceKinds: raw.chunks.map((chunk) => chunk.source_kind),
    exactFetches,
    contextSelections,
    durations,
    maxObservedTime,
    exactEnded,
    exactCurrentTime,
    exactDuration,
    ended,
    finalCurrentTime,
    finalDuration,
    muted: audio.muted,
    bridgeKeys,
    rendererAsset: new URL(import.meta.url).pathname.split('/').slice(-2).join('/'),
  });
}

void run().catch((error) => {
  resultNode.textContent = JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error) });
});
