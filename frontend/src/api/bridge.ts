// Contract for the preload bridge (window.skaz). This is the ONLY
// surface the renderer uses to reach the managed Python backend. The renderer
// never learns the per-run token or the backend port: the main process owns
// both and attaches the Authorization header to every proxied request. The
// bridge can therefore only reach the loopback backend, nothing else.

import type { NativeAudioMeta, NativeFailure, NativeOpened, NativeSaved, NativeStopped } from './nativeLive';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface BridgeRequest {
  method: HttpMethod;
  /** Backend path, must start with '/'. Host and port are fixed by main. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export type JsonResponse<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; detail: string };

export type BinaryResponse =
  | { ok: true; status: number; data: ArrayBuffer }
  | { ok: false; status: number; detail: string };

export interface AudioUploadMeta {
  sequence: number;
  startMs: number;
  endMs: number;
}

/** Containers Soniox documents for automatic format detection on file input. */
export const AUDIO_EXTENSIONS = [
  'aac', 'aiff', 'amr', 'asf', 'flac', 'm4a', 'mp3', 'mp4', 'ogg', 'wav', 'webm',
] as const;

/** A file the user picked for import. Only the identity crosses IPC: the audio
 * itself is read by the backend from this path, never streamed through the
 * renderer. ``url`` exists so the renderer can read the duration from the
 * container metadata and price the import honestly before anything is sent. */
export interface AudioFileChoice {
  path: string;
  name: string;
  url: string;
}

export type BackendPhase = 'starting' | 'ready' | 'error' | 'stopped';

/** One note offered to the share sheet: its file name (without extension) and clean text. */
export interface SharedNote {
  fileName: string;
  content: string;
  /** Window coordinates the share menu opens at. */
  x: number;
  y: number;
}

export interface BackendStatus {
  phase: BackendPhase;
  detail?: string;
}

/** Live capture snapshot the renderer pushes to main so a close/quit can be
 * guarded when unsent audio still exists. */
export interface CaptureState {
  recorderState: 'idle' | 'recording' | 'paused' | 'processing' | 'stopped';
  pending: number;
  failed: number;
}

export interface BridgeApi {
  /** Native PCM lifecycle, authenticated and bounded in Electron main. */
  openNative(sessionId: string, sampleRate: number): Promise<JsonResponse<NativeOpened>>;
  sendNativeAudio(sessionId: string, meta: NativeAudioMeta, pcm: ArrayBuffer): Promise<JsonResponse<NativeSaved>>;
  endNative(sessionId: string, action: 'pause' | 'stop'): Promise<JsonResponse<NativeStopped>>;
  onNativeFailure(listener: (failure: NativeFailure) => void): () => void;
  /** Proxy a JSON request to the backend with auth attached by main. */
  request<T = unknown>(req: BridgeRequest): Promise<JsonResponse<T>>;
  /** Upload one standalone PCM16 mono WAV window for a session. */
  uploadAudio<T = unknown>(
    sessionId: string,
    meta: AudioUploadMeta,
    wav: ArrayBuffer,
  ): Promise<JsonResponse<T>>;
  /** Bounded transient input for live ASR; never a durable recording. */
  bufferAudio<T = unknown>(
    sessionId: string,
    meta: AudioUploadMeta,
    wav: ArrayBuffer,
  ): Promise<JsonResponse<T>>;
  /** Native picker for one audio file to import. Null when cancelled. */
  chooseAudioFile(): Promise<AudioFileChoice | null>;
  droppedMediaFile?(file: File): AudioFileChoice | null;
  /**
   * Hand one note to the macOS share sheet as a `.md` file, opened at the given
   * point of the window. The text is written to a private temporary file only for
   * the share; nothing in the session folder changes. Resolves false when the
   * platform has no share sheet or the request was refused.
   */
  shareNote?(note: SharedNote): Promise<boolean>;
  /** Tail of the desktop app log file (no session content is written there). */
  readLogs?(): Promise<string>;
  /** Reveal the log directory in the OS file manager. */
  openLogsFolder?(): Promise<boolean>;
  /** Native folder chooser; returns a candidate only, never writes preferences. */
  chooseStorageRoot?(): Promise<string | null>;
  /** Current backend lifecycle phase. */
  getBackendStatus(): Promise<BackendStatus>;
  /** Subscribe to backend lifecycle changes. Returns an unsubscribe fn. */
  onBackendStatus(listener: (status: BackendStatus) => void): () => void;
  /** Report live capture state to main (one-way) so close/quit can be guarded. */
  reportCaptureState?(state: CaptureState): void;
  /** Report how many Codex tasks are still active (one-way) so quit can warn first. */
  reportCodexActivity?(activeTasks: number): void;
  /** Main requests Stop/drain; only the boolean save outcome is returned. */
  onPrepareQuit?(listener: () => Promise<boolean>): () => void;
  onQuitCancelled?(listener: () => void): () => void;
  readonly platform: string;
  /** Whether this OS can capture whole-system audio (macOS 14.2+, Windows). */
  readonly systemAudioSupported?: boolean;
  /** Open the OS privacy pane where system-audio recording is granted. */
  openSystemAudioSettings?(): Promise<boolean>;
}

declare global {
  interface Window {
    skaz: BridgeApi;
  }
}
