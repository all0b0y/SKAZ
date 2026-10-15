// Typed client for the new /kb/* routes over the existing preload bridge (window.skaz.request).
// Paths, queries, bodies and responses come from the generated contract (types.gen.ts), plus the
// package-2 routes not generated yet (b2.ts, same names), so a backend change that breaks the
// frontend fails `npm run typecheck`.

import type { BridgeApi, HttpMethod } from '../../api/bridge';
import type {
  KbEndpoints, KbFolder, KbLibrary, KbMaterial, KbMaterialSummary,
} from '../../api/kb/types.gen';
import type { B2Endpoints, KbNotification, KbNotificationFeed } from './b2';

/** A failed /kb request: HTTP status and the backend's plain-English reason, shown to the user as is. */
export class KbApiError extends Error {
  constructor(public readonly status: number, public readonly detail: string) {
    super(detail);
    this.name = 'KbApiError';
  }
}

/** Generated routes, with the package-2 shapes taking precedence where a route changed. */
export type AllEndpoints = Omit<KbEndpoints, keyof B2Endpoints> & B2Endpoints;
export type AnyRoute = keyof AllEndpoints;

type Spec<R extends AnyRoute> = AllEndpoints[R];
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

function normalizeNotification(n: Partial<KbNotification>, index: number): KbNotification {
  return {
    id: String(n.id ?? `n${index}`),
    seq: typeof n.seq === 'number' ? n.seq : 0,
    kind: String(n.kind ?? 'other'),
    title: String(n.title ?? ''),
    body: String(n.body ?? ''),
    payload: (n.payload ?? {}) as Record<string, unknown>,
    requires_action: n.requires_action === true,
    actions: Array.isArray(n.actions) ? n.actions : [],
    subject: n.subject ?? null,
    created_at: String(n.created_at ?? ''),
    dismissed_at: n.dismissed_at ?? null,
    resolved_at: n.resolved_at ?? null,
    resolution: n.resolution ?? null,
  };
}

/**
 * The feed of package 2 (`KbNotificationFeed`). Until W2 is merged the backend still answers with a
 * plain list; it is read as a feed without a cursor so the bell keeps counting. Missing fields get
 * their neutral value — nothing is invented.
 */
export function toFeed(data: unknown): KbNotificationFeed {
  if (Array.isArray(data)) {
    const items = (data as Array<Partial<KbNotification>>).map(normalizeNotification);
    const live = items.filter((n) => !n.dismissed_at);
    return {
      items,
      cursor: 0,
      unread: live.length,
      requires_action: live.filter((n) => n.requires_action && !n.resolved_at).length,
    };
  }
  const feed = (data ?? {}) as Partial<KbNotificationFeed>;
  return {
    items: (feed.items ?? []).map(normalizeNotification),
    cursor: typeof feed.cursor === 'number' ? feed.cursor : 0,
    unread: typeof feed.unread === 'number' ? feed.unread : 0,
    requires_action: typeof feed.requires_action === 'number' ? feed.requires_action : 0,
  };
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
    if (!res.ok) throw new KbApiError(res.status, res.detail || `Request failed (${res.status}).`);
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
  async notifications(after?: number, wait?: number): Promise<KbNotificationFeed> {
    const data: unknown = await this.call('GET /kb/notifications', { query: { after, wait } });
    return toFeed(data);
  }
}

/** Plain-English text for any failure, for showing in place. */
export function errorText(error: unknown): string {
  if (error instanceof KbApiError) return error.detail;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Try again.';
}
