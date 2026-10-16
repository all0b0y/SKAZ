import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { m } from 'motion/react';
import { Icon, type IconName } from '../ui';
import { useChats, useNotifications, usePrefs, useServices, useUi } from '../state/context';
import { isWaitingForUser } from '../api/permissions';
import type { Section } from '../state/prefs';
import { useProblems } from './problems';

const ITEMS: ReadonlyArray<{ id: Section; label: string; icon: IconName }> = [
  { id: 'chats', label: 'Chats', icon: 'chats' },
  { id: 'materials', label: 'Materials', icon: 'materials' },
  { id: 'wiki', label: 'Wiki', icon: 'wiki' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
];

/** First name after this much hover; then at once while moving along the rail (v43 B). */
export const LABEL_DELAY_MS = 300;
/** How long after a name hides the next one still comes at once. */
export const LABEL_WARM_MS = 600;

/**
 * Which rail item shows its name (v43 variant B, "slide-out pill"): one at a time. Hover waits
 * {@link LABEL_DELAY_MS} the first time; keyboard focus shows it at once; moving along the rail
 * (within {@link LABEL_WARM_MS} of the last name) shows the next one at once. Escape hides it.
 */
function useRailLabels() {
  const [shown, setShown] = useState<string | null>(null);
  const shownRef = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const warmUntil = useRef(0);
  const lastPointer = useRef(0);

  const set = useCallback((id: string | null) => {
    if (shownRef.current !== null && id === null) warmUntil.current = Date.now() + LABEL_WARM_MS;
    shownRef.current = id;
    setShown(id);
  }, []);
  const show = useCallback((id: string, immediate: boolean) => {
    window.clearTimeout(timer.current);
    if (immediate || shownRef.current !== null || Date.now() < warmUntil.current) {
      set(id);
      return;
    }
    timer.current = window.setTimeout(() => set(id), LABEL_DELAY_MS);
  }, [set]);
  const hide = useCallback((id: string) => {
    window.clearTimeout(timer.current);
    if (shownRef.current === id) set(null);
  }, [set]);

  /** Focus that no pointer press just caused came from the keyboard (Tab, a dialog closing). */
  const fromKeyboard = useCallback(() => Date.now() - lastPointer.current > 500, []);

  useEffect(() => {
    const onPointer = () => { lastPointer.current = Date.now(); };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('mousedown', onPointer, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('mousedown', onPointer, true);
      window.clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    if (shown === null) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') set(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, set]);
  return { shown, show, hide, fromKeyboard };
}

type Labels = ReturnType<typeof useRailLabels>;

interface RailButtonProps {
  id: string;
  label: string;
  /** Muted after the name: a keyboard shortcut, or what needs attention. */
  hint?: string;
  icon: IconName;
  active?: boolean;
  open?: boolean;
  labels: Labels;
  ariaLabel: string;
  attrs?: Record<string, string | undefined>;
  onClick: () => void;
  children?: ReactNode;
}

/**
 * A rail button. Its name is its accessible name; on hover/focus its highlight slides out to the
 * right with the name beside the icon — one shape, decorative (aria-hidden: the button says it).
 */
function RailButton({ id, label, hint, icon, active = false, open = false, labels, ariaLabel, attrs, onClick, children }: RailButtonProps) {
  return (
    <button
      type="button"
      className={`kb-rail__item${active ? ' is-active' : ''}${open ? ' is-open' : ''}`}
      aria-label={ariaLabel}
      data-section={id}
      data-labelled={labels.shown === id ? '' : undefined}
      {...attrs}
      onClick={onClick}
      onMouseEnter={() => labels.show(id, false)}
      onMouseLeave={() => labels.hide(id)}
      onFocus={() => { if (labels.fromKeyboard()) labels.show(id, true); }}
      onBlur={() => labels.hide(id)}
    >
      {active && <m.span layoutId="kb-rail-active" className="kb-rail__fill" aria-hidden="true" />}
      <Icon name={icon} size={18} className="kb-rail__icon" />
      {labels.shown === id && (
        <span className="kb-rail__label" aria-hidden="true" data-testid="rail-label" data-overlay="">
          <Icon name={icon} size={18} />
          <span>{label}</span>
          {hint && <span className="kb-rail__hint">{hint}</span>}
        </span>
      )}
      {children}
    </button>
  );
}

/**
 * Icon rail (summary v39): narrow, icons only — names slide out on hover/focus (v43 B) and are the
 * accessible names; the SKAZ wordmark (v44 A) in the free space above search ⌘K and settings at the
 * bottom. Never moves: fixed width, fixed item
 * heights, nothing appears or disappears when sections or panels change. The graph lives in the
 * Wiki section (v39).
 */
export function Rail() {
  const { prefs } = useServices();
  const section = usePrefs((s) => s.section);
  const sideOpen = usePrefs((s) => s.sideOpen);
  const unread = useNotifications((s) => s.unread);
  const openSettings = useUi((s) => s.openSettings);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const searchOpen = useUi((s) => s.searchOpen);
  const center = useUi((s) => s.center);
  const setSearchOpen = useUi((s) => s.setSearchOpen);
  const problems = useProblems();
  const labels = useRailLabels();
  // 0.3.1 P4: a chat other than the one in front of you waits for an answer — a dot, nothing pops up.
  const waiting = useChats((s) => {
    const shown = center === 'chat' ? s.currentId : null;
    return s.list.some((c) => c.id !== shown && isWaitingForUser(c));
  });

  return (
    <nav className="kb-rail" data-pane="rail" aria-label="Sections">
      <ul className="kb-rail__list">
        {ITEMS.map((item) => {
          const active = sideOpen && (section === item.id || (item.id === 'wiki' && section === 'graph'));
          const badge = item.id === 'notifications' ? unread : 0;
          const waits = item.id === 'chats' && waiting;
          return (
            <li key={item.id}>
              <RailButton
                id={item.id} label={item.label} hint={badge > 0 ? `${badge} unread` : waits ? 'Waiting for you' : undefined} icon={item.icon} active={active} labels={labels}
                ariaLabel={badge > 0 ? `${item.label}, ${badge} unread` : waits ? `${item.label}, waiting for you` : item.label}
                attrs={{ 'aria-current': active ? 'page' : undefined }}
                onClick={() => prefs.getState().set({ section: item.id, sideOpen: true })}
              >
                {badge > 0 && <span className="kb-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span>}
                {waits && <span className="kb-dot kb-dot--waiting" aria-hidden="true" data-testid="chats-waiting-dot" />}
              </RailButton>
            </li>
          );
        })}
      </ul>
      <div className="kb-rail__spacer">
        {/* Wordmark (v44 A): decorative, reads bottom-to-top; hidden when the rail has no room for it. */}
        <span className="kb-rail__wordmark" aria-hidden="true">SKAZ</span>
      </div>
      <RailButton id="search" label="Search" hint="⌘K" icon="search" open={searchOpen} labels={labels} ariaLabel="Search"
        attrs={{ 'aria-keyshortcuts': 'Meta+K', 'aria-haspopup': 'dialog' }} onClick={() => setSearchOpen(true)} />
      <RailButton
        id="settings" label="Settings" hint={problems.length ? problems[0]!.short : '⌘,'} icon="settings" open={settingsOpen}
        labels={labels} ariaLabel={problems.length ? 'Settings, needs attention' : 'Settings'}
        attrs={{ 'aria-keyshortcuts': 'Meta+Comma', 'aria-haspopup': 'dialog' }}
        onClick={() => openSettings(problems[0]?.section)}
      >
        {problems.length > 0 && (
          <span className={`kb-dot kb-dot--${problems[0]!.tone}`} aria-hidden="true" data-testid="settings-dot" />
        )}
      </RailButton>
    </nav>
  );
}
