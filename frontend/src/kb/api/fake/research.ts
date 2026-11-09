import type { ResearchClient } from '../research';
import { contractFixtures as f } from './fixtures';

export function createFakeResearchClient(): ResearchClient {
  return {
    create: async () => structuredClone(f.KbResearchTask),
    tasks: async () => structuredClone(f.KbResearchTasks),
    task: async () => structuredClone(f.KbResearchTask),
    pause: async () => structuredClone(f.KbResearchTask),
    resume: async () => structuredClone(f.KbResearchTask),
    cancel: async () => structuredClone(f.KbResearchTask),
    decide: async () => structuredClone(f.KbResearchPermission),
    grant: async () => structuredClone(f.KbResearchGrant),
    revoke_grant: async () => structuredClone(f.KbResearchGrant),
    read: async () => structuredClone(f.KbExploreSnapshot),
  };
}
