// Typed client for the new /kb/* routes over the existing preload bridge (window.skaz.request).
// Paths, queries, bodies and responses come from the generated contract (types.gen.ts, made from
// the backend OpenAPI schema), so a backend change that breaks the frontend fails `npm run typecheck`.

import type { BridgeApi, HttpMethod } from '../../api/bridge';
import type {
  KbCompatibleModel, KbEndpoints, KbFolder, KbLibrary, KbMaterial, KbMaterialSummary, KbNotificationFeed,
  KbVisualPreflightResponse,
} from '../../api/kb/types.gen';

/** A failed /kb request: HTTP status and the backend's plain-English reason, shown to the user as is. */
export class KbApiError extends Error {
  /** `code`: the backend's `error_code` when it sends one (W-3: `web_page_unavailable`). */
  constructor(
    public readonly status: number,
    public readonly detail: string,
    public readonly code?: string,
    public readonly visualRefusal?: KbVisualPreflightResponse,
  ) {
    super(detail);
    this.name = 'KbApiError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const isEngine = (value: unknown): value is KbVisualPreflightResponse['engine'] =>
  value === 'codex' || value === 'claude_code' || value === 'hermes' || value === 'opencode';
const isNullableNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value));

function isCompatibleModel(value: unknown): value is KbCompatibleModel {
  return isRecord(value) && isEngine(value.engine) && typeof value.model_id === 'string'
    && typeof value.label === 'string' && typeof value.provider === 'string';
}

function visualRefusal(
  status: number, code: string | undefined, detail: string, data: unknown,
): KbVisualPreflightResponse | undefined {
  if (status !== 422 || (code !== 'VISUAL_UNSUPPORTED' && code !== 'VISUAL_TEXT_ONLY_UNAVAILABLE')
    || !isRecord(data)) return;
  const { engine, model_id, reason_code, title, locator, text_only_available, compatible_models } = data;
  if (!isEngine(engine) || !(typeof model_id === 'string' || model_id === null)
    || typeof reason_code !== 'string' || typeof title !== 'string' || !isRecord(locator)
    || typeof locator.material_id !== 'string' || typeof locator.label !== 'string'
    || typeof locator.source_kind !== 'string' || !isNullableNumber(locator.page)
    || !isNullableNumber(locator.timestamp_ms) || typeof text_only_available !== 'boolean'
    || !Array.isArray(compatible_models) || !compatible_models.every(isCompatibleModel)) return;
  return {
    engine, model_id, reason_code, title, detail, compatible_models,
    text_only_available: code === 'VISUAL_UNSUPPORTED' && text_only_available,
    requires_visual: true, supported: false, state: 'unsupported', draft_preserved: true,
    locator: {
      material_id: locator.material_id, source_kind: locator.source_kind, label: locator.label,
      page: locator.page, timestamp_ms: locator.timestamp_ms,
    },
  };
}

export type AnyRoute = keyof KbEndpoints;

type Spec<R extends AnyRoute> = KbEndpoints[R];
type QueryValue = string | number | boolean | undefined;

interface CallOptions<R extends AnyRoute> {
  path?: Spec<R>['path'];
  query?: Partial<Spec<R>['query']>;
  body?: Spec<R>['body'];
}

/** Fill `{param}` segments; every value is percent-encoded so it stays one path segment. */
export function buildPath(template: string, params: Record<string, string | number> | undefined): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = params?.[key];
    if (value === undefined || value === '') throw new Error(`Missing path parameter: ${key}`);
    return encodeURIComponent(String(value));
  });
}

function cleanQuery(query: Record<string, unknown> | undefined): Record<string, QueryValue> | undefined {
  if (!query) return undefined;
  const out: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export class KbClient {
  constructor(private readonly bridge: Pick<BridgeApi, 'request'>) {}

  async call<R extends AnyRoute>(route: R, options: CallOptions<R> = {}): Promise<Spec<R>['response']> {
    const space = route.indexOf(' ');
    const method = route.slice(0, space) as HttpMethod;
    const template = route.slice(space + 1);
    const path = buildPath(template, options.path as Record<string, string> | undefined);
    const res = await this.bridge.request<Spec<R>['response']>({
      method,
      path,
      query: cleanQuery(options.query as Record<string, unknown> | undefined),
      body: options.body,
    });
    if (!res.ok) {
      const detail = res.detail || `Request failed (${res.status}).`;
      throw new KbApiError(res.status, detail, res.code, visualRefusal(res.status, res.code, detail, res.errorData));
    }
    return res.data;
  }

  library(): Promise<KbLibrary> { return this.call('GET /kb/library'); }
  connectLibrary(path: string | null): Promise<KbLibrary> { return this.call('POST /kb/library', { body: { path } }); }
  retryLibrary(): Promise<KbLibrary> { return this.call('POST /kb/library/retry'); }

  folders(): Promise<KbFolder[]> { return this.call('GET /kb/folders'); }
  createFolder(name: string): Promise<KbFolder> { return this.call('POST /kb/folders', { body: { name } }); }
  renameFolder(id: string, name: string): Promise<KbFolder> {
    return this.call('PATCH /kb/folders/{folder_id}', { path: { folder_id: id }, body: { name } });
  }
  async deleteFolder(id: string): Promise<void> {
    await this.call('DELETE /kb/folders/{folder_id}', { path: { folder_id: id } });
  }

  materials(folderId?: string): Promise<KbMaterialSummary[]> {
    return this.call('GET /kb/materials', { query: folderId ? { folder_id: folderId } : {} });
  }
  material(id: string): Promise<KbMaterial> {
    return this.call('GET /kb/materials/{material_id}', { path: { material_id: id } });
  }

  /** Long poll: `after` = last seen cursor, `wait` = seconds at most (omitted = answer at once). */
  notifications(after?: number, wait?: number): Promise<KbNotificationFeed> {
    return this.call('GET /kb/notifications', { query: { after, wait } });
  }
}

/** Plain-English text for any failure, for showing in place. */
export function errorText(error: unknown): string {
  if (error instanceof KbApiError) return error.detail;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Try again.';
}
