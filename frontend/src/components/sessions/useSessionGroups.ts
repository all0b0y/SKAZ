import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClient, type StorageLayout } from '../../api/client';
import type { Session } from '../../api/types';
import { emptyGroups, importLegacyGroups, loadGroups, saveGroups, type SessionGroups } from '../../lib/sessionGroups';

export function useSessionGroups(sessions: Session[]) {
  const [initial] = useState(() => {
    try { return { data: importLegacyGroups(loadGroups(), sessions), error: '' }; }
    catch { return { data: emptyGroups(), error: 'Saved groups are unavailable. Reload to retry; existing preferences have not been overwritten.' }; }
  });
  const [data, setData] = useState(initial.data);
  const [error, setError] = useState(initial.error);
  const [remote, setRemote] = useState<StorageLayout | null>(null);
  const running = useRef(false);
  useEffect(() => {
    let alive = true;
    const read = () => {
      void new ApiClient(window.audiohelper).getStorageLayout().then((view) => {
        if (!alive) return;
        if (!view || typeof view.enabled !== 'boolean') throw new Error('Invalid storage state');
        setRemote(view);
        if (view.enabled) setData(view.data);
        setError(view.pending ? 'Storage recovery required. Open Settings → Files.' : view.enabled ? '' : initial.error);
      }).catch(() => { if (alive) { setRemote(null); setError('Could not read storage state. Reload to retry.'); } });
    };
    read();
    window.addEventListener('skaz-storage-root-changed', read);
    return () => { alive = false; window.removeEventListener('skaz-storage-root-changed', read); };
  }, [initial.error, sessions]);
  const commit = useCallback(async (next: SessionGroups) => {
    if (!remote || running.current || remote.pending) throw new Error('Storage is busy or needs recovery. Reload to retry.');
    if (remote.enabled) {
      running.current = true;
      try {
        const api = new ApiClient(window.audiohelper);
        await api.updateStorageGroups(next, remote.revision);
        const confirmed = await api.getStorageLayout();
        setRemote(confirmed); setData(confirmed.data); setError('');
      } catch {
        setRemote(null);
        setError('Save outcome unknown. Open Settings → Files and check storage before retrying.');
        throw new Error('Save outcome unknown. Check storage in Settings → Files.');
      } finally { running.current = false; }
      return;
    }
    if (initial.error) throw new Error(initial.error);
    try { saveGroups(next); }
    catch { throw new Error('Could not save groups on this device. Free some storage and try again.'); }
    setData(next);
    setError('');
  }, [initial.error, remote]);
  useEffect(() => {
    if (initial.error || !remote || remote.enabled) return;
    const next = importLegacyGroups(data, sessions);
    if (next !== data) void commit(next).catch((err: Error) => setError(err.message));
  }, [sessions, data, commit, initial.error, remote]);
  return { data, commit, error, setError };
}
