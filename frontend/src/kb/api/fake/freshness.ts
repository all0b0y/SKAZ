import type { FreshnessClient } from '../freshness';
import { contractFixtures as f } from './fixtures';

export function createFakeFreshnessClient(): FreshnessClient {
  return {
    publication: async () => structuredClone(f.KbMaterialPublication),
    filter_dates: async () => structuredClone(f.KbDatedMaterials),
    check_links: async () => structuredClone(f.KbLinkCheck),
    link_check: async () => structuredClone(f.KbLinkCheck),
    pause: async () => structuredClone(f.KbLinkCheck),
    resume: async () => structuredClone(f.KbLinkCheck),
  };
}
