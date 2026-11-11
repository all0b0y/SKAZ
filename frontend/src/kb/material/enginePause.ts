import type { KbEnginePause } from '../../api/kb/types.gen';

const ENGINE_NAMES = { codex: 'Codex', claude_code: 'Claude Code', hermes: 'Hermes', opencode: 'OpenCode' };

/** Provider reset times are stored in UTC and displayed in the user's local timezone. */
export function enginePauseText(pause: KbEnginePause): string {
  const time = pause.retry_at && Number.isFinite(Date.parse(pause.retry_at))
    ? new Date(pause.retry_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
  return `${ENGINE_NAMES[pause.engine]}: usage limit reached — ${time ? `continues at ${time}` : 'continue manually'}`;
}
