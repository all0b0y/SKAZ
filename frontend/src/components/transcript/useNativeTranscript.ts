import { useEffect, useRef, useState } from 'react';
import { ApiClient, ApiError } from '../../api/client';
import type { NativeEventPageQuery } from '../../api/nativeEventPages';
import type { NativeSnapshot } from '../../api/nativeLive';
import type { Segment } from '../../api/types';
import type { NativePart } from './nativeParts';
import { forgetTranscript, openTranscript, peekTranscript, type TranscriptEntry } from './transcriptCache';

interface NativeRead {
  sessionId: string | null;
  snapshot: NativeSnapshot | null;
  segments: Segment[] | null;
  part: NativePart | null;
  error: string | null;
  hasOlder: boolean;
  hasNewer: boolean;
  busy: boolean;
}
const noSegments: Segment[] = [];
const empty = (sessionId: string | null): NativeRead => ({ sessionId, snapshot: null, segments: null,
  part: null, error: null, hasOlder: false, hasNewer: false, busy: false });
type Action = 'older' | 'newer' | 'latest' | 'focus' | 'translation' | 'init' | 'poll';

const partRead = (sessionId: string, parts: NativePart[], selected: number): NativeRead => {
  const part = parts[selected] ?? null;
  return { sessionId, snapshot: part?.snapshot ?? null, part, segments: noSegments, error: null,
    hasOlder: selected > 0, hasNewer: selected < parts.length - 1, busy: false };
};
const selectedIndex = (entry: TranscriptEntry): number =>
  Math.max(0, entry.parts.findIndex(part => part.id === entry.selectedPartId));
/** A fully loaded cached transcript is shown on the very first render, without a loader. */
const cachedRead = (sessionId: string | null): NativeRead | null => {
  const entry = peekTranscript(sessionId);
  return sessionId && entry?.ready ? partRead(sessionId, entry.parts, selectedIndex(entry)) : null;
};

/** Cache transport history, consume deltas, mount one whole reading part.
 * This bounds DOM duration, NOT total renderer RAM: the history of the current
 * and the previous session is retained (transcriptCache) so a return is instant.
 *
 * There is exactly one read path. A 404 before any page means the recording is
 * not created yet — a capture that just started, or a session that never
 * recorded. It is "nothing yet": polled while capturing, never another screen.
 */
