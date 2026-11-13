// The whole fake API, optionally showing one scene. It never touches the bridge or the network.
import { createFakeAreasClient } from './areas';
import { createFakeExploreClient } from './explore';
import { createFakeFreshnessClient } from './freshness';
import { createFakeMaintenanceClient } from './maintenance';
import { createFakeRepeatsClient } from './repeats';
import { createFakeScienceClient } from './science';
import { scenes, type ExploreScene, type SceneName } from './scenes';

function answer<A extends unknown[], T>(value: T | undefined, fallback: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  return value === undefined ? fallback : async () => structuredClone(value);
}

export function createFakeKb(name?: SceneName) {
  const scene: ExploreScene = name === undefined ? {} : scenes[name];
  const areas = createFakeAreasClient();
  const explore = createFakeExploreClient();
  const freshness = createFakeFreshnessClient();
  const maintenance = createFakeMaintenanceClient();
  const repeats = createFakeRepeatsClient();
  return {
    science: createFakeScienceClient(),
    areas: { ...areas, map: answer(scene.map, areas.map), materials: answer(scene.materials, areas.materials) },
    explore: { ...explore, run: answer(scene.run, explore.run), jobs: answer(scene.jobs, explore.jobs),
      findings: answer(scene.findings, explore.findings), finding: answer(scene.finding, explore.finding) },
    freshness: { ...freshness, link_check: answer(scene.linkCheck, freshness.link_check) },
    maintenance: { ...maintenance, marks: answer(scene.freshness, maintenance.marks),
      page_marks: answer(scene.freshness, maintenance.page_marks), check: answer(scene.weekly, maintenance.check),
      settings: answer(scene.weeklySettings, maintenance.settings) },
    repeats: { ...repeats, material: answer(scene.repeats, repeats.material), check: answer(scene.repeatCheck, repeats.check) },
  };
}
export type FakeKb = ReturnType<typeof createFakeKb>;
