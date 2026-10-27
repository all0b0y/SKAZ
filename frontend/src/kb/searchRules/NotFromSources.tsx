import type { KbMessage } from '../../api/kb/types.gen';
import { Icon } from '../ui';
import { useChatSearchRules } from './ChatSearchPanel';

/**
 * N7-4 citation check: with «Use only these sources», the answer's statements whose citation points
 * outside the chosen set (or to an excluded item) are counted under it. Checked against the chat's
 * sources as they are now. Uncited statements are the agent's own knowledge (P1 marks them).
 */
export function notFromSources(message: KbMessage, sources: readonly string[], excluded: readonly string[]): number {
  const allowed = new Set(sources);
  const out = new Set(excluded);
  return message.parts.filter((p) => {
    const id = p.type === 'cite' ? p.citation.material_id : p.type === 'page' ? p.page.id : null;
    return id !== null && (out.has(id) || !allowed.has(id));
  }).length;
}

export function NotFromSources({ chatId, message }: { chatId: string; message: KbMessage }) {
  const [rules] = useChatSearchRules(chatId);
  if (!rules?.sources_only || message.state === 'streaming') return null;
  const count = notFromSources(message, rules.sources.map((s) => s.id), rules.excluded.map((s) => s.id));
  if (!count) return null;
  return (
    <p className="kb-msg__note kb-notfrom" role="note">
      <Icon name="warning" size={13} />{count} {count === 1 ? 'statement' : 'statements'} not from your sources
    </p>
  );
}
