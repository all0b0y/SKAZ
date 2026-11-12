import type { KbArea } from '../../api/kb/types.gen';
import type { AreasClient } from '../api/areas';

export interface TopicOption { area: KbArea; path: string; ancestors: string[] }
export const ownTopics = (areas: readonly KbArea[]) => areas.filter((area) => area.level === 'custom' && !area.hidden);

/** GET map reads stored state only. Traverse all advertised children, including empty named topics. */
export async function loadTopicOptions(client: Pick<AreasClient, 'map'>): Promise<TopicOption[]> {
  const options: TopicOption[] = [];
  const seen = new Set<string>();
  const queue: { parentId: string | null; names: string[]; ancestors: string[] }[] = [{ parentId: null, names: [], ancestors: [] }];
  while (queue.length) {
    const branch = queue.shift()!;
    const map = await client.map(branch.parentId ? { parent_id: branch.parentId } : {});
    for (const area of ownTopics(map.areas)) {
      if (seen.has(area.id)) continue;
      seen.add(area.id);
      const names = [...branch.names, area.name];
      options.push({ area, path: names.join(' › '), ancestors: branch.ancestors });
      if (area.has_children) queue.push({ parentId: area.id, names, ancestors: [...branch.ancestors, area.id] });
    }
  }
  return options;
}
