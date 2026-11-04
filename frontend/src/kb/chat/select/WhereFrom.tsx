import { useEffect, useState } from 'react';
import type { KbMessage, KbMessagePart } from '../../../api/kb/types.gen';
import { Icon, IconButton, type IconName } from '../../ui';
import { safeUrl } from '../../ui/markdown/Markdown';
import { citationRef, pageRef, useOpenDocument } from '../../state/document';
import { useChats } from '../../state/context';
import { clock } from '../../ui/time';
import type { BlockSource } from '../blocks/sources';
import { diagramId, type Selection } from './model';
import { SelectionBar, type QuickAsk } from './SelectionBar';

/**
 * P2 decision 3: «Where is this from?» is answered by SKAZ itself, without the agent: the sources of
 * the picked items, read from the stored answer, each one opens. An answer block's item has its own
 * sources; a diagram's nodes have none — the sources cited right after the diagram are shown for the
 * whole diagram, and when there are none, it says so.
 */

export interface WhereRow {
  label: string;
  sources: BlockSource[];
  /** The agent's own knowledge, not from the user's materials. */
  agent: boolean;
}

type Node = Record<string, unknown>;

function findItem(node: unknown, id: string, top = true): Node | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findItem(child, id, false);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const n = node as Node;
  if (!top && n.id === id) return n;
  for (const value of Object.values(n)) {
    const found = findItem(value, id, false);
    if (found) return found;
  }
  return null;
}

/** Every `src` index under an item (a compare row's cells too), and whether any rests on the agent. */
function collect(node: unknown, src: Set<number>, agent: { on: boolean }): void {
  if (Array.isArray(node)) { node.forEach((child) => collect(child, src, agent)); return; }
  if (!node || typeof node !== 'object') return;
  const n = node as Node;
  if (Array.isArray(n.src)) (n.src as unknown[]).forEach((i) => { if (typeof i === 'number') src.add(i); });
  if (n.agent === true) agent.on = true;
  Object.entries(n).forEach(([key, value]) => { if (key !== 'src') collect(value, src, agent); });
}

/** A closed ```mermaid fence (as `chats/selection.py` reads it). */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid[ \t]*\n([\s\S]*?)\n {0,3}\1[ \t]*$/gim;

/** The cites standing right after a diagram's closing fence (the agent is told to put them there). */
function diagramCites(parts: readonly KbMessagePart[], blockId: string): BlockSource[] | null {
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part.type !== 'text') continue;
    const fence = [...part.text.matchAll(FENCE)].find((m) => diagramId(m[2] ?? '') === blockId);
    if (!fence) continue;
    // Only cites right after the fence (nothing but spaces between) belong to the diagram.
    if (part.text.slice(fence.index + fence[0].length).trim()) return [];
    const out: BlockSource[] = [];
    for (const next of parts.slice(i + 1)) {
      if (next.type === 'cite') out.push({ type: 'cite', citation: next.citation });
      else if (next.type === 'page') out.push({ type: 'page', page: next.page, block_id: next.block_id, available: next.available ?? true });
      else if (next.type === 'text' && !next.text.trim()) continue;
      else break;
    }
    return out;
  }
  return null;
}

export function whereRows(message: KbMessage | undefined, selection: Selection): WhereRow[] | null {
  if (!message) return null;
  if (selection.kind === 'diagram') {
    const cites = diagramCites(message.parts, selection.block_id);
    return cites === null ? null : [{ label: 'The whole diagram', sources: cites, agent: false }];
  }
  const part = message.parts.find((p) => p.type === 'answer_block' && p.id === selection.block_id);
  if (!part || part.type !== 'answer_block' || !part.block) return null;
  return selection.items.map((item) => {
    const node = findItem(part.block, item.id);
    const src = new Set<number>();
    const agent = { on: false };
    collect(node, src, agent);
    return { label: item.label, agent: agent.on, sources: [...src].map((i) => part.sources[i]).filter((s): s is BlockSource => !!s) };
  });
}

