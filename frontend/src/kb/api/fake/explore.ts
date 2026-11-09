import type { ExploreClient } from '../explore';
import { contractFixtures as f } from './fixtures';

export function createFakeExploreClient(): ExploreClient {
  return {
    start: async () => structuredClone(f.KbFunnelRun),
    run: async () => structuredClone(f.KbFunnelRun),
    pause: async () => structuredClone(f.KbFunnelRun),
    resume: async () => structuredClone(f.KbFunnelRun),
    cancel: async () => structuredClone(f.KbFunnelRun),
    jobs: async () => structuredClone(f.KbJobs),
    findings: async () => structuredClone(f.KbFindings),
    finding: async () => structuredClone(f.KbFinding),
    explore: async () => structuredClone(f.KbExploring),
    add_to_wiki: async () => structuredClone(f.KbFindingImported),
    exploring: async () => structuredClone(f.KbExploringList),
  };
}
