import type { BridgeApi, JsonResponse } from './bridge';
import type { NativeAudioMeta, NativeOpened, NativeSaved, NativeStopped } from './nativeLive';
import type { Session, SessionStatus, SessionStatusOptions } from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
  }
}

function unwrap<T>(res: JsonResponse<T>): T {
  if (!res.ok) throw new ApiError(res.status, res.detail);
  return res.data;
}

/**
 * The native recording transport used by `audio/nativeWriter.ts` (and through it the Knowledge
 * Wiki recorder, `kb/recording/capture.ts`): open/append/end over the preload bridge, plus the
 * session status fallback when a pause never acquired a transport. Throws ApiError on non-2xx.
 */
export class ApiClient {
  constructor(private readonly bridge: BridgeApi) {}

  openNative(sessionId: string, sampleRate: number): Promise<NativeOpened> {
    return this.bridge.openNative(sessionId, sampleRate).then(unwrap);
  }

  sendNativeAudio(sessionId: string, meta: NativeAudioMeta, pcm: ArrayBuffer): Promise<NativeSaved> {
    return this.bridge.sendNativeAudio(sessionId, meta, pcm).then(unwrap);
  }

  endNative(sessionId: string, action: 'pause' | 'stop'): Promise<NativeStopped> {
    return this.bridge.endNative(sessionId, action).then(unwrap);
  }

  setSessionStatus(id: string, status: SessionStatus, options: SessionStatusOptions = {}): Promise<Session> {
    const body: { status: SessionStatus } & SessionStatusOptions = { status, ...options };
    return this.bridge
      .request<Session>({ method: 'PATCH', path: `/sessions/${encodeURIComponent(id)}`, body })
      .then(unwrap);
  }
}