function describe(source: BlockSource): { label: string; meta: string | null; icon: IconName; available: boolean } {
  if (source.type === 'cite') {
    const c = source.citation;
    const meta = c.start_ms !== null ? clock(c.start_ms) : c.page !== null ? `p. ${c.page}` : null;
    return { label: c.material_title ?? 'Source', meta, icon: c.start_ms !== null ? 'play' : 'pdf', available: c.available };
  }
  if (source.type === 'page') return { label: source.page.title, meta: 'wiki', icon: 'concept', available: source.available };
  return { label: source.title || source.site || source.url, meta: source.site, icon: 'web', available: true };
}

function SourceLink({ source }: { source: BlockSource }) {
  const open = useOpenDocument();
  const d = describe(source);
  const text = <><Icon name={d.icon} size={12} /><span className="kb-where__label">{d.label}</span>{d.meta && <span className="kb-where__meta">{d.meta}</span>}</>;
  if (!d.available) return <span className="kb-where__src is-gone" aria-label={`${d.label}: no longer available`}>{text}</span>;
  const go = () => {
    if (source.type === 'cite') open(citationRef(source.citation));
    else if (source.type === 'page') open(pageRef(source.page, source.block_id));
    else {
      const url = safeUrl(source.url);
      if (url) window.open(url, '_blank', 'noopener');
    }
  };
  return (
    <button type="button" className="kb-where__src" aria-label={`Open source: ${d.label}${d.meta ? ` · ${d.meta}` : ''}`} onClick={go}>
      {text}
    </button>
  );
}

export function WhereFrom({ selection, onClose }: { selection: Selection; onClose: () => void }) {
  const message = useChats((s) => (s.currentId ? s.chats[s.currentId]?.chat?.messages.find((m) => m.id === selection.message_id) : undefined));
  const rows = whereRows(message, selection);
  return (
    <section className="kb-where" aria-label="Where this is from">
      <div className="kb-where__head">
        <span>Where this is from</span>
        <IconButton icon="close" size="sm" label="Close" tooltipPlacement="top" onClick={onClose} />
      </div>
      {rows === null && <p className="kb-where__none">This answer is no longer in the chat.</p>}
      {rows?.map((row, i) => (
        <div key={i} className="kb-where__row">
          <div className="kb-where__item">{row.label}</div>
          <div className="kb-where__srcs">
            {row.sources.map((source, j) => <SourceLink key={j} source={source} />)}
            {row.agent && (
              <span className="kb-where__src kb-where__src--agent"><Icon name="agent" size={12} />Agent’s knowledge — not from your materials</span>
            )}
            {!row.sources.length && !row.agent && (
              <span className="kb-where__none">{selection.kind === 'diagram' ? 'This diagram cites no sources.' : 'No sources.'}</span>
            )}
          </div>
        </div>
      ))}
      {selection.kind === 'diagram' && rows?.[0]?.sources.length ? (
        <p className="kb-where__note">A diagram’s nodes have no sources of their own: these are the ones cited for the diagram.</p>
      ) : null}
    </section>
  );
}

/** The bar with «Where is this from?» opening the sources under it (the composer shows this). */
export function SelectionPanel({ selection, onClear, onQuick, disabledReason }: {
  selection: Selection;
  onClear: () => void;
  onQuick: (ask: QuickAsk) => void;
  disabledReason: string | null;
}) {
  const [where, setWhere] = useState(false);
  const key = `${selection.message_id}/${selection.block_id}/${selection.items.map((i) => i.id).join(',')}`;
  useEffect(() => { setWhere(false); }, [selection.message_id, selection.block_id]);
  // P3-c: a test question asks in the field below; its own quick asks and sources are for answer items.
  if (selection.kind === 'study') return <SelectionBar selection={selection} onClear={onClear} />;
  return (
    <>
      <SelectionBar selection={selection} onClear={onClear} onQuick={onQuick} disabledReason={disabledReason}
        onWhere={() => setWhere((v) => !v)} whereOpen={where} />
      {where && <WhereFrom key={key} selection={selection} onClose={() => setWhere(false)} />}
    </>
  );
}
