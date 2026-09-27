import type { BridgeRequest } from './bridge';
import { ApiError } from './client';

export interface SearchSettings { provider: 'brave'; enabled: boolean; has_key: boolean; available: boolean }
export interface SearchApproval { id: string; task_id: string; chat_id: string; query: string }

async function request<T>(req: BridgeRequest): Promise<T> {
  const result = await window.skaz.request<T>(req);
  if (!result.ok) throw new ApiError(result.status, result.detail);
  return result.data;
}
export const webSearch = {
  settings: () => request<SearchSettings>({ method: 'GET', path: '/web-search/settings' }),
  configure: (enabled: boolean, apiKey?: string) => request<SearchSettings>({
    method: 'PUT', path: '/web-search/settings',
    body: { enabled, ...(apiKey !== undefined ? { api_key: apiKey } : {}) },
  }),
  pending: () => request<{ requests: SearchApproval[] }>({ method: 'GET', path: '/web-search/pending' }),
  decide: (p: SearchApproval, approved: boolean) => request<{ accepted: boolean }>({
    method: 'POST', path: `/web-search/requests/${encodeURIComponent(p.id)}/decision`,
    body: { chat_id: p.chat_id, query: p.query, approved },
  }),
};
