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
    searches: async () => structuredClone(f.KbSearches),
    search_findings: async () => structuredClone(f.KbFindings),
    rename_search: async () => structuredClone(f.KbSearch),
    delete_search: async () => structuredClone(f.KbAcknowledged),
    seen: async () => structuredClone(f.KbFinding),
    dismiss: async () => structuredClone(f.KbFinding),
    restore: async () => structuredClone(f.KbFinding),
    add_to_materials: async () => structuredClone(f.KbFindingImported),
    discuss: async () => structuredClone(f.KbDiscussion),
  };
}
