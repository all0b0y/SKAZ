import { m } from 'motion/react';
import { Icon, type IconName } from '../ui';
import { Tooltip } from '../ui/Tooltip';
import { useLibrary, usePrefs, useServices, useUi } from '../state/context';
import type { Section } from '../state/prefs';
import { useProblems } from './problems';

const ITEMS: ReadonlyArray<{ id: Section; label: string; icon: IconName }> = [
  { id: 'chats', label: 'Chats', icon: 'chats' },
  { id: 'materials', label: 'Materials', icon: 'materials' },
  { id: 'wiki', label: 'Wiki', icon: 'wiki' },
  { id: 'graph', label: 'Graph', icon: 'graph' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
];

/**
 * Icon rail, 88px with labels (decision 13 + icons v37). Never moves: fixed width, fixed item
 * heights, no item appears or disappears when sections or panels change.
 */
export function Rail() {
  const { prefs } = useServices();
  const section = usePrefs((s) => s.section);
  const sideOpen = usePrefs((s) => s.sideOpen);
  const notifications = useLibrary((s) => s.notifications);
  const openSettings = useUi((s) => s.openSettings);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const problems = useProblems();
  const count = notifications?.length ?? 0;

  return (
    <nav className="kb-rail" data-pane="rail" aria-label="Sections">
      <ul className="kb-rail__list">
        {ITEMS.map((item) => {
          const active = sideOpen && section === item.id;
          const badge = item.id === 'notifications' && count > 0 ? count : 0;
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`kb-rail__item${active ? ' is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
                data-section={item.id}
                onClick={() => prefs.getState().set({ section: item.id, sideOpen: true })}
              >
                <span className="kb-rail__tile">
                  {active && <m.span layoutId="kb-rail-active" className="kb-rail__fill" aria-hidden="true" />}
                  <Icon name={item.icon} size={20} className="kb-rail__icon" />
                  {badge > 0 && (
                    <span className="kb-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span>
                  )}
                </span>
                <span className="kb-rail__label">{item.label}</span>
                {badge > 0 && <span className="kb-visually-hidden">, {badge} not dismissed</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="kb-rail__spacer" />
      <Tooltip text={problems.length ? `Settings — ${problems[0]!.short}` : 'Settings (⌘,)'} placement="right" describes>
        <button
          type="button"
          className={`kb-rail__item${settingsOpen ? ' is-open' : ''}`}
          aria-haspopup="dialog"
          data-section="settings"
          onClick={() => openSettings(problems[0]?.section)}
        >
          <span className="kb-rail__tile">
            <Icon name="settings" size={20} className="kb-rail__icon" />
            {problems.length > 0 && (
              <span className={`kb-dot kb-dot--${problems[0]!.tone}`} aria-hidden="true" data-testid="settings-dot" />
            )}
          </span>
          <span className="kb-rail__label">Settings</span>
          {problems.length > 0 && <span className="kb-visually-hidden">, needs attention</span>}
        </button>
      </Tooltip>
    </nav>
  );
}
