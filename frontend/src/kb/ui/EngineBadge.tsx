import type { CSSProperties } from 'react';
import type { EngineId } from '../api/names';
import codexMark from '../../brand/agents/codex.svg';
import claudeMark from '../../brand/agents/claude-code.svg';
import hermesMark from '../../brand/agents/hermes.png';
import opencodeMark from '../../brand/agents/opencode.svg';

/** Colour brand marks (v42), bundled with the app (brand/agents/NOTICE.md): no external URL. */
const MARK: Record<EngineId, { src: string; cls: string; name: string }> = {
  codex: { src: codexMark, cls: 'codex', name: 'Codex' },
  claude_code: { src: claudeMark, cls: 'claude', name: 'Claude Code' },
  hermes: { src: hermesMark, cls: 'hermes', name: 'Hermes Agent' },
  opencode: { src: opencodeMark, cls: 'opencode', name: 'OpenCode' },
};

export type EngineBadgeSize = 16 | 20 | 32;

/**
 * The agent's colour mark on one rounded tile with a hairline ring (the same for all three, so
 * Hermes' and Codex' white plates read as icons, not holes, on dark). Decorative unless `label`.
 */
export function EngineBadge({ engine, label = false, size = 20 }: { engine: EngineId; label?: boolean; size?: EngineBadgeSize }) {
  const m = MARK[engine];
  const style = { '--kb-engine-size': `${size}px` } as CSSProperties;
  return (
    <span className={`kb-engine kb-engine--${m.cls}`} data-engine={engine} style={style}
      {...(label ? { role: 'img', 'aria-label': m.name } : { 'aria-hidden': true })}>
      <img src={m.src} alt="" width={size} height={size} draggable={false} />
    </span>
  );
}
