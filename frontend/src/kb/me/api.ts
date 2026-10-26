// N6 «Я» (Me) routes over the shared /kb client, typed by the generated contract (types.gen.ts).

import type { KbClient } from '../api/client';
import type {
  KbMe, KbMeCreate, KbMeSkillDetail, KbMeUpdate, KbMemoryPart, KbMeVersions,
} from '../../api/kb/types.gen';

export const readMe = (client: KbClient): Promise<KbMe> => client.call('GET /kb/me');

export const switchMe = (client: KbClient, enabled: boolean): Promise<KbMe> =>
  client.call('PUT /kb/me', { body: { enabled } });

export const readMeSkill = (client: KbClient, id: string): Promise<KbMeSkillDetail> =>
  client.call('GET /kb/me/skills/{skill_id}', { path: { skill_id: id } });

export const updateMeSkill = (client: KbClient, id: string, body: KbMeUpdate): Promise<KbMeSkillDetail> =>
  client.call('PUT /kb/me/skills/{skill_id}', { path: { skill_id: id }, body });

export const createMeSkill = (client: KbClient, body: KbMeCreate): Promise<KbMeSkillDetail> =>
  client.call('POST /kb/me/skills', { body });

export async function deleteMeSkill(client: KbClient, id: string): Promise<void> {
  await client.call('DELETE /kb/me/skills/{skill_id}', { path: { skill_id: id } });
}

export const meSkillVersions = (client: KbClient, id: string): Promise<KbMeVersions> =>
  client.call('GET /kb/me/skills/{skill_id}/versions', { path: { skill_id: id } });

export const restoreMeVersion = (client: KbClient, id: string, version: number): Promise<KbMeSkillDetail> =>
  client.call('POST /kb/me/skills/{skill_id}/versions/{version}/restore', { path: { skill_id: id, version } });

export const undoMeEdit = (client: KbClient, editId: string): Promise<KbMeSkillDetail> =>
  client.call('POST /kb/me/edits/{edit_id}/undo', { path: { edit_id: editId } });

/** A message part is an agent's edit of «Я». */
export const isMemoryPart = (part: { type: string }): part is KbMemoryPart => (part as { type: string }).type === 'memory';

/** The built-in «Я» skills whose additions read «Remembered: …» (N6-ME-API.md). */
const REMEMBERED_IN = new Set(['profile', 'how-to-work', 'search']);

/** The chip's line: «Remembered: <summary>» for an addition to a built-in, «Updated skill "<title>"» otherwise. */
export function memoryChipText(part: KbMemoryPart): string {
  const remembered = REMEMBERED_IN.has(part.skill_id) && (part.action === 'append' || part.action === 'create');
  return remembered ? `Remembered: ${part.summary}` : `Updated skill “${part.skill_title}”`;
}
