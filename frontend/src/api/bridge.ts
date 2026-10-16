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
  /** The backend had been running and then stopped (crashed, killed): not a failed start. */
  stopped?: boolean;
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

/** Documents the backend reads (`sources/intake.py` PDF_EXTENSIONS | TEXT_EXTENSIONS). */
export const DOCUMENT_EXTENSIONS = ['pdf', 'txt', 'md', 'markdown'] as const;
/** Audio and video the speech import takes (`speech/media.py`: the provider list + video containers). */
export const SPEECH_EXTENSIONS = [...AUDIO_EXTENSIONS, 'mkv', 'mov', 'avi', 'm4v'] as const;
/** Video containers among them (`speech/media.py` VIDEO_EXTENSIONS). */
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi'] as const;

/** File types the "+ Material" chooser offers: only what the backend takes (QA B2). Documents go to
 * `/kb/materials/file`, audio and video to the speech import (`/kb/imports`). */
export const MATERIAL_EXTENSIONS = [...DOCUMENT_EXTENSIONS, ...SPEECH_EXTENSIONS] as const;

/** macOS privacy state of SKAZ for a capture kind (`systemPreferences.getMediaAccessStatus`). */
export type MediaAccessStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

/** Microphone and Screen & System Audio Recording permission of SKAZ, read by main. */
export interface MediaAccess {
  microphone: MediaAccessStatus;
  screen: MediaAccessStatus;
}

/** What "Show in Finder" / "Open in Obsidian" may open: named targets only, main resolves the path. */
export type RevealTarget = { kind: 'library' } | { kind: 'page'; id: string } | { kind: 'export'; path: string };

export type UpdatePhase =
  | 'off' | 'idle' | 'checking' | 'up_to_date' | 'couldnt_check' | 'available'
  | 'downloading' | 'verifying' | 'ready' | 'installing' | 'failed';

/** Updates (B20), as main reports them: the check of GitHub Releases, the download and its checks. */
export interface UpdateState {
  current: string;
  phase: UpdatePhase;
  /** The newer version and its release page, once known. */
  available: { version: string; page: string } | null;
  checkedAt: string | null;
  /** 0..1 while downloading. */
  progress: number | null;
  /** Why the download, its checks or the install failed ("Couldn't check" after a failed check). */
  error: string | null;
  /** False in development builds and in runs with update checks off: Update says why instead. */
  canInstall: boolean;
  disabledReason: string | null;
}

export type ObsidianFailure = 'not_installed' | 'unavailable' | 'obsidian_running' | 'obsidian_config';

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
  /** macOS: whether SKAZ may use the microphone and record screen & system audio (read only, asks nothing). */
  mediaAccess?(): Promise<MediaAccess>;
  /** Start the local service again after a failed start; false when there is nothing to retry. */
  restartBackend?(): Promise<boolean>;
  /** Native folder chooser for an export (B20); the chosen folder becomes one "Show in Finder" may open. */
  chooseExportFolder?(): Promise<string | null>;
  /** Reveal a library target in Finder (the library, a wiki page's file, a folder chosen for an export). */
  showInFinder?(target: RevealTarget): Promise<boolean>;
  /**
   * Open the library (as a vault) or one page in Obsidian; `not_installed` when Obsidian isn't on this
   * Mac; `obsidian_running` when Obsidian is open and doesn't know the library yet — `restart: true`
   * (the user's yes) lets SKAZ quit it, add the library as a vault and open it.
   */
  openInObsidian?(
    target: { kind: 'library' } | { kind: 'page'; id: string }, options?: { restart?: boolean },
  ): Promise<{ ok: true } | { ok: false; reason: ObsidianFailure }>;
  /** Updates (B20): the current state, "Check now", download + verify, install (SKAZ closes), changes. */
  updateState?(): Promise<UpdateState>;
  checkForUpdates?(): Promise<UpdateState>;
  prepareUpdate?(): Promise<UpdateState>;
  installUpdate?(): Promise<boolean>;
  onUpdateState?(listener: (state: UpdateState) => void): () => void;
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
