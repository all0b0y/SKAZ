import type { EngineId } from '../api/names';

const MARK: Record<EngineId, { text: string; cls: string; name: string }> = {
  codex: { text: 'Cx', cls: 'codex', name: 'Codex' },
  claude_code: { text: 'CC', cls: 'claude', name: 'Claude Code' },
  hermes: { text: 'H', cls: 'hermes', name: 'Hermes Agent' },
};

/** Two-letter agent mark (v21): not a brand logo; decorative unless `label` is asked for. */
export function EngineBadge({ engine, label = false }: { engine: EngineId; label?: boolean }) {
  const m = MARK[engine];
  return (
    <span className={`kb-engine kb-engine--${m.cls}`} {...(label ? { role: 'img', 'aria-label': m.name } : { 'aria-hidden': true })}>
      {m.text}
    </span>
  );
}
