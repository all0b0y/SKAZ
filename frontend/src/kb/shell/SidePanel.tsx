import { EmptyState, Icon, IconButton } from '../ui';
import { LibraryPanel } from '../library/LibraryPanel';
import { ChatList } from '../chat/ChatList';
import { NotificationsFeed } from '../notifications/Feed';
import { usePrefs, useServices, useUi } from '../state/context';
import type { Section } from '../state/prefs';

const TITLES: Record<Section, string> = {
  chats: 'Chats',
  materials: 'Materials',
  wiki: 'Wiki',
  graph: 'Graph',
  notifications: 'Notifications',
};

/** Expandable left panel. Its header keeps one height for every section. */
export function SidePanel({ width }: { width: number }) {
  const section = usePrefs((s) => s.section);
  const setCenterView = useUi((s) => s.setCenterView);
  return (
    <section id="kb-side" className="kb-side" data-pane="side" aria-label={TITLES[section]} style={{ width }}>
      <header className="kb-head kb-head--side">
        <h2 className="kb-side__title">{TITLES[section]}</h2>
        <span className="kb-head__spacer" />
        {section === 'chats' && <IconButton icon="search" label="Find in chats" size="sm" onClick={() => setCenterView('allChats')} />}
      </header>
      <div className="kb-side__body" data-section={section}>
        {section === 'chats' && <ChatList />}
        {section === 'materials' && <LibraryPanel />}
        {(section === 'wiki' || section === 'graph') && <WikiSection />}
        {section === 'notifications' && <NotificationsFeed />}
      </div>
    </section>
  );
}

/** Wiki list arrives with U3; the graph is reached from here (v39), not from the rail. */
function WikiSection() {
  const { prefs } = useServices();
  const section = usePrefs((s) => s.section);
  return (
    <div className="kb-side__scroll">
      <button type="button" className={`kb-row${section === 'graph' ? ' is-current' : ''}`}
        aria-current={section === 'graph' ? 'page' : undefined} onClick={() => prefs.getState().set({ section: 'graph' })}>
        <Icon name="graph" size={16} className="kb-row__icon" />
        <span className="kb-row__text">Graph of connections</span>
      </button>
      {section === 'graph' ? (
        <EmptyState icon="graph" title="Graph of connections" compact>How concepts connect across your folders will open from here.</EmptyState>
      ) : (
        <EmptyState icon="wiki" title="Wiki pages" compact>Concepts, notes and analyses built from your materials will be listed here.</EmptyState>
      )}
    </div>
  );
}
