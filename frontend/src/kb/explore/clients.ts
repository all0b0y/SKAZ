import type { KbClient } from '../api/client';
import type { KbFunnelCandidate, KbSearchPlanRequest } from '../../api/kb/types.gen';

// EX2 adapters stay in X4's directory; wire shapes and route names come from step 0b.
export function createTopicActions(client: Pick<KbClient, 'call'>) {
  return {
    sort: () => client.call('POST /kb/explore/topics/sort'),
    merge: (area_id: string, into_id: string) => client.call('POST /kb/explore/areas/{area_id}/merge', { path: { area_id }, body: { into_id } }),
    move: (material_id: string, area_id: string) => client.call('PUT /kb/materials/{material_id}/topic', { path: { material_id }, body: { area_id } }),
  };
}
export type TopicActions = ReturnType<typeof createTopicActions>;
export type CandidateQuery = { outcome?: KbFunnelCandidate['outcome']; cursor?: string };

export function createDiscoveryClient(client: Pick<KbClient, 'call'>) {
  return {
    plan: (body: KbSearchPlanRequest) => client.call('POST /kb/explore/plan', { body }),
    candidates: (run_id: string, query: CandidateQuery = {}) => client.call('GET /kb/explore/runs/{run_id}/candidates', { path: { run_id }, query }),
    fits: (run_id: string, candidate_id: string) => client.call('POST /kb/explore/runs/{run_id}/candidates/{candidate_id}/fits', { path: { run_id, candidate_id } }),
    concepts: async (q: string) => (await client.call('GET /kb/search', { query: { q, limit: 30 } })).pages.filter((page) => page.kind === 'concept'),
  };
}
export type DiscoveryClient = ReturnType<typeof createDiscoveryClient>;
