import type { AreasClient } from '../areas';
import { contractFixtures as f } from './fixtures';

export function createFakeAreasClient(): AreasClient {
  return {
    delete: async () => structuredClone(f.KbAcknowledged),
    opened: async () => structuredClone(f.KbAcknowledged),
    map: async () => structuredClone(f.KbAreaMap),
    create: async () => structuredClone(f.KbArea),
    update: async () => structuredClone(f.KbArea),
    materials: async () => structuredClone(f.KbAreaMaterials),
    read_mark: async () => structuredClone(f.KbReadMark),
    set_read_mark: async () => structuredClone(f.KbReadMark),
    remove_read_mark: async () => structuredClone(f.KbReadMark),
    signals: async () => structuredClone(f.KbSignals),
  };
}
