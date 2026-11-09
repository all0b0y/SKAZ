// 0.4.0 maintenance client. All wire shapes come from OpenAPI.
import type { KbClient } from './client';
import type { KbContinue, KbFreshnessAction, KbFreshnessActionResult, KbFreshnessMarks, KbWeeklyCheck, KbWeeklySettings, KbWeeklySettingsUpdate } from '../../api/kb/types.gen';

export function maintenanceSettings(client: Pick<KbClient, "call">): Promise<KbWeeklySettings> {
  return client.call('GET /kb/settings/weekly-check');
}

export function maintenanceUpdateSettings(client: Pick<KbClient, "call">, body: KbWeeklySettingsUpdate): Promise<KbWeeklySettings> {
  return client.call('PUT /kb/settings/weekly-check', { body });
}

export function maintenanceStart(client: Pick<KbClient, "call">): Promise<KbWeeklyCheck> {
  return client.call('POST /kb/freshness/weekly-checks');
}

export function maintenanceCheck(client: Pick<KbClient, "call">, check_id: string): Promise<KbWeeklyCheck> {
  return client.call('GET /kb/freshness/weekly-checks/{check_id}', { path: { check_id } });
}

export function maintenancePause(client: Pick<KbClient, "call">, check_id: string): Promise<KbWeeklyCheck> {
  return client.call('POST /kb/freshness/weekly-checks/{check_id}/pause', { path: { check_id } });
}

export function maintenanceResume(client: Pick<KbClient, "call">, check_id: string, body: KbContinue): Promise<KbWeeklyCheck> {
  return client.call('POST /kb/freshness/weekly-checks/{check_id}/continue', { path: { check_id }, body });
}

export function maintenanceMarks(client: Pick<KbClient, "call">, material_id: string): Promise<KbFreshnessMarks> {
  return client.call('GET /kb/materials/{material_id}/freshness', { path: { material_id } });
}

export function maintenanceAct(client: Pick<KbClient, "call">, mark_id: string, body: KbFreshnessAction): Promise<KbFreshnessActionResult> {
  return client.call('POST /kb/freshness/marks/{mark_id}/act', { path: { mark_id }, body });
}

export function maintenancePageMarks(client: Pick<KbClient, "call">, page_id: string): Promise<KbFreshnessMarks> {
  return client.call('GET /kb/wiki/pages/{page_id}/freshness', { path: { page_id } });
}

export function createMaintenanceClient(client: Pick<KbClient, "call">) {
  return {
    page_marks: (page_id: string) => maintenancePageMarks(client, page_id),
    settings: () => maintenanceSettings(client),
    update_settings: (body: KbWeeklySettingsUpdate) => maintenanceUpdateSettings(client, body),
    start: () => maintenanceStart(client),
    check: (check_id: string) => maintenanceCheck(client, check_id),
    pause: (check_id: string) => maintenancePause(client, check_id),
    resume: (check_id: string, body: KbContinue) => maintenanceResume(client, check_id, body),
    marks: (material_id: string) => maintenanceMarks(client, material_id),
    act: (mark_id: string, body: KbFreshnessAction) => maintenanceAct(client, mark_id, body),
  };
}
export type MaintenanceClient = ReturnType<typeof createMaintenanceClient>;
