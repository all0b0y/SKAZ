import { useEffect, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import type { KbNotification } from '../../api/kb/types.gen';
import { Banner, Button, EmptyState, Icon, Segmented, Spinner } from '../ui';
import { EXIT, SPRING_SMALL } from '../ui/motion';
import { dayLabel, groupBy, shortTime } from '../ui/time';
import { useLibrary, useNotifications, useServices } from '../state/context';
import { subjectRef } from '../state/document';
import { pendingDecisions } from '../state/notifications';
import { kindOf, quickAction } from './kinds';

type Filter = 'all' | 'decide';

/** Open what a notification is about: its decision window, or the subject on the right. */
export function useOpenNotification() {
  const { ui, chats } = useServices();
  return (n: KbNotification) => {
    if (n.requires_action && !n.resolved_at) { ui.getState().openDecision(n.id); return; }
    if (!n.subject) return;
    if (n.subject.type === 'chat') {
      chats.getState().open(n.subject.id);
      ui.getState().showCenter('chat');
      return;
    }
    const ref = subjectRef(n.subject);
    if (ref) ui.getState().openDocument(ref);
  };
}

/**
 * Notifications feed in the left panel (decision 17, variant "Feed"): by day, "Needs a decision"
 * first in the "Decide" filter, a dismiss cross, actions in place. A decision window opens only on
 * a click (decision 18), never by itself.
 */
export function NotificationsFeed() {
  const { notifications, bridge } = useServices();
  const items = useNotifications((s) => s.items);
  const load = useNotifications((s) => s.load);
  const error = useNotifications((s) => s.error);
  const library = useLibrary((s) => s.library);
  const open = useOpenNotification();
  const [filter, setFilter] = useState<Filter>('all');
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Looking at the feed reads it: the bell counter goes to zero.
  useEffect(() => {
    const t = window.setTimeout(() => void notifications.getState().markRead(), 600);
    return () => window.clearTimeout(t);
  }, [notifications, items.length]);

  if (library?.state !== 'ready') {
    return <EmptyState icon="bell" title="No notifications" compact field>Connect the library first.</EmptyState>;
  }
  if (load === 'error' && items.length === 0) {
    return (
      <div className="kb-side__pad">
        <Banner tone="error" title="Notifications couldn’t be read."
          actions={<Button size="sm" icon="retry" onClick={() => void notifications.getState().refresh()}>Try again</Button>}>
          {error}
        </Banner>
      </div>
    );
  }
  if (load !== 'ready' && items.length === 0) return <div className="kb-side__wait"><Spinner label="Loading notifications" size="sm" /></div>;

  const pending = pendingDecisions(items);
  const shown = filter === 'decide' ? pending : items;
  const groups = groupBy(shown, (n) => dayLabel(n.created_at));

  const quick = async (n: KbNotification, action: string) => {
    setBusy(n.id);
    setRowError(null);
    const res = await notifications.getState().resolve(n.id, action);
    setBusy(null);
    if (!res.ok) setRowError({ id: n.id, text: res.error });
  };

  return (
    <div className="kb-side__scroll kb-feed">
      <div className="kb-feed__filter">
        <Segmented<Filter> label="Show" size="sm" value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All' },
          { value: 'decide', label: <>Decide{pending.length > 0 && <b className="kb-count">{pending.length}</b>}</>, name: `Decide, ${pending.length}` },
        ]} />
      </div>
      {shown.length === 0 && (
        <EmptyState icon="bell" title={filter === 'decide' ? 'Nothing waits for a decision' : 'Nothing needs your attention'} compact field />
      )}
      {groups.map((g) => (
        <section key={g.label} aria-label={g.label}>
          <h3 className="kb-subhead"><span className="kb-subhead__text">{g.label}</span></h3>
          <ul className="kb-feed__list">
            <AnimatePresence initial={false}>
              {g.items.map((n) => {
                const k = kindOf(n);
                const decide = n.requires_action && !n.resolved_at;
                const qa = decide ? quickAction(n) : null;
                const resolvedLabel = n.resolved_at ? n.actions.find((a) => a.id === n.resolution)?.label ?? 'Decided' : null;
                return (
                  <m.li key={n.id} layout="position" className={`kb-note${n.resolved_at ? ' is-done' : ''}`} data-kind={n.kind}
                    initial={{ opacity: 0 }} animate={{ opacity: 1, transition: SPRING_SMALL }} exit={{ opacity: 0, transition: EXIT }}>
                    <span className={`kb-note__icon kb-tone--${k.tone}`} aria-hidden="true"><Icon name={k.icon} size={13} /></span>
                    <div className="kb-note__body">
                      <button type="button" className="kb-note__main" onClick={() => open(n)}
                        aria-label={`${decide ? 'Needs a decision: ' : ''}${n.title}`} disabled={!decide && !n.subject}>
                        <span className="kb-note__top">
                          <span className="kb-note__title">{n.title}</span>
                          <span className="kb-note__time">{shortTime(n.created_at)}</span>
                        </span>
                        {n.body && <span className="kb-note__text">{n.body}</span>}
                      </button>
                      {resolvedLabel && <span className="kb-note__done"><Icon name="check" size={12} />{resolvedLabel}</span>}
                      {decide && (
                        <span className="kb-note__actions">
                          {qa && (
                            <button type="button" className="kb-note__act" disabled={busy === n.id} onClick={() => void quick(n, qa.id)}>{qa.label}</button>
                          )}
                          <button type="button" className="kb-note__act is-quiet" onClick={() => open(n)}>{k.open}</button>
                        </span>
                      )}
                      {/* B20: a finished export opens its folder (main checks it was chosen for an export). */}
                      {n.kind === 'export_done' && bridge.showInFinder && typeof n.payload.path === 'string' && (
                        <span className="kb-note__actions">
                          <button type="button" className="kb-note__act is-quiet" onClick={async () => {
                            const ok = await bridge.showInFinder!({ kind: 'export', path: String(n.payload.path) }).catch(() => false);
                            if (!ok) setRowError({ id: n.id, text: 'Finder couldn’t open that folder. It may have been moved or deleted.' });
                          }}>Show in Finder</button>
                        </span>
                      )}
                      {!decide && n.subject && !n.resolved_at && (
                        <span className="kb-note__actions"><button type="button" className="kb-note__act is-quiet" onClick={() => open(n)}>{k.open}</button></span>
                      )}
                      {rowError?.id === n.id && <span className="kb-inline-error kb-inline-error--flat" role="alert">{rowError.text}</span>}
                    </div>
                    <button type="button" className="kb-note__x" aria-label={`Dismiss “${n.title}”`}
                      onClick={async () => { const r = await notifications.getState().dismiss(n.id); if (!r.ok) setRowError({ id: n.id, text: r.error }); }}>
                      <Icon name="close" size={12} />
                    </button>
                  </m.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </section>
      ))}
    </div>
  );
}
