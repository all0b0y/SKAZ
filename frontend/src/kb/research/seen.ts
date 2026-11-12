import { useEffect, useRef, useState } from 'react';
import type { KbResearchTask } from '../../api/kb/types.gen';
import { useChats, useNotifications, useServices } from '../state/context';

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

export function finishedTask(task: KbResearchTask | null | undefined): boolean {
  return Boolean(task && (['done', 'cancelled', 'error'].includes(task.run.state) || task.run.stop_reason === 'budget'));
}

/** This hook runs in the visible task, never in a sidebar/poller or an unseen mounted chat. */
export function useFinishedTaskRead(task: KbResearchTask | null | undefined, shown = true): void {
  const { client, chats, notifications } = useServices();
  const visible = usePageVisible();
  const items = useNotifications((s) => s.items);
  const unreadChat = useChats((s) => Boolean(task && s.list.find((chat) => chat.id === task.chat_id)?.unread));
  const read = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    if (!shown || !visible || !task || !finishedTask(task)) return;
    if (unreadChat) void chats.getState().markRead(task.chat_id);
    for (const notification of items) {
      if (notification.kind !== 'research_finished' || notification.payload.task_id !== task.id || notification.dismissed_at
        || read.current.has(notification.id) || inFlight.current.has(notification.id)) continue;
      const id = notification.id;
      inFlight.current.add(id);
      void client.call('POST /kb/notifications/{notification_id}/read', { path: { notification_id: id } }).then(() => {
        read.current.add(id);
        void notifications.getState().refresh();
      }, () => { /* A later feed or visibility change retries an unrecorded read. */ }).finally(() => inFlight.current.delete(id));
    }
  }, [shown, visible, task, unreadChat, items, client, chats, notifications]);
}
