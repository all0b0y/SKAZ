import type { AudioChunkManifest } from '../api/types';

interface PlaybackAudio {
  src: string;
  currentTime: number;
  paused: boolean;
  readyState: number;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(name: 'ended' | 'timeupdate' | 'loadedmetadata' | 'error', listener: () => void): void;
  removeEventListener(name: 'ended' | 'timeupdate' | 'loadedmetadata' | 'error', listener: () => void): void;
}

export type PlaybackMode = 'idle' | 'full' | 'chunk' | 'context';

export interface PlaybackState {
  mode: PlaybackMode;
  playing: boolean;
  selectedSequence: number | null;
  sourceSequence: number | null;
  timelineMs: number;
  contextStartSequence: number | null;
  contextEndSequence: number | null;
  error: string | null;
}

interface ControllerOptions {
  sessionId: string;
  chunks: AudioChunkManifest[];
  audio: PlaybackAudio;
  fetchAudio(sessionId: string, sequence: number): Promise<ArrayBuffer>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  onState(state: PlaybackState): void;
}

export function findChunkForSegment(
  chunks: AudioChunkManifest[],
  segmentId: string,
): AudioChunkManifest | undefined {
  return chunks.find((chunk) => chunk.segment_ids.includes(segmentId));
}

export function findChunksForSegment(
  chunks: AudioChunkManifest[],
  segmentId: string,
): AudioChunkManifest[] {
  return chunks.filter((chunk) => chunk.segment_ids.includes(segmentId));
}

export function getContextBounds(
  chunks: AudioChunkManifest[],
  sequence: number,
): { startIndex: number; endIndex: number } | null {
  const index = chunks.findIndex((chunk) => chunk.sequence === sequence);
  if (index < 0) return null;
  return {
    startIndex: Math.max(0, index - 1),
    endIndex: Math.min(chunks.length - 1, index + 1),
  };
}

export class ChunkPlaybackController {
  private readonly sessionId: string;
  private chunks: AudioChunkManifest[];
  private readonly audio: PlaybackAudio;
  private readonly fetchAudio: ControllerOptions['fetchAudio'];
  private readonly createObjectURL: ControllerOptions['createObjectURL'];
  private readonly revokeObjectURL: ControllerOptions['revokeObjectURL'];
  private readonly onState: ControllerOptions['onState'];
  private readonly urls = new Map<number, string>();
  private destroyed = false;
  private run = 0;
  /** A stable sequence playlist. Manifest refreshes may reorder array objects. */
  private playlist: number[] = [];
  private playlistPosition = -1;
  private loading = false;
  private sourceRun = 0;
  private cancelMetadataWait: (() => void) | null = null;
  private playbackEndMs: number | null = null;
  private state: PlaybackState = {
    mode: 'idle', playing: false, selectedSequence: null, sourceSequence: null, timelineMs: 0,
    contextStartSequence: null, contextEndSequence: null, error: null,
  };

  private readonly ended = () => {
    if (!this.loading) void this.advance();
  };
  private readonly mediaError = () => {
    if (this.sourceRun !== this.run || this.destroyed) return;
    const sequence = this.currentChunk()?.sequence;
    this.fail(sequence === undefined
      ? 'Audio decoder could not play this source.'
      : `Audio decoder could not play chunk ${sequence}.`);
  };
  private readonly timeupdate = () => {
    const chunk = this.currentChunk();
    if (!chunk) return;
    const timelineMs = Math.min(chunk.end_ms, chunk.start_ms + this.audio.currentTime * 1_000);
    this.emit({ timelineMs });
    if (this.playbackEndMs !== null && timelineMs >= this.playbackEndMs) {
      this.audio.pause();
      this.playlistPosition = this.playlist.length;
      this.emit({ playing: false, timelineMs: this.playbackEndMs });
    }
  };

