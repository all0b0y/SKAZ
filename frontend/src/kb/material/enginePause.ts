import type { KbEnginePause } from '../../api/kb/types.gen';

const ENGINE_NAMES = { codex: 'Codex', claude_code: 'Claude Code', hermes: 'Hermes', opencode: 'OpenCode' };

/** Provider reset times are stored in UTC and displayed in the user's local timezone. */
export function enginePauseText(pause: KbEnginePause): string {
  let when: string | null = null;
  if (pause.retry_at && Number.isFinite(Date.parse(pause.retry_at))) {
    const reset = new Date(pause.retry_at);
    const now = new Date();
    const time = reset.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const date = reset.toDateString() === now.toDateString() ? null
      : reset.toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short',
        ...(reset.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
      });
    when = date ? `${date}, ${time}` : time;
  }
  return `${ENGINE_NAMES[pause.engine]}: usage limit reached — ${when ? `continues at ${when}` : 'continue manually'}`;
}
