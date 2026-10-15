import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CHANNELS } from './channels';
import { systemAudioSupported } from './systemAudio';
import type {
  AudioFileChoice,
  BackendStatus,
  BridgeApi,
  BridgeRequest,
  CaptureState,
  DictationResult,
  JsonResponse,
  MaterialFileChoice,
  TextFileSave,
} from '../frontend/src/api/bridge';

// The only object exposed to the renderer. Context isolation is on and node
// integration is off, so this is the entire trusted surface. No token, no port,
// no filesystem, no shell — just the narrow backend request channels and status.

const api: BridgeApi = {
  openNative: (sessionId, sampleRate) => ipcRenderer.invoke(CHANNELS.nativeOpen, sessionId, sampleRate),
  sendNativeAudio: (sessionId, meta, pcm) => ipcRenderer.invoke(CHANNELS.nativeAudio, sessionId, meta, pcm),
  endNative: (sessionId, action) => ipcRenderer.invoke(CHANNELS.nativeEnd, sessionId, action),
  onNativeFailure(listener) {
    const handler = (_event: unknown, failure: Parameters<typeof listener>[0]): void => listener(failure);
    ipcRenderer.on(CHANNELS.nativeFailure, handler);
    return () => ipcRenderer.removeListener(CHANNELS.nativeFailure, handler);
  },
  request<T = unknown>(req: BridgeRequest): Promise<JsonResponse<T>> {
    return ipcRenderer.invoke(CHANNELS.request, req) as Promise<JsonResponse<T>>;
  },
  dictate(wav: ArrayBuffer, language?: string): Promise<JsonResponse<DictationResult>> {
    return ipcRenderer.invoke(CHANNELS.dictate, wav, language) as Promise<JsonResponse<DictationResult>>;
  },
  saveTextFile(file: TextFileSave): Promise<{ saved: boolean; path?: string }> {
    return ipcRenderer.invoke(CHANNELS.saveTextFile, { suggested_name: file.suggested_name, text: file.text }) as Promise<{ saved: boolean; path?: string }>;
  },
  chooseMaterialFiles(): Promise<MaterialFileChoice[]> {
    return ipcRenderer.invoke(CHANNELS.chooseMaterialFiles) as Promise<MaterialFileChoice[]>;
  },
  openLogsFolder(): Promise<boolean> {
    return ipcRenderer.invoke(CHANNELS.openLogsFolder) as Promise<boolean>;
  },
  // Only where System Settings has these panes (macOS): elsewhere the button is not offered at all.
  ...(process.platform === 'darwin' ? {
    openSystemAudioSettings(pane: 'microphone' | 'system-audio'): Promise<boolean> {
      return ipcRenderer.invoke(CHANNELS.openSystemAudioSettings, pane) as Promise<boolean>;
    },
  } : {}),
  restartBackend(): Promise<boolean> {
    return ipcRenderer.invoke(CHANNELS.restartBackend) as Promise<boolean>;
  },
  chooseStorageRoot(): Promise<string | null> {
    return ipcRenderer.invoke(CHANNELS.chooseStorageRoot) as Promise<string | null>;
  },
  chooseAudioFile(): Promise<AudioFileChoice | null> {
    return ipcRenderer.invoke(CHANNELS.chooseAudioFile) as Promise<AudioFileChoice | null>;
  },
  droppedMediaFile(file: File): AudioFileChoice | null {
    const path = webUtils.getPathForFile(file);
    // Sandboxed preloads cannot import Node path/url. Metadata is read by the backend.
    return path ? { path, name: file.name } : null;
  },
  getBackendStatus(): Promise<BackendStatus> {
    return ipcRenderer.invoke(CHANNELS.status) as Promise<BackendStatus>;
  },
  onBackendStatus(listener: (status: BackendStatus) => void): () => void {
    const handler = (_event: unknown, status: BackendStatus): void => listener(status);
    ipcRenderer.on(CHANNELS.statusEvent, handler);
    return () => ipcRenderer.removeListener(CHANNELS.statusEvent, handler);
  },
  reportCaptureState(state: CaptureState): void {
    ipcRenderer.send(CHANNELS.captureState, state);
  },
  onPrepareQuit(listener) {
    const handler = (_event: unknown, id: unknown): void => {
      if (!Number.isSafeInteger(id)) return;
      void Promise.resolve().then(listener).then(
        (saved) => ipcRenderer.send(CHANNELS.quitPrepared, id, saved === true),
        () => ipcRenderer.send(CHANNELS.quitPrepared, id, false),
      );
    };
    ipcRenderer.on(CHANNELS.prepareQuit, handler);
    return () => ipcRenderer.removeListener(CHANNELS.prepareQuit, handler);
  },
  platform: process.platform,
  systemAudioSupported: systemAudioSupported(process.platform, process.getSystemVersion()),
};

contextBridge.exposeInMainWorld('skaz', api);
