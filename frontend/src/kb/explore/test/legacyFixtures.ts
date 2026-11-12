// Historical UI journeys retain their synthetic titles, with explicit EX2 own-topic shapes.
// This adapter belongs to X4's tests; shared fake scenes are integrated by the coordinator.
import type { KbArea, KbAreaMap, KbSearchPlanRequest } from '../../../api/kb/types.gen';
import { createFakeKb as originalKb } from '../../api/fake';
import { contractFixtures as f } from '../../api/fake/fixtures';
import { scenes as originalScenes, type ExploreScene, type SceneName } from '../../api/fake/scenes';
const own = (area: KbArea): KbArea => ({ ...area, level: 'custom', taxonomy_id: null, topic_ids: [], materials: area.pages });
const ownMap = (map: KbAreaMap): KbAreaMap => ({ ...map, areas: map.areas.map(own), breadcrumbs: map.breadcrumbs.map(own), worth_closing: [] });
export const scenes = Object.fromEntries(Object.entries(originalScenes).map(([name, scene]) => [name, { ...scene, ...('map' in scene && scene.map ? { map: ownMap(scene.map) } : {}) }])) as typeof originalScenes;

export function createFakeKb(name?: SceneName) {
  const kb = originalKb(name);
  const read = kb.areas.map;
  const scene: ExploreScene = name ? scenes[name] : {};
  const map = scene.map ?? f.KbAreaMap;
  return { ...kb, areas: { ...kb.areas, map: async (query?: Parameters<typeof read>[0]) => ownMap(await read(query)) },
    topics: { sort: async () => structuredClone(f.KbTopicLabelling), merge: async () => structuredClone(f.KbArea), move: async () => structuredClone(f.KbMaterialTopic) },
    discovery: {
      plan: async (request: KbSearchPlanRequest) => {
        const label = request.query || [...(map?.areas ?? []), ...(map?.breadcrumbs ?? [])].find((area) => area.id === request.area_id)?.name || 'Your topics';
        return { items: [{ area_id: request.area_id ?? null, label, terms: [label] }], ready: true, reason: null };
      },
      candidates: async () => ({ items: [], next_cursor: null }), fits: async () => structuredClone(f.KbFunnelCandidate), concepts: async () => [],
    },
  };
}
