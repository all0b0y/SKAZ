// 0.4.0 research client. All wire shapes come from OpenAPI.
import type { KbClient } from './client';
import type { KbContinue, KbExploreRead, KbExploreSnapshot, KbResearchCreate, KbResearchDecide, KbResearchGrant, KbResearchPermission, KbResearchTask, KbResearchTasks } from '../../api/kb/types.gen';

export function researchCreate(client: Pick<KbClient, "call">, body: KbResearchCreate): Promise<KbResearchTask> {
  return client.call('POST /kb/research/tasks', { body });
}

export function researchTasks(client: Pick<KbClient, "call">, query: { cursor?: string; limit?: number } = {}): Promise<KbResearchTasks> {
  return client.call('GET /kb/research/tasks', { query });
}

export function researchTask(client: Pick<KbClient, "call">, task_id: string): Promise<KbResearchTask> {
  return client.call('GET /kb/research/tasks/{task_id}', { path: { task_id } });
}

export function researchPause(client: Pick<KbClient, "call">, task_id: string): Promise<KbResearchTask> {
  return client.call('POST /kb/research/tasks/{task_id}/pause', { path: { task_id } });
}

export function researchResume(client: Pick<KbClient, "call">, task_id: string, body: KbContinue): Promise<KbResearchTask> {
  return client.call('POST /kb/research/tasks/{task_id}/continue', { path: { task_id }, body });
}

export function researchCancel(client: Pick<KbClient, "call">, task_id: string): Promise<KbResearchTask> {
  return client.call('POST /kb/research/tasks/{task_id}/cancel', { path: { task_id } });
}

export function researchDecide(client: Pick<KbClient, "call">, request_id: string, body: KbResearchDecide): Promise<KbResearchPermission> {
  return client.call('POST /kb/research/permissions/{request_id}/decide', { path: { request_id }, body });
}

export function researchGrant(client: Pick<KbClient, "call">, chat_id: string): Promise<KbResearchGrant> {
  return client.call('GET /kb/chats/{chat_id}/research-grant', { path: { chat_id } });
}

export function researchRevokeGrant(client: Pick<KbClient, "call">, chat_id: string): Promise<KbResearchGrant> {
  return client.call('DELETE /kb/chats/{chat_id}/research-grant', { path: { chat_id } });
}

export function researchRead(client: Pick<KbClient, "call">, body: KbExploreRead): Promise<KbExploreSnapshot> {
  return client.call('POST /kb/explore/read', { body });
}

export function createResearchClient(client: Pick<KbClient, "call">) {
  return {
    create: (body: KbResearchCreate) => researchCreate(client, body),
    tasks: (query: { cursor?: string; limit?: number } = {}) => researchTasks(client, query),
    task: (task_id: string) => researchTask(client, task_id),
    pause: (task_id: string) => researchPause(client, task_id),
    resume: (task_id: string, body: KbContinue) => researchResume(client, task_id, body),
    cancel: (task_id: string) => researchCancel(client, task_id),
    decide: (request_id: string, body: KbResearchDecide) => researchDecide(client, request_id, body),
    grant: (chat_id: string) => researchGrant(client, chat_id),
    revoke_grant: (chat_id: string) => researchRevokeGrant(client, chat_id),
    read: (body: KbExploreRead) => researchRead(client, body),
  };
}
export type ResearchClient = ReturnType<typeof createResearchClient>;
