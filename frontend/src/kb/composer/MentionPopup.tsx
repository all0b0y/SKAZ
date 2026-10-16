import { useEffect, useRef, useState } from 'react';
import type { KbMentions, KbRef } from '../../api/kb/types.gen';
import { Icon, type IconName } from '../ui';
import { useLibrary, useServices } from '../state/context';
import { KIND_ICON } from '../library/materialMeta';

export interface MentionOption {
  ref: KbRef;
  icon: IconName;
  meta: string;
  group: 'Wiki' | 'Materials' | 'Chats';
}

const PAGE_META: Record<string, { icon: IconName; meta: string }> = {
  concept: { icon: 'concept', meta: 'concept' },
  note: { icon: 'note', meta: 'notes' },
  analysis: { icon: 'analysis', meta: 'analysis' },
  folder: { icon: 'folder', meta: 'folder overview' },
};

/** Flatten `/kb/mentions` into one ordered list (Wiki · Materials · Chats), the keyboard order. */
export function mentionOptions(res: KbMentions | null,
  material: (id: string) => { icon: IconName; folder: string } | undefined = () => undefined): MentionOption[] {
  if (!res) return [];
  return [
    ...res.pages.map((p): MentionOption => ({
      ref: { type: 'page', id: p.id, title: p.title }, icon: PAGE_META[p.kind]?.icon ?? 'wiki', meta: PAGE_META[p.kind]?.meta ?? 'page', group: 'Wiki',
    })),
    ...res.materials.map((m): MentionOption => {
      const known = material(m.id);
      return { ref: m, icon: known?.icon ?? 'pdf', meta: known?.folder ?? 'material', group: 'Materials' };
    }),
    ...res.chats.map((c): MentionOption => ({ ref: c, icon: 'chats', meta: 'chat', group: 'Chats' })),
  ];
}

/** Suggestions for `@query`, debounced; stale answers are dropped. */
export function useMentions(query: string | null): { options: MentionOption[]; loading: boolean; error: string | null } {
  const { client } = useServices();
  const materials = useLibrary((s) => s.materials);
  const folders = useLibrary((s) => s.folders);
  const lookup = useRef<(id: string) => { icon: IconName; folder: string } | undefined>(() => undefined);
  lookup.current = (id) => {
    const m = materials.find((x) => x.id === id);
    if (!m) return undefined;
    return { icon: KIND_ICON[m.kind], folder: folders.find((f) => f.id === m.folder_id)?.name ?? 'material' };
  };
  const [state, setState] = useState<{ options: MentionOption[]; loading: boolean; error: string | null }>({ options: [], loading: false, error: null });
  useEffect(() => {
    if (query === null) { setState({ options: [], loading: false, error: null }); return undefined; }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const timer = window.setTimeout(() => {
      client.call('GET /kb/mentions', { query: { q: query, limit: 8 } }).then(
        (res) => { if (live) setState({ options: mentionOptions(res, lookup.current), loading: false, error: null }); },
        () => { if (live) setState({ options: [], loading: false, error: 'Suggestions couldn’t be loaded.' }); },
      );
    }, 120);
    return () => { live = false; window.clearTimeout(timer); };
  }, [client, query]);
  return state;
}

export function MentionPopup({ id, options, active, loading, error, onPick, onHover }: {
  id: string;
  options: MentionOption[];
  active: number;
  loading: boolean;
  error: string | null;
  onPick: (option: MentionOption) => void;
  onHover: (index: number) => void;
}) {
  let lastGroup = '';
  return (
    <div className="kb-mentions" data-testid="mention-popup">
      {error && <p className="kb-mentions__note" role="status">{error}</p>}
      {!error && options.length === 0 && (
        <p className="kb-mentions__note" role="status">{loading ? 'Looking…' : 'Nothing found. Keep typing or press Escape.'}</p>
      )}
      <ul id={id} role="listbox" aria-label="References" className="kb-mentions__list">
        {options.map((o, i) => {
          const head = o.group !== lastGroup ? o.group : null;
          lastGroup = o.group;
          return (
            <li key={`${o.ref.type}-${o.ref.id}`} role="presentation">
              {head && <div className="kb-mentions__group" role="presentation">{head}</div>}
              <div id={`${id}-${i}`} role="option" aria-selected={i === active} className={`kb-mentions__item${i === active ? ' is-active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); onPick(o); }} onMouseEnter={() => onHover(i)}>
                <Icon name={o.icon} size={14} />
                <span className="kb-mentions__title">{o.ref.title}</span>
                <span className="kb-mentions__meta">{o.meta}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
