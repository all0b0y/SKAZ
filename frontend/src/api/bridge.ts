// Contract for the preload bridge (window.skaz). This is the ONLY
// surface the renderer uses to reach the managed Python backend. The renderer
// never learns the per-run token or the backend port: the main process owns
// both and attaches the Authorization header to every proxied request. The
// bridge can therefore only reach the loopback backend, nothing else.

import type { NativeAudioMeta, NativeFailure, NativeOpened, NativeSaved, NativeStopped } from './nativeLive';
import type { KbDictation } from './kb/types.gen';

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

/** Containers Soniox documents for automatic format detection on file input. */
export const AUDIO_EXTENSIONS = [
  'aac', 'aiff', 'amr', 'asf', 'flac', 'm4a', 'mp3', 'mp4', 'ogg', 'wav', 'webm',
] as const;

/** A file the user picked for import. Only the identity crosses IPC: the audio
 * itself is read by the backend from this path, never streamed through the renderer. */
export interface AudioFileChoice {
  path: string;
  name: string;
}

export type BackendPhase = 'starting' | 'ready' | 'error' | 'stopped';

export interface BackendStatus {
  phase: BackendPhase;
  detail?: string;
  /** Extra guidance for a failed start; development builds only. */
  hint?: string;
}

/** Live capture snapshot the renderer pushes to main so a close/quit can be
 * guarded when unsent audio still exists. */
export interface CaptureState {
  recorderState: 'idle' | 'recording' | 'paused' | 'processing' | 'stopped';
  pending: number;
  failed: number;
}

/** Text recognised from one dictation clip (`POST /kb/dictation`, generated `KbDictation`); nothing is stored. */
export type DictationResult = KbDictation;

/** A text file the user saves through the native dialog (chat export as `.md`). */
export interface TextFileSave {
  suggested_name: string;
  text: string;
}

/** A material file picked in the native chooser. Only identity crosses IPC; the backend reads it. */
export interface MaterialFileChoice {
  path: string;
  name: string;
  size: number;
}

/** File types the "+ Material" chooser offers: documents, text, audio and video. */
export const MATERIAL_EXTENSIONS = [
  'pdf', 'txt', 'md', 'markdown', 'rtf', 'html', 'htm', 'epub',
  ...AUDIO_EXTENSIONS, 'mkv', 'mov', 'avi', 'm4v',
] as const;

export interface BridgeApi {
  /**
   * Dictation into the message field: one PCM16 mono WAV clip (≤ 120 s, ≤ 8 MB) is posted by main to
   * `POST /kb/dictation` with the run's authorization. The answer is text only.
   */
  dictate?(wav: ArrayBuffer, language?: string): Promise<JsonResponse<DictationResult>>;
  /** Native save dialog for a text file; `saved: false` when the user cancelled. */
  saveTextFile?(file: TextFileSave): Promise<{ saved: boolean; path?: string }>;
  /** Native chooser for material files (PDF, text, audio, video); empty when cancelled. */
  chooseMaterialFiles?(): Promise<MaterialFileChoice[]>;
  /** Native PCM lifecycle, authenticated and bounded in Electron main. */
  openNative(sessionId: string, sampleRate: number): Promise<JsonResponse<NativeOpened>>;
  sendNativeAudio(sessionId: string, meta: NativeAudioMeta, pcm: ArrayBuffer): Promise<JsonResponse<NativeSaved>>;
  endNative(sessionId: string, action: 'pause' | 'stop'): Promise<JsonResponse<NativeStopped>>;
  onNativeFailure(listener: (failure: NativeFailure) => void): () => void;
  /** Proxy a JSON request to the backend with auth attached by main. */
  request<T = unknown>(req: BridgeRequest): Promise<JsonResponse<T>>;
  /** Native picker for one audio file to import. Null when cancelled. */
  chooseAudioFile(): Promise<AudioFileChoice | null>;
  droppedMediaFile?(file: File): AudioFileChoice | null;
  /** Reveal the log directory in the OS file manager. */
  openLogsFolder?(): Promise<boolean>;
  /** macOS only: open the privacy pane that grants microphone or screen & system audio capture. */
  openSystemAudioSettings?(pane: 'microphone' | 'system-audio'): Promise<boolean>;
  /** Start the local service again after a failed start; false when there is nothing to retry. */
  restartBackend?(): Promise<boolean>;
  /** Native folder chooser; returns a candidate only, never writes preferences. */
  chooseStorageRoot?(): Promise<string | null>;
  /** Current backend lifecycle phase. */
  getBackendStatus(): Promise<BackendStatus>;
  /** Subscribe to backend lifecycle changes. Returns an unsubscribe fn. */
  onBackendStatus(listener: (status: BackendStatus) => void): () => void;
  /** Report live capture state to main (one-way) so close/quit can be guarded. */
  reportCaptureState?(state: CaptureState): void;
  /** Main requests Stop/drain; only the boolean save outcome is returned. */
  onPrepareQuit?(listener: () => Promise<boolean>): () => void;
  /** Whether this OS can capture whole-system audio (macOS 14.2+, Windows). */
  readonly systemAudioSupported?: boolean;
}

declare global {
  interface Window {
    skaz: BridgeApi;
  }
}
