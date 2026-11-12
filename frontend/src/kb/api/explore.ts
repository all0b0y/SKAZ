// 0.4.0 explore client. All wire shapes come from OpenAPI.
import type { KbClient } from './client';
import type { KbAcknowledged, KbContinue, KbDiscussion, KbExploreStart, KbExploring, KbExploringList, KbFinding, KbFindingImport, KbFindingImported, KbFindings, KbFunnelRun, KbFunnelStart, KbJobs, KbSearch, KbSearches } from '../../api/kb/types.gen';

export function exploreStart(client: Pick<KbClient, "call">, body: KbFunnelStart): Promise<KbFunnelRun> {
  return client.call('POST /kb/explore/runs', { body });
}

export function exploreRun(client: Pick<KbClient, "call">, run_id: string): Promise<KbFunnelRun> {
  return client.call('GET /kb/explore/runs/{run_id}', { path: { run_id } });
}

export function explorePause(client: Pick<KbClient, "call">, run_id: string): Promise<KbFunnelRun> {
  return client.call('POST /kb/explore/runs/{run_id}/pause', { path: { run_id } });
}

export function exploreResume(client: Pick<KbClient, "call">, run_id: string, body: KbContinue): Promise<KbFunnelRun> {
  return client.call('POST /kb/explore/runs/{run_id}/continue', { path: { run_id }, body });
}

export function exploreCancel(client: Pick<KbClient, "call">, run_id: string): Promise<KbFunnelRun> {
  return client.call('POST /kb/explore/runs/{run_id}/cancel', { path: { run_id } });
}

export function exploreJobs(client: Pick<KbClient, "call">, query: { active?: boolean } = {}): Promise<KbJobs> {
  return client.call('GET /kb/explore/jobs', { query });
}

export function exploreFindings(client: Pick<KbClient, "call">, query: { area_id?: string; task_id?: string; include_covered?: boolean; cursor?: string; limit?: number } = {}): Promise<KbFindings> {
  return client.call('GET /kb/explore/findings', { query });
}

export function exploreFinding(client: Pick<KbClient, "call">, finding_id: string): Promise<KbFinding> {
  return client.call('GET /kb/explore/findings/{finding_id}', { path: { finding_id } });
}

export function exploreExplore(client: Pick<KbClient, "call">, finding_id: string, body: KbExploreStart): Promise<KbExploring> {
  return client.call('POST /kb/explore/findings/{finding_id}/explore', { path: { finding_id }, body });
}

export function exploreAddToWiki(client: Pick<KbClient, "call">, finding_id: string, body: KbFindingImport): Promise<KbFindingImported> {
  return client.call('POST /kb/explore/findings/{finding_id}/wiki', { path: { finding_id }, body });
}

export function exploreExploring(client: Pick<KbClient, "call">): Promise<KbExploringList> {
  return client.call('GET /kb/explore/exploring');
}

/** EX3: one search page — its findings filtered and sorted (Show, Free only, Year, Type; Sort). */
export interface SearchFindingsQuery {
  run_id: string;
  show?: 'active' | 'new' | 'seen' | 'dismissed';
  free_only?: boolean;
  year_from?: number;
  year_to?: number;
  types?: Array<'preprint' | 'peer_reviewed' | 'review' | 'other'>;
  sort?: 'for_you' | 'newest' | 'cited';
  cursor?: string;
  limit?: number;
}

export function exploreSearchFindings(client: Pick<KbClient, "call">, query: SearchFindingsQuery): Promise<KbFindings> {
  return client.call('GET /kb/explore/findings', { query });
}

export function exploreSearches(client: Pick<KbClient, "call">): Promise<KbSearches> {
  return client.call('GET /kb/explore/searches');
}

export function exploreRenameSearch(client: Pick<KbClient, "call">, run_id: string, name: string): Promise<KbSearch> {
  return client.call('PUT /kb/explore/searches/{run_id}/name', { path: { run_id }, body: { name } });
}

export function exploreDeleteSearch(client: Pick<KbClient, "call">, run_id: string): Promise<KbAcknowledged> {
  return client.call('DELETE /kb/explore/searches/{run_id}', { path: { run_id } });
}

export function exploreSeen(client: Pick<KbClient, "call">, finding_id: string): Promise<KbFinding> {
  return client.call('POST /kb/explore/findings/{finding_id}/seen', { path: { finding_id } });
}

export function exploreDismiss(client: Pick<KbClient, "call">, finding_id: string): Promise<KbFinding> {
  return client.call('POST /kb/explore/findings/{finding_id}/dismiss', { path: { finding_id } });
}

export function exploreRestore(client: Pick<KbClient, "call">, finding_id: string): Promise<KbFinding> {
  return client.call('POST /kb/explore/findings/{finding_id}/restore', { path: { finding_id } });
}

export function exploreAddToMaterials(client: Pick<KbClient, "call">, finding_id: string): Promise<KbFindingImported> {
  return client.call('POST /kb/explore/findings/{finding_id}/materials', { path: { finding_id } });
}

export function exploreDiscuss(client: Pick<KbClient, "call">, finding_id: string): Promise<KbDiscussion> {
  return client.call('POST /kb/explore/findings/{finding_id}/discuss', { path: { finding_id } });
}

export function createExploreClient(client: Pick<KbClient, "call">) {
  return {
    start: (body: KbFunnelStart) => exploreStart(client, body),
    run: (run_id: string) => exploreRun(client, run_id),
    pause: (run_id: string) => explorePause(client, run_id),
    resume: (run_id: string, body: KbContinue) => exploreResume(client, run_id, body),
    cancel: (run_id: string) => exploreCancel(client, run_id),
    jobs: (query: { active?: boolean } = {}) => exploreJobs(client, query),
    findings: (query: { area_id?: string; task_id?: string; include_covered?: boolean; cursor?: string; limit?: number } = {}) => exploreFindings(client, query),
    finding: (finding_id: string) => exploreFinding(client, finding_id),
    explore: (finding_id: string, body: KbExploreStart) => exploreExplore(client, finding_id, body),
    add_to_wiki: (finding_id: string, body: KbFindingImport) => exploreAddToWiki(client, finding_id, body),
    exploring: () => exploreExploring(client),
    searches: () => exploreSearches(client),
    search_findings: (query: SearchFindingsQuery) => exploreSearchFindings(client, query),
    rename_search: (run_id: string, name: string) => exploreRenameSearch(client, run_id, name),
    delete_search: (run_id: string) => exploreDeleteSearch(client, run_id),
    seen: (finding_id: string) => exploreSeen(client, finding_id),
    dismiss: (finding_id: string) => exploreDismiss(client, finding_id),
    restore: (finding_id: string) => exploreRestore(client, finding_id),
    add_to_materials: (finding_id: string) => exploreAddToMaterials(client, finding_id),
    discuss: (finding_id: string) => exploreDiscuss(client, finding_id),
  };
}
export type ExploreClient = ReturnType<typeof createExploreClient>;
