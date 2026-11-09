// 0.4.0 explore client. All wire shapes come from OpenAPI.
import type { KbClient } from './client';
import type { KbContinue, KbExploreStart, KbExploring, KbExploringList, KbFinding, KbFindingImport, KbFindingImported, KbFindings, KbFunnelRun, KbFunnelStart, KbJobs } from '../../api/kb/types.gen';

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
  };
}
export type ExploreClient = ReturnType<typeof createExploreClient>;
