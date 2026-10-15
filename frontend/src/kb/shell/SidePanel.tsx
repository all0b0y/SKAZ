import type { ReactNode } from 'react';
import { EmptyState, Icon } from '../ui';
import { Tooltip } from '../ui/Tooltip';
import { LibraryPanel } from '../library/LibraryPanel';
import { GraphSide, WikiSide } from '../wiki/WikiSide';
import { useLibrary, usePrefs } from '../state/context';
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
  return (
    <section id="kb-side" className="kb-side" data-pane="side" aria-label={TITLES[section]} style={{ width }}>
      <header className="kb-head kb-head--side">
        <h2 className="kb-side__title">{TITLES[section]}</h2>
      </header>
      <div className="kb-side__body" data-section={section}>
        {section === 'chats' && <ChatsSection />}
        {section === 'materials' && <LibraryPanel />}
        {section === 'wiki' && <WikiSide />}
        {section === 'graph' && <GraphSide />}
        {section === 'notifications' && <NotificationsSection />}
      </div>
    </section>
  );
}

function DisabledRow({ icon, children, reason }: { icon: 'newChat'; children: ReactNode; reason: string }) {
  return (
    <Tooltip text={reason} describes>
      <button type="button" className="kb-row kb-row--action" aria-disabled="true" onClick={(e) => e.preventDefault()}>
        <Icon name={icon} size={16} className="kb-row__icon" />
        <span className="kb-row__text">{children}</span>
      </button>
    </Tooltip>
  );
}

function ChatsSection() {
  return (
    <div className="kb-side__scroll">
      <DisabledRow icon="newChat" reason="Chat isn’t connected yet">New chat</DisabledRow>
      <EmptyState icon="chats" title="No chats yet" compact>
        Pinned chats and chats by date will be listed here.
      </EmptyState>
    </div>
  );
}

function NotificationsSection() {
  const list = useLibrary((s) => s.notifications);
  const library = useLibrary((s) => s.library);
  if (library?.state !== 'ready') {
    return <EmptyState icon="bell" title="No notifications" compact>Connect the library first.</EmptyState>;
  }
  if (list === null) {
    return <EmptyState icon="bell" title="Notifications couldn’t be read" compact />;
  }
  if (list.length === 0) {
    return <EmptyState icon="bell" title="Nothing needs your attention" compact />;
  }
  return (
    <div className="kb-side__scroll">
      <ul className="kb-list" aria-label="Notifications">
        {list.map((n) => (
          <li key={n.id} className="kb-row kb-row--static">
            <Icon name={n.requires_action ? 'warning' : 'bell'} size={16} className="kb-row__icon" />
            <span className="kb-row__text">{n.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
