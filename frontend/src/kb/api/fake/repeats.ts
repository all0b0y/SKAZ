import type { RepeatsClient } from '../repeats';
import { contractFixtures as f } from './fixtures';

export function createFakeRepeatsClient(): RepeatsClient {
  return {
    material: async () => structuredClone(f.KbMaterialRepeats),
    start: async () => structuredClone(f.KbRepeatCheck),
    check: async () => structuredClone(f.KbRepeatCheck),
    pause: async () => structuredClone(f.KbRepeatCheck),
    resume: async () => structuredClone(f.KbRepeatCheck),
  };
}
