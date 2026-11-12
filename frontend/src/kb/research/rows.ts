import type { KbChatSummary, KbResearchTask } from '../../api/kb/types.gen';

/** Chat identity and actions are real; research work also drives the existing chat status mark. */
export function researchChat(task: KbResearchTask, chat?: KbChatSummary): KbChatSummary {
  return {
    id: task.chat_id, title: chat?.title ?? task.title, pinned: chat?.pinned ?? false,
    engine: chat?.engine ?? 'codex', model: chat?.model ?? null, effort: chat?.effort ?? null,
    created_at: chat?.created_at ?? task.created_at, updated_at: chat?.updated_at ?? task.updated_at,
    last_preview: chat?.last_preview ?? '', recording_material_id: chat?.recording_material_id ?? null,
    folder_ids: chat?.folder_ids ?? [], research_task_id: task.id,
    waiting_for_user: chat?.waiting_for_user ?? false,
    state: task.run.state === 'running' || task.run.state === 'queued' ? 'answering' : chat?.state ?? 'idle',
    unread: chat?.unread ?? false,
  };
}