  constructor(options: ControllerOptions) {
    this.sessionId = options.sessionId;
    this.chunks = options.chunks;
    this.audio = options.audio;
    this.fetchAudio = options.fetchAudio;
    this.createObjectURL = options.createObjectURL;
    this.revokeObjectURL = options.revokeObjectURL;
    this.onState = options.onState;
    this.audio.addEventListener('ended', this.ended);
    this.audio.addEventListener('timeupdate', this.timeupdate);
    this.audio.addEventListener('error', this.mediaError);
    this.onState(this.state);
  }

  /** Refresh metadata without replacing the audio element, source, or playlist. */
  updateChunks(chunks: AudioChunkManifest[]): void {
    if (this.destroyed) return;
    this.chunks = chunks;
  }

  async playFull(startMs = this.chunks[0]?.start_ms ?? 0): Promise<void> {
    const index = this.findTimelineIndex(startMs);
    if (index < 0) return this.fail(`No captured audio exists at ${Math.round(startMs)} ms (timeline gap).`);
    const expectedRun = this.beginTransition();
    // Full playback is a manifest snapshot. A later explicit replay sees newly
    // appended chunks; an in-flight replay is not silently extended.
    this.playlist = this.chunks.slice(index).map((chunk) => chunk.sequence);
    this.playlistPosition = 0;
    this.emit({
      mode: 'full', contextStartSequence: null, contextEndSequence: null,
      sourceSequence: null,
      timelineMs: startMs, error: null,
    });
    await this.startCurrent(Math.max(0, startMs - this.chunks[index]!.start_ms), expectedRun);
  }

  async playSegment(
    segmentId: string,
    withContext: boolean,
    segmentBounds?: { startMs: number; endMs: number },
  ): Promise<void> {
    const linked = findChunksForSegment(this.chunks, segmentId);
    const chunk = linked[0];
    if (!chunk) return this.fail('No linked audio chunk exists for this transcript segment.');
    const lastLinked = linked.at(-1)!;
    const firstIndex = this.chunks.indexOf(chunk);
    const lastIndex = this.chunks.indexOf(lastLinked);
    const startIndex = withContext ? Math.max(0, firstIndex - 1) : firstIndex;
    const endIndex = withContext ? Math.min(this.chunks.length - 1, lastIndex + 1) : lastIndex;
    const expectedRun = this.beginTransition();
    this.playlist = withContext
      ? this.chunks.slice(startIndex, endIndex + 1).map((item) => item.sequence)
      : linked.map((item) => item.sequence);
    this.playlistPosition = 0;
    this.playbackEndMs = !withContext && linked.length > 1 && segmentBounds
      ? segmentBounds.endMs
      : null;
    this.emit({
      mode: withContext ? 'context' : 'chunk',
      sourceSequence: chunk.sequence,
      contextStartSequence: withContext ? this.chunks[startIndex]!.sequence : chunk.sequence,
      contextEndSequence: withContext ? this.chunks[endIndex]!.sequence : lastLinked.sequence,
      timelineMs: withContext ? this.chunks[startIndex]!.start_ms : (segmentBounds?.startMs ?? chunk.start_ms),
      error: null,
    });
    const offsetMs = !withContext && linked.length > 1 && segmentBounds
      ? Math.max(0, segmentBounds.startMs - chunk.start_ms)
      : 0;
    await this.startCurrent(offsetMs, expectedRun);
  }

  async playSequences(sequences: number[]): Promise<void> {
    const unique = [...new Set(sequences)];
    const selected = unique
      .map((sequence) => this.chunks.find((chunk) => chunk.sequence === sequence))
      .filter((chunk): chunk is AudioChunkManifest => Boolean(chunk));
    if (selected.length !== unique.length) {
      return this.fail('One or more draft source chunks are missing from the audio manifest.');
    }
    if (selected.length === 0) return this.fail('No linked source audio exists for this draft.');
    const expectedRun = this.beginTransition();
    this.playbackEndMs = null;
    this.playlist = selected.map((chunk) => chunk.sequence);
    this.playlistPosition = 0;
    this.emit({
      mode: 'chunk', sourceSequence: selected[0]!.sequence,
      contextStartSequence: selected[0]!.sequence,
      contextEndSequence: selected.at(-1)!.sequence,
      timelineMs: selected[0]!.start_ms, error: null,
    });
    await this.startCurrent(0, expectedRun);
  }

