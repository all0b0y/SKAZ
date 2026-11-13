// 0.4.0 areas client. All wire shapes come from OpenAPI.
import type { KbClient } from './client';
import type { KbAcknowledged, KbArea, KbAreaCreate, KbAreaMap, KbAreaMaterials, KbAreaUpdate, KbReadMark, KbReadMarkUpdate, KbSignals } from '../../api/kb/types.gen';

export function areasMap(client: Pick<KbClient, "call">, query: { parent_id?: string; include_hidden?: boolean } = {}): Promise<KbAreaMap> {
  return client.call('GET /kb/explore/map', { query });
}

export function areasCreate(client: Pick<KbClient, "call">, body: KbAreaCreate): Promise<KbArea> {
  return client.call('POST /kb/explore/areas', { body });
}

export function areasUpdate(client: Pick<KbClient, "call">, area_id: string, body: KbAreaUpdate): Promise<KbArea> {
  return client.call('PATCH /kb/explore/areas/{area_id}', { path: { area_id }, body });
}

export function areasMaterials(client: Pick<KbClient, "call">, area_id: string, query: { cursor?: string; limit?: number } = {}): Promise<KbAreaMaterials> {
  return client.call('GET /kb/explore/areas/{area_id}/materials', { path: { area_id }, query });
}

export function areasReadMark(client: Pick<KbClient, "call">, material_id: string): Promise<KbReadMark> {
  return client.call('GET /kb/materials/{material_id}/read-mark', { path: { material_id } });
}

export function areasSetReadMark(client: Pick<KbClient, "call">, material_id: string, body: KbReadMarkUpdate): Promise<KbReadMark> {
  return client.call('PUT /kb/materials/{material_id}/read-mark', { path: { material_id }, body });
}

export function areasRemoveReadMark(client: Pick<KbClient, "call">, material_id: string): Promise<KbReadMark> {
  return client.call('DELETE /kb/materials/{material_id}/read-mark', { path: { material_id } });
}

export function areasSignals(client: Pick<KbClient, "call">, query: { cursor?: string; limit?: number } = {}): Promise<KbSignals> {
  return client.call('GET /kb/explore/signals', { query });
}

export function areasDelete(client: Pick<KbClient, "call">, area_id: string): Promise<KbAcknowledged> {
  return client.call('DELETE /kb/explore/areas/{area_id}', { path: { area_id } });
}

export function areasOpened(client: Pick<KbClient, "call">, area_id: string): Promise<KbAcknowledged> {
  return client.call('POST /kb/explore/areas/{area_id}/opened', { path: { area_id } });
}

export function createAreasClient(client: Pick<KbClient, "call">) {
  return {
    delete: (area_id: string) => areasDelete(client, area_id),
    opened: (area_id: string) => areasOpened(client, area_id),
    map: (query: { parent_id?: string; include_hidden?: boolean } = {}) => areasMap(client, query),
    create: (body: KbAreaCreate) => areasCreate(client, body),
    update: (area_id: string, body: KbAreaUpdate) => areasUpdate(client, area_id, body),
    materials: (area_id: string, query: { cursor?: string; limit?: number } = {}) => areasMaterials(client, area_id, query),
    read_mark: (material_id: string) => areasReadMark(client, material_id),
    set_read_mark: (material_id: string, body: KbReadMarkUpdate) => areasSetReadMark(client, material_id, body),
    remove_read_mark: (material_id: string) => areasRemoveReadMark(client, material_id),
    signals: (query: { cursor?: string; limit?: number } = {}) => areasSignals(client, query),
  };
}
export type AreasClient = ReturnType<typeof createAreasClient>;
