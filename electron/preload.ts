import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from './channels';
import type {
  AudioUploadMeta,
  BackendStatus,
  BinaryResponse,
  BridgeApi,
  BridgeRequest,
  CaptureState,
  JsonResponse,
} from '../frontend/src/api/bridge';

// The only object exposed to the renderer. Context isolation is on and node
// integration is off, so this is the entire trusted surface. No token, no port,
// no filesystem, no shell — just the four backend request channels and status.

const api: BridgeApi = {
  request<T = unknown>(req: BridgeRequest): Promise<JsonResponse<T>> {
    return ipcRenderer.invoke(CHANNELS.request, req) as Promise<JsonResponse<T>>;
  },
  uploadAudio<T = unknown>(
    sessionId: string,
    meta: AudioUploadMeta,
    wav: ArrayBuffer,
  ): Promise<JsonResponse<T>> {
    return ipcRenderer.invoke(CHANNELS.uploadAudio, sessionId, meta, wav) as Promise<JsonResponse<T>>;
  },
  fetchAudio(sessionId: string, sequence: number): Promise<BinaryResponse> {
    return ipcRenderer.invoke(CHANNELS.fetchAudio, sessionId, sequence) as Promise<BinaryResponse>;
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
  platform: process.platform,
};

contextBridge.exposeInMainWorld('audiohelper', api);
