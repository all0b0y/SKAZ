import { SelectionHeader, SelectionHeaderProvider } from '../ui/listSelection';
import { LibraryPanel } from '../library/LibraryPanel';
import { ChatList } from '../chat/ChatList';
import { NotificationsFeed } from '../notifications/Feed';
import { GraphSide, WikiSide } from '../wiki/WikiSide';
import { useLayoutEffect, useRef } from 'react';
import { usePrefs } from '../state/context';
import { useMotionLevel } from '../ui/motionLevel';
import type { Section } from '../state/prefs';
import { GUTTER } from './layout';

/** A rail section switch crossfades the panel body (opacity only; nothing at calm or off). */
export const SECTION_FADE_MS = 140;

const TITLES: Record<Section, string> = {
  chats: 'Chats',
  materials: 'Materials',
  wiki: 'Wiki',
  graph: 'Graph',
  notifications: 'Notifications',
};

/**
 * Expandable left panel. Its header keeps one height for every section. `width` is the column; the
 * pane's box also takes the gutter to its right (FIX1 S1), where the side resizer sits and the open
 * chat's bridge runs to the centre sheet. The graph has no rail
 * item (v39): it opens from the Wiki section; `graph` stays a section only for a saved choice.
 */
export function SidePanel({ width }: { width: number }) {
  const section = usePrefs((s) => s.section);
  const level = useMotionLevel();
  const body = useRef<HTMLDivElement | null>(null);
  const shownSection = useRef(section);
  useLayoutEffect(() => {
    if (shownSection.current === section) return undefined;
    shownSection.current = section;
    const el = body.current;
    if (level !== 'full' || !el || typeof el.animate !== 'function') return undefined;
    const fade = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SECTION_FADE_MS, easing: 'ease-out' });
    return () => fade.cancel();
  }, [section, level]);
  return (
    <SelectionHeaderProvider>
    <section id="kb-side" className="kb-side" data-selection-surface="" data-pane="side" aria-label={TITLES[section]} style={{ width: width + GUTTER }}>
      <SelectionHeader className="kb-head kb-head--side">
        <h2 className="kb-side__title">{TITLES[section]}</h2>
        <span className="kb-head__spacer" />
      </SelectionHeader>
      <div className="kb-side__body" data-section={section} ref={body}>
        {section === 'chats' && <ChatList />}
        {section === 'materials' && <LibraryPanel />}
        {section === 'wiki' && <WikiSide />}
        {section === 'graph' && <GraphSide />}
        {section === 'notifications' && <NotificationsFeed />}
      </div>
    </section>
    </SelectionHeaderProvider>
  );
}
