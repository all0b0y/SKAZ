import { IconButton } from '../ui';
import { LibraryPanel } from '../library/LibraryPanel';
import { ChatList } from '../chat/ChatList';
import { NotificationsFeed } from '../notifications/Feed';
import { GraphSide, WikiSide } from '../wiki/WikiSide';
import { usePrefs, useUi } from '../state/context';
import type { Section } from '../state/prefs';

const TITLES: Record<Section, string> = {
  chats: 'Chats',
  materials: 'Materials',
  wiki: 'Wiki',
  graph: 'Graph',
  notifications: 'Notifications',
};

/**
 * Expandable left panel. Its header keeps one height for every section. The graph has no rail
 * item (v39): it opens from the Wiki section; `graph` stays a section only for a saved choice.
 */
export function SidePanel({ width }: { width: number }) {
  const section = usePrefs((s) => s.section);
  const showCenter = useUi((s) => s.showCenter);
  return (
    <section id="kb-side" className="kb-side" data-pane="side" aria-label={TITLES[section]} style={{ width }}>
      <header className="kb-head kb-head--side">
        <h2 className="kb-side__title">{TITLES[section]}</h2>
        <span className="kb-head__spacer" />
        {section === 'chats' && <IconButton icon="search" label="Find in chats" size="sm" onClick={() => showCenter('allChats')} />}
      </header>
      <div className="kb-side__body" data-section={section}>
        {section === 'chats' && <ChatList />}
        {section === 'materials' && <LibraryPanel />}
        {section === 'wiki' && <WikiSide />}
        {section === 'graph' && <GraphSide />}
        {section === 'notifications' && <NotificationsFeed />}
      </div>
    </section>
  );
}
