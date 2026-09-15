import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { CHANNELS } from './channels';
import { NativeLiveClient } from './nativeLive';
import type { NativeAudioMeta, NativeFailure } from '../frontend/src/api/nativeLive';
import type { BackendManager } from './backend';
import { audioUploadPath, validateAudioUpload, validateBridgeRequest } from './ipcPolicy';
import { isTrustedFrame } from './ipcSender';
import type {
  AudioUploadMeta,
  BinaryResponse,
  BridgeRequest,
  HttpMethod,
  JsonResponse,
} from '../frontend/src/api/bridge';

// Registers the request-scoped IPC handlers. Every call is proxied to the
// loopback backend with the per-run bearer token attached here in main, so the
// renderer never sees the token and can only reach the backend. Every handler
// also verifies the message came from the main frame of the expected main
// window before doing anything.

const ALLOWED_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const REQUEST_TIMEOUT_MS = 120_000;

/** A window-id getter so the guard tracks the current main window lazily. */
type ExpectedWebContentsId = () => number | null;

function buildUrl(port: number, path: string, query?: BridgeRequest['query']): string {
  if (!path.startsWith('/')) {
    throw new Error(`invalid path: ${path}`);
  }
  const url = new URL(`http://127.0.0.1:${port}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function readDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string') return body.detail;
    return `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export function registerIpc(
  manager: BackendManager,
  expectedId: ExpectedWebContentsId,
  onNativeFailure?: (failure: NativeFailure) => void,
): NativeLiveClient {
  const native = new NativeLiveClient(() => manager.getHandle(), onNativeFailure);
  const senderTrusted = (event: IpcMainInvokeEvent): boolean =>
    isTrustedFrame({
      senderId: event.sender.id,
      expectedId: expectedId(),
      isMainFrame: event.senderFrame?.parent === null,
    });

  async function nativeReply<T>(event: IpcMainInvokeEvent, operation: () => Promise<T>): Promise<JsonResponse<T>> {
    if (!senderTrusted(event)) return { ok: false, status: 0, detail: 'untrusted sender' };
    try {
      return { ok: true, status: 200, data: await operation() };
    } catch {
      return { ok: false, status: 0, detail: 'Native stream operation failed; check saved coverage before retry.' };
    }
  }
  ipcMain.handle(CHANNELS.nativeOpen, (event, id: string, rate: number) =>
    nativeReply(event, () => native.open(id, rate)));
  ipcMain.handle(CHANNELS.nativeAudio, (event, id: string, meta: NativeAudioMeta, pcm: ArrayBuffer) =>
    nativeReply(event, () => native.audio(id, meta, pcm)));
  ipcMain.handle(CHANNELS.nativeEnd, (event, id: string, action: 'pause' | 'stop') =>
    nativeReply(event, () => native.end(id, action)));

  ipcMain.handle(CHANNELS.status, (event) => {
    if (!senderTrusted(event)) return { phase: 'error', detail: 'untrusted sender' };
    return manager.getStatus();
  });

  ipcMain.handle(CHANNELS.request, async (event, req: BridgeRequest): Promise<JsonResponse<unknown>> => {
    if (!senderTrusted(event)) return { ok: false, status: 0, detail: 'untrusted sender' };
    const handle = manager.getHandle();
    if (!handle) return { ok: false, status: 0, detail: 'backend not ready' };
    if (!ALLOWED_METHODS.includes(req.method)) {
      return { ok: false, status: 0, detail: `method not allowed: ${req.method}` };
    }
    const policyError = validateBridgeRequest(req);
    if (policyError) return { ok: false, status: 0, detail: policyError };
    try {
      const url = buildUrl(handle.port, req.path, req.query);
      const hasBody = req.body !== undefined && req.method !== 'GET';
      const res = await fetch(url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${handle.token}`,
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, status: res.status, detail: await readDetail(res) };
      const text = await res.text();
      const data = text.length > 0 ? (JSON.parse(text) as unknown) : null;
      return { ok: true, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(
    CHANNELS.uploadAudio,
    async (
      event,
      sessionId: string,
      meta: AudioUploadMeta,
      wav: ArrayBuffer,
    ): Promise<JsonResponse<unknown>> => {
      if (!senderTrusted(event)) return { ok: false, status: 0, detail: 'untrusted sender' };
      const handle = manager.getHandle();
      if (!handle) return { ok: false, status: 0, detail: 'backend not ready' };
      const uploadError = validateAudioUpload(sessionId, meta, wav);
      if (uploadError) return { ok: false, status: 0, detail: uploadError };
      try {
        const url = buildUrl(handle.port, audioUploadPath(sessionId, 'transcribe'), {
          sequence: meta.sequence,
          start_ms: meta.startMs,
          end_ms: meta.endMs,
        });
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${handle.token}`,
            'Content-Type': 'audio/wav',
          },
          body: Buffer.from(wav),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, status: res.status, detail: await readDetail(res) };
        return { ok: true, status: res.status, data: (await res.json()) as unknown };
      } catch (err) {
        return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.storeAudio,
    async (
      event,
      sessionId: string,
      meta: AudioUploadMeta,
      wav: ArrayBuffer,
    ): Promise<JsonResponse<unknown>> => {
      if (!senderTrusted(event)) return { ok: false, status: 0, detail: 'untrusted sender' };
      const handle = manager.getHandle();
      if (!handle) return { ok: false, status: 0, detail: 'backend not ready' };
      const uploadError = validateAudioUpload(sessionId, meta, wav);
      if (uploadError) return { ok: false, status: 0, detail: uploadError };
      try {
        const url = buildUrl(handle.port, audioUploadPath(sessionId, 'store'), {
          sequence: meta.sequence,
          start_ms: meta.startMs,
          end_ms: meta.endMs,
        });
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${handle.token}`,
            'Content-Type': 'audio/wav',
          },
          body: Buffer.from(wav),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, status: res.status, detail: await readDetail(res) };
        return { ok: true, status: res.status, data: (await res.json()) as unknown };
      } catch (err) {
        return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    CHANNELS.fetchAudio,
    async (event, sessionId: string, sequence: number): Promise<BinaryResponse> => {
      if (!senderTrusted(event)) return { ok: false, status: 0, detail: 'untrusted sender' };
      const handle = manager.getHandle();
      if (!handle) return { ok: false, status: 0, detail: 'backend not ready' };
      try {
        const url = buildUrl(
          handle.port,
          `/sessions/${encodeURIComponent(sessionId)}/audio/${encodeURIComponent(String(sequence))}`,
        );
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${handle.token}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, status: res.status, detail: await readDetail(res) };
        return { ok: true, status: res.status, data: await res.arrayBuffer() };
      } catch (err) {
        return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  return native;
}
