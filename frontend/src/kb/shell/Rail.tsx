import { m } from 'motion/react';
import { Icon, type IconName } from '../ui';
import { Tooltip } from '../ui/Tooltip';
import { useNotifications, usePrefs, useServices, useUi } from '../state/context';
import type { Section } from '../state/prefs';
import { useProblems } from './problems';

const ITEMS: ReadonlyArray<{ id: Section; label: string; icon: IconName }> = [
  { id: 'chats', label: 'Chats', icon: 'chats' },
  { id: 'materials', label: 'Materials', icon: 'materials' },
  { id: 'wiki', label: 'Wiki', icon: 'wiki' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
];

/**
 * Icon rail (summary v39): narrow, icons only — names in tooltips and accessible names; search ⌘K
 * and settings at the bottom. Never moves: fixed width, fixed item heights, nothing appears or
 * disappears when sections or panels change. The graph lives in the Wiki section (v39).
 */
export function Rail() {
  const { prefs } = useServices();
  const section = usePrefs((s) => s.section);
  const sideOpen = usePrefs((s) => s.sideOpen);
  const unread = useNotifications((s) => s.unread);
  const openSettings = useUi((s) => s.openSettings);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const searchOpen = useUi((s) => s.searchOpen);
  const setSearchOpen = useUi((s) => s.setSearchOpen);
  const problems = useProblems();

  return (
    <nav className="kb-rail" data-pane="rail" aria-label="Sections">
      <ul className="kb-rail__list">
        {ITEMS.map((item) => {
          const active = sideOpen && (section === item.id || (item.id === 'wiki' && section === 'graph'));
          const badge = item.id === 'notifications' ? unread : 0;
          return (
            <li key={item.id}>
              <Tooltip text={item.label} placement="right">
                <button
                  type="button"
                  className={`kb-rail__item${active ? ' is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  aria-label={badge > 0 ? `${item.label}, ${badge} unread` : item.label}
                  data-section={item.id}
                  onClick={() => prefs.getState().set({ section: item.id, sideOpen: true })}
                >
                  {active && <m.span layoutId="kb-rail-active" className="kb-rail__fill" aria-hidden="true" />}
                  <Icon name={item.icon} size={18} className="kb-rail__icon" />
                  {badge > 0 && <span className="kb-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span>}
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ul>
      <div className="kb-rail__spacer" />
      <Tooltip text="Search (⌘K)" placement="right">
        <button type="button" className={`kb-rail__item${searchOpen ? ' is-open' : ''}`} aria-label="Search" aria-keyshortcuts="Meta+K"
          aria-haspopup="dialog" data-section="search" onClick={() => setSearchOpen(true)}>
          <Icon name="search" size={18} className="kb-rail__icon" />
        </button>
      </Tooltip>
      <Tooltip text={problems.length ? `Settings — ${problems[0]!.short}` : 'Settings (⌘,)'} placement="right">
        <button
          type="button"
          className={`kb-rail__item${settingsOpen ? ' is-open' : ''}`}
          aria-haspopup="dialog"
          aria-label={problems.length ? 'Settings, needs attention' : 'Settings'}
          aria-keyshortcuts="Meta+Comma"
          data-section="settings"
          onClick={() => openSettings(problems[0]?.section)}
        >
          <Icon name="settings" size={18} className="kb-rail__icon" />
          {problems.length > 0 && (
            <span className={`kb-dot kb-dot--${problems[0]!.tone}`} aria-hidden="true" data-testid="settings-dot" />
          )}
        </button>
      </Tooltip>
    </nav>
  );
}