export function useNativeTranscript(sessionId: string | null, polling: boolean, follow = true, focusId: string | null = null) {
  const [version, setVersion] = useState(0);
  const [read, setRead] = useState<NativeRead>(() => cachedRead(sessionId) ?? empty(sessionId));
  const followRef = useRef(follow);
  const pollingRef = useRef(polling);
  followRef.current = follow; pollingRef.current = polling;
  const actions = useRef<(action: Action, source?: string) => void>(() => {});

  useEffect(() => {
    if (!sessionId) { setRead(empty(null)); return; }
    const api = new ApiClient(window.skaz);
    const entry = openTranscript(sessionId);
    const cache = entry.history;
    let parts = entry.parts;
    let selected = selectedIndex(entry);
    let cancelled = false;
    let busy = false;
    let needsPoll = true;
    let pending: { action: Action; source?: string } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setRead(cachedRead(sessionId) ?? empty(sessionId));
    const publish = () => {
      entry.selectedPartId = parts[selected]?.id ?? null;
      setRead(partRead(sessionId, parts, selected));
    };
    const request = async (query: NativeEventPageQuery, direction: 'older' | 'newer') => {
      const page = await api.getNativeEventPage(sessionId, { ...query, limit: 128, project: true });
      if (cancelled) return;
      if (page.session_id !== sessionId || page.protocol !== 1 || !(page.sample_rate > 0)) {
        throw new Error('Invalid native transcript page.');
      }
      cache.merge(page, direction);
    };
    const drain = async (direction: 'older' | 'newer') => {
      while (!cancelled && (direction === 'older' || cache.hasNewer)) {
        const query = cache.query(direction);
        if (!query) break;
        await request(query, direction);
        if (cancelled) return;
        if ((direction === 'older' || cache.hasNewer) && JSON.stringify(cache.query(direction)) === JSON.stringify(query)) {
          throw new Error('Native transcript cursor did not advance.');
        }
      }
    };
    const load = async (action: Action, source?: string) => {
      if (cancelled) return;
      if (busy) { pending = { action, source }; return; }
      if (['older', 'newer', 'focus', 'translation'].includes(action)) {
        if (action === 'focus') {
          const found = parts.findIndex(part => part.snapshot.final_tokens?.some(token => token.segment_id === source));
          if (found < 0) {
            setRead(previous => ({ ...previous, error: 'Could not find the citation source.' })); return;
          }
          selected = found;
        } else if (action === 'translation') selected = parts[selected]?.translationStartPart ?? selected;
        else selected = Math.max(0, Math.min(parts.length - 1, selected + (action === 'older' ? -1 : 1)));
        publish(); return;
      }
      busy = true;
      clearTimeout(timer);
      if (action !== 'poll') setRead(previous => ({ ...previous, busy: true }));
      // A cached history resumes like a poll: old events are append-only, so only
      // the delta after the last known event is read.
      const resuming = action === 'init' && entry.ready;
      // Nothing merged yet (first open, or the recording did not exist a moment
      // ago): the next read is the first page again, whatever the action.
      // `transcription` is null only before any page — O(1), unlike snapshot().
      const first = cache.transcription === null;
      try {
        if (first) {
          await request({}, 'newer');
          await drain('older');
        } else await request(cache.query('newer') ?? {}, 'newer');
        await drain('newer');
        if (cancelled) return;
        entry.ready = true;
        if (!first && (action === 'poll' || resuming) && cache.revision === entry.publishedRevision) {
          const transcription = parts.at(-1)?.snapshot.transcription;
          needsPoll = transcription !== 'inactive' && transcription !== 'disabled';
          return;
        }
        const transcription = cache.transcription;
        needsPoll = transcription !== 'inactive' && transcription !== 'disabled';
        if (action !== 'poll' || followRef.current || first) {
          const oldId = parts[selected]?.id;
          parts = cache.parts();
          selected = action === 'latest' || followRef.current || !oldId ? Math.max(0, parts.length - 1)
            : Math.max(0, parts.findIndex(part => part.id === oldId));
          entry.parts = parts;
          entry.publishedRevision = cache.revision;
          publish();
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404 && cache.transcription === null) {
          // Not created yet. Keep polling only while capturing (pollingRef);
          // a session that never recorded simply has no transcript.
          forgetTranscript(sessionId);
          needsPoll = false;
          setRead({ ...empty(sessionId), busy: false });
        } else setRead(previous => ({ ...previous, busy: false,
          error: 'Could not refresh the transcript. The text shown is kept; try again.' }));
      } finally {
        busy = false;
        if (!cancelled && pending) {
          const next = pending; pending = null; void load(next.action, next.source);
          if (busy) return;
        }
        if (!cancelled) {
          const tick = () => {
            if (followRef.current && (pollingRef.current || needsPoll)) void load('poll');
            else timer = setTimeout(tick, 1000);
          };
          timer = setTimeout(tick, 1000);
        }
      }
    };
    actions.current = (action, source) => { void load(action, source); };
    void load('init');
    return () => { cancelled = true; clearTimeout(timer); actions.current = () => {}; };
  }, [sessionId, version]);

  useEffect(() => { if (focusId) actions.current('focus', focusId); }, [focusId, sessionId, version]);
  const current = read.sessionId === sessionId ? read : empty(sessionId);
  // The first answer for this session has not arrived yet: nothing to show, but
  // not "no transcript" either. A page, a 404 or an error ends this state.
  const initializing = sessionId !== null && current.snapshot === null && current.error === null
    && (current.busy || read.sessionId !== sessionId);
  return { ...current, initializing,
    windowed: current.snapshot !== null,
    retry: () => { if (sessionId) forgetTranscript(sessionId); setVersion(v => v + 1); },
    older: () => actions.current('older'), newer: () => actions.current('newer'),
    startOfTranslation: () => actions.current('translation'), latest: () => actions.current('latest') };
}
