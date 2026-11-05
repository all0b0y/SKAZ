import type { KbMessage } from '../../api/kb/types.gen';
import { Icon } from '../ui';
import { useChatSearchRules } from './ChatSearchPanel';

/**
 * N7-4 citation check: with «Use only these sources», the answer's statements whose citation points
 * outside the chosen set (or to an excluded item) are counted under it. A statement is the text before a
 * run of citation chips (two cites of one statement count once); an answer block counts once per item
 * source. Only answers written since the sources were set are checked (`sources_since`, Q1 n78 M-7) —
 * an older answer was written under other sources. Uncited statements are the agent's own knowledge
 * (P1 marks them); web citations are not library sources and are not counted here.
 */
export function notFromSources(message: KbMessage, sources: readonly string[], excluded: readonly string[]): number {
  const allowed = new Set(sources);
  const out = new Set(excluded);
  const outside = (id: string) => out.has(id) || !allowed.has(id);
  let count = 0;
  let run: string[] = [];
  const close = () => { if (run.some(outside)) count += 1; run = []; };
  for (const part of message.parts) {
    if (part.type === 'cite') run.push(part.citation.material_id);
    else if (part.type === 'page') run.push(part.page.id);
    else if (part.type === 'connection') { close(); run = part.folders.map((f) => f.citation.material_id); close(); }
    else if (part.type === 'answer_block') {
      close();
      count += part.sources.filter((src) => src.type === 'cite' && outside(src.citation.material_id)).length;
    } else close();
  }
  close();
  return count;
}

/** The answer was written under the chat's current sources (unknown since: checked, as before). */
function writtenSince(message: KbMessage, since: string | null | undefined): boolean {
  if (!since) return true;
  const at = Date.parse(message.created_at);
  const from = Date.parse(since);
  return Number.isNaN(at) || Number.isNaN(from) || at >= from;
}

export function NotFromSources({ chatId, message }: { chatId: string; message: KbMessage }) {
  const [rules] = useChatSearchRules(chatId);
  if (!rules?.sources_only || message.state === 'streaming' || !writtenSince(message, rules.sources_since)) return null;
  const count = notFromSources(message, rules.sources.map((s) => s.id), rules.excluded.map((s) => s.id));
  if (!count) return null;
  return (
    <p className="kb-msg__note kb-notfrom" role="note">
      <Icon name="warning" size={13} />{count} {count === 1 ? 'statement' : 'statements'} not from your sources
    </p>
  );
}
