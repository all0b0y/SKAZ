import type { JsonResponse } from '../frontend/src/api/bridge';

/** Preserve the typed visual refusal from chat admission for the renderer. */
export async function readRequestFailure(res: Response): Promise<Omit<Extract<JsonResponse<never>, { ok: false }>, 'ok' | 'status'>> {
  try {
    const body = (await res.json()) as { detail?: unknown; error_code?: unknown; code?: unknown };
    const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${res.status}`;
    const code = typeof body?.error_code === 'string' ? body.error_code
      : typeof body?.code === 'string' ? body.code : undefined;
    if (res.status === 422 && (code === 'VISUAL_UNSUPPORTED' || code === 'VISUAL_TEXT_ONLY_UNAVAILABLE')) {
      return { detail, code, errorData: body };
    }
    return code === undefined ? { detail } : { detail, code };
  } catch {
    return { detail: `HTTP ${res.status}` };
  }
}
