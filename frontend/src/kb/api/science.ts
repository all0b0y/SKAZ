// 0.4.0 science client. All wire shapes come from OpenAPI.
import type { KbClient } from './client';
import type { KbOpenAlexKeyUpdate, KbScienceJournal, KbScienceResults, KbScienceSearch, KbScienceSettings, KbScienceSettingsUpdate, KbScienceText, KbScienceWork } from '../../api/kb/types.gen';

export function scienceSettings(client: Pick<KbClient, "call">): Promise<KbScienceSettings> {
  return client.call('GET /kb/settings/science');
}

export function scienceUpdateSettings(client: Pick<KbClient, "call">, body: KbScienceSettingsUpdate): Promise<KbScienceSettings> {
  return client.call('PUT /kb/settings/science', { body });
}

export function scienceSetKey(client: Pick<KbClient, "call">, body: KbOpenAlexKeyUpdate): Promise<KbScienceSettings> {
  return client.call('PUT /kb/settings/science/openalex-key', { body });
}

export function scienceSearch(client: Pick<KbClient, "call">, body: KbScienceSearch): Promise<KbScienceResults> {
  return client.call('POST /kb/science/search', { body });
}

export function scienceWork(client: Pick<KbClient, "call">, work_id: string): Promise<KbScienceWork> {
  return client.call('GET /kb/science/works/{work_id}', { path: { work_id } });
}

export function scienceReadText(client: Pick<KbClient, "call">, work_id: string): Promise<KbScienceText> {
  return client.call('POST /kb/science/works/{work_id}/text', { path: { work_id } });
}

export function scienceJournal(client: Pick<KbClient, "call">, query: { cursor?: string; limit?: number } = {}): Promise<KbScienceJournal> {
  return client.call('GET /kb/science/journal', { query });
}

export function scienceDismissHint(client: Pick<KbClient, "call">): Promise<KbScienceSettings> {
  return client.call('POST /kb/settings/science/full-text-hint/dismiss');
}

export function createScienceClient(client: Pick<KbClient, "call">) {
  return {
    settings: () => scienceSettings(client),
    update_settings: (body: KbScienceSettingsUpdate) => scienceUpdateSettings(client, body),
    set_key: (body: KbOpenAlexKeyUpdate) => scienceSetKey(client, body),
    search: (body: KbScienceSearch) => scienceSearch(client, body),
    work: (work_id: string) => scienceWork(client, work_id),
    read_text: (work_id: string) => scienceReadText(client, work_id),
    journal: (query: { cursor?: string; limit?: number } = {}) => scienceJournal(client, query),
    dismiss_hint: () => scienceDismissHint(client),
  };
}
export type ScienceClient = ReturnType<typeof createScienceClient>;
