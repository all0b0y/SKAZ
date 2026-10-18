import { errorText, type KbClient } from '../api/client';

/**
 * Several materials at once (FEAT-2: "6 selected · Move to… · Add to wiki · Ask · Delete", and
 * dragging rows onto a folder). One request per material, in order: the backend has no batch
 * routes, and one failure never stops the rest — each one says what happened to it.
 */
export interface BulkOutcome {
  done: string[];
  failed: Array<{ id: string; error: string }>;
}

/** The drag payload of material rows: JSON array of material ids. */
export const MATERIALS_MIME = 'application/x-skaz-materials';

export function readDraggedMaterials(data: DataTransfer): string[] {
  try {
    const value: unknown = JSON.parse(data.getData(MATERIALS_MIME) || '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function dragsMaterials(data: DataTransfer): boolean {
  return Array.from(data.types).includes(MATERIALS_MIME);
}

async function each(ids: readonly string[], run: (id: string) => Promise<unknown>): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { done: [], failed: [] };
  for (const id of ids) {
    try {
      await run(id);
      outcome.done.push(id);
    } catch (error) {
      outcome.failed.push({ id, error: errorText(error) });
    }
  }
  return outcome;
}

export function moveMaterials(client: KbClient, ids: readonly string[], folderId: string): Promise<BulkOutcome> {
  return each(ids, (id) => client.call('PATCH /kb/materials/{material_id}', { path: { material_id: id }, body: { folder_id: folderId } }));
}

export function deleteMaterials(client: KbClient, ids: readonly string[]): Promise<BulkOutcome> {
  return each(ids, (id) => client.call('DELETE /kb/materials/{material_id}', { path: { material_id: id } }));
}

/** The wiki queue (H2) takes them all and runs them a few at a time. */
export function addMaterialsToWiki(client: KbClient, ids: readonly string[]): Promise<BulkOutcome> {
  return each(ids, (id) => client.call('POST /kb/materials/{material_id}/ingest', { path: { material_id: id } }));
}

/** "3 moved." / "2 deleted, 1 couldn’t be: <reason>" — what a bulk action did, in one line. */
export function outcomeText(outcome: BulkOutcome, verb: string): string {
  const done = outcome.done.length ? `${outcome.done.length} ${verb}.` : '';
  if (!outcome.failed.length) return done;
  const first = outcome.failed[0]!.error;
  return `${done}${done ? ' ' : ''}${outcome.failed.length} couldn’t be: ${first}`;
}
