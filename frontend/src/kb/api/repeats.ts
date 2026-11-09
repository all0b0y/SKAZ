// 0.4.0 repeats client. All wire shapes come from OpenAPI.
import type { KbClient } from './client';
import type { KbContinue, KbMaterialRepeats, KbRepeatCheck, KbRepeatCheckStart } from '../../api/kb/types.gen';

export function repeatsMaterial(client: Pick<KbClient, "call">, material_id: string): Promise<KbMaterialRepeats> {
  return client.call('GET /kb/materials/{material_id}/repeats', { path: { material_id } });
}

export function repeatsStart(client: Pick<KbClient, "call">, body: KbRepeatCheckStart): Promise<KbRepeatCheck> {
  return client.call('POST /kb/explore/repeat-checks', { body });
}

export function repeatsCheck(client: Pick<KbClient, "call">, check_id: string): Promise<KbRepeatCheck> {
  return client.call('GET /kb/explore/repeat-checks/{check_id}', { path: { check_id } });
}

export function repeatsPause(client: Pick<KbClient, "call">, check_id: string): Promise<KbRepeatCheck> {
  return client.call('POST /kb/explore/repeat-checks/{check_id}/pause', { path: { check_id } });
}

export function repeatsResume(client: Pick<KbClient, "call">, check_id: string, body: KbContinue): Promise<KbRepeatCheck> {
  return client.call('POST /kb/explore/repeat-checks/{check_id}/continue', { path: { check_id }, body });
}

export function createRepeatsClient(client: Pick<KbClient, "call">) {
  return {
    material: (material_id: string) => repeatsMaterial(client, material_id),
    start: (body: KbRepeatCheckStart) => repeatsStart(client, body),
    check: (check_id: string) => repeatsCheck(client, check_id),
    pause: (check_id: string) => repeatsPause(client, check_id),
    resume: (check_id: string, body: KbContinue) => repeatsResume(client, check_id, body),
  };
}
export type RepeatsClient = ReturnType<typeof createRepeatsClient>;