  async seek(timelineMs: number): Promise<void> {
    const index = this.findTimelineIndex(timelineMs);
    if (index < 0) return this.fail(`Cannot seek to ${Math.round(timelineMs)} ms: timeline gap.`);
    const expectedRun = this.beginTransition();
    this.playlist = this.chunks.slice(index).map((chunk) => chunk.sequence);
    this.playlistPosition = 0;
    this.emit({ mode: 'full', sourceSequence: null, contextStartSequence: null, contextEndSequence: null, error: null });
    await this.startCurrent(timelineMs - this.chunks[index]!.start_ms, expectedRun);
  }

  pause(): void {
    this.run += 1;
    this.loading = false;
    this.cancelMetadataWait?.();
    this.audio.pause();
    this.emit({ playing: false });
  }

  async resume(): Promise<void> {
    if (this.destroyed || !this.audio.src || !this.audio.paused) return;
    const expectedRun = ++this.run;
    this.sourceRun = expectedRun;
    try {
      await this.audio.play();
      if (this.destroyed || expectedRun !== this.run) return;
      this.emit({ playing: true, error: null });
    } catch {
      if (expectedRun === this.run) this.fail('Playback could not resume.');
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.run += 1;
    this.loading = false;
    this.cancelMetadataWait?.();
    this.audio.pause();
    this.audio.removeEventListener('ended', this.ended);
    this.audio.removeEventListener('timeupdate', this.timeupdate);
    this.audio.removeEventListener('error', this.mediaError);
    this.audio.src = '';
    for (const url of this.urls.values()) this.revokeObjectURL(url);
    this.urls.clear();
  }

  private currentChunk(): AudioChunkManifest | undefined {
    const sequence = this.playlist[this.playlistPosition];
    return sequence === undefined
      ? undefined
      : this.chunks.find((chunk) => chunk.sequence === sequence);
  }

  private findTimelineIndex(ms: number): number {
    return this.chunks.findIndex((chunk) => ms >= chunk.start_ms && ms < chunk.end_ms);
  }

  private beginTransition(resetEnd = true): number {
    this.cancelMetadataWait?.();
    this.loading = true;
    if (resetEnd) this.playbackEndMs = null;
    const expectedRun = ++this.run;
    if (!this.audio.paused) this.audio.pause();
    return expectedRun;
  }

  private async startCurrent(offsetMs: number, expectedRun: number): Promise<void> {
    const chunk = this.currentChunk();
    if (!chunk) return this.stopAtBoundary();
    if (!chunk.available) return this.fail(`Chunk ${chunk.sequence} is a visible missing file and cannot be played.`);
    const url = await this.loadUrl(chunk, expectedRun);
    if (!url || this.destroyed || expectedRun !== this.run) return;
    this.sourceRun = expectedRun;
    this.audio.src = url;
    this.emit({ selectedSequence: chunk.sequence, timelineMs: chunk.start_ms + offsetMs, playing: false, error: null });
    if (!(await this.waitForMetadata(expectedRun))) return;
    if (this.destroyed || expectedRun !== this.run) return;
    this.audio.currentTime = Math.max(0, offsetMs / 1_000);
    try {
      await this.audio.play();
    } catch {
      if (expectedRun === this.run) this.fail(`Chunk ${chunk.sequence} could not start playback.`);
      return;
    }
    if (this.destroyed || expectedRun !== this.run) return;
    this.loading = false;
    this.emit({ playing: true, error: null });
    void this.prefetchNext(expectedRun);
  }

  private async advance(): Promise<void> {
    const previous = this.currentChunk();
    if (!previous) return;
    if (this.playlistPosition >= this.playlist.length - 1) return this.stopAtBoundary();
    const nextSequence = this.playlist[this.playlistPosition + 1]!;
    const next = this.chunks.find((chunk) => chunk.sequence === nextSequence);
    if (!next) return this.fail(`Chunk ${nextSequence} disappeared from the audio manifest; playback stopped.`);
    if (next.start_ms !== previous.end_ms) {
      return this.fail(`Timeline gap between chunks ${previous.sequence} and ${next.sequence}; playback stopped.`);
    }
    if (!next.available) {
      return this.fail(`Chunk ${next.sequence} is a visible missing file; playback stopped.`);
    }
    this.playlistPosition += 1;
    const expectedRun = this.beginTransition(false);
    await this.startCurrent(0, expectedRun);
  }

  private async prefetchNext(expectedRun: number): Promise<void> {
    if (this.playlistPosition >= this.playlist.length - 1) return;
    const current = this.currentChunk()!;
    const nextSequence = this.playlist[this.playlistPosition + 1]!;
    const next = this.chunks.find((chunk) => chunk.sequence === nextSequence);
    if (!next) return;
    if (!next.available || next.start_ms !== current.end_ms) return;
    // Lookahead is opportunistic: a preload failure must not interrupt the
    // chunk the user is currently hearing. The normal advance path reports it.
    await this.loadUrl(next, expectedRun, false);
  }

  private async loadUrl(
    chunk: AudioChunkManifest,
    expectedRun: number,
    reportError = true,
  ): Promise<string | null> {
    if (this.destroyed || expectedRun !== this.run) return null;
    const cached = this.urls.get(chunk.sequence);
    if (cached) {
      this.urls.delete(chunk.sequence);
      this.urls.set(chunk.sequence, cached);
      return cached;
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await this.fetchAudio(this.sessionId, chunk.sequence);
    } catch {
      if (!this.destroyed && expectedRun === this.run && reportError) {
        this.fail(`Chunk ${chunk.sequence} could not be loaded.`);
      }
      return null;
    }
    if (this.destroyed || expectedRun !== this.run) return null;
    const url = this.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    this.urls.set(chunk.sequence, url);
    while (this.urls.size > 2) {
      const protectedSequences = new Set([this.state.selectedSequence, chunk.sequence]);
      const oldest = [...this.urls.entries()].find(([sequence]) => !protectedSequences.has(sequence));
      if (!oldest) break;
      this.urls.delete(oldest[0]);
      this.revokeObjectURL(oldest[1]);
    }
    return url;
  }

  private waitForMetadata(expectedRun: number): Promise<boolean> {
    if (this.audio.readyState >= 1) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        this.audio.removeEventListener('loadedmetadata', loaded);
        this.audio.removeEventListener('error', failed);
        if (this.cancelMetadataWait === cancel) this.cancelMetadataWait = null;
        resolve(ready && !this.destroyed && expectedRun === this.run);
      };
      const loaded = () => finish(true);
      const failed = () => finish(false);
      const cancel = () => finish(false);
      this.cancelMetadataWait = cancel;
      this.audio.addEventListener('loadedmetadata', loaded);
      this.audio.addEventListener('error', failed);
    });
  }

  private stopAtBoundary(): void {
    this.loading = false;
    this.audio.pause();
    this.emit({ playing: false });
  }

  private fail(message: string): void {
    this.run += 1;
    this.loading = false;
    this.cancelMetadataWait?.();
    this.audio.pause();
    this.emit({ playing: false, error: message });
  }

  private emit(update: Partial<PlaybackState>): void {
    if (this.destroyed) return;
    this.state = { ...this.state, ...update };
    this.onState(this.state);
  }
}
