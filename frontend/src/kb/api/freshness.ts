// 0.4.0 freshness client. All wire shapes come from OpenAPI.
import type { KbClient } from './client';
import type { KbContinue, KbDatedMaterials, KbLibraryDateQuery, KbLinkCheck, KbLinkCheckStart, KbMaterialPublication } from '../../api/kb/types.gen';

export function freshnessPublication(client: Pick<KbClient, "call">, material_id: string): Promise<KbMaterialPublication> {
  return client.call('GET /kb/materials/{material_id}/publication', { path: { material_id } });
}

export function freshnessFilterDates(client: Pick<KbClient, "call">, body: KbLibraryDateQuery): Promise<KbDatedMaterials> {
  return client.call('POST /kb/materials/by-publication', { body });
}

export function freshnessCheckLinks(client: Pick<KbClient, "call">, body: KbLinkCheckStart): Promise<KbLinkCheck> {
  return client.call('POST /kb/freshness/link-checks', { body });
}

export function freshnessLinkCheck(client: Pick<KbClient, "call">, check_id: string): Promise<KbLinkCheck> {
  return client.call('GET /kb/freshness/link-checks/{check_id}', { path: { check_id } });
}

export function freshnessPause(client: Pick<KbClient, "call">, check_id: string): Promise<KbLinkCheck> {
  return client.call('POST /kb/freshness/link-checks/{check_id}/pause', { path: { check_id } });
}

export function freshnessResume(client: Pick<KbClient, "call">, check_id: string, body: KbContinue): Promise<KbLinkCheck> {
  return client.call('POST /kb/freshness/link-checks/{check_id}/continue', { path: { check_id }, body });
}

export function createFreshnessClient(client: Pick<KbClient, "call">) {
  return {
    publication: (material_id: string) => freshnessPublication(client, material_id),
    filter_dates: (body: KbLibraryDateQuery) => freshnessFilterDates(client, body),
    check_links: (body: KbLinkCheckStart) => freshnessCheckLinks(client, body),
    link_check: (check_id: string) => freshnessLinkCheck(client, check_id),
    pause: (check_id: string) => freshnessPause(client, check_id),
    resume: (check_id: string, body: KbContinue) => freshnessResume(client, check_id, body),
  };
}
export type FreshnessClient = ReturnType<typeof createFreshnessClient>;
