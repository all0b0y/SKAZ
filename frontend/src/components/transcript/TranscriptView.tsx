import { useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import { EmptyState } from '../ui/EmptyState';
import { formatTimecode } from '../../lib/time';

interface TranscriptViewProps {
  focusSegmentId: string | null;
}

export function TranscriptView({ focusSegmentId }: TranscriptViewProps) {
  const detail = useStore((s) => s.detail);
  const loading = useStore((s) => s.detailLoading);
  const error = useStore((s) => s.detailError);
  const recorderState = useStore((s) => s.recorderState);
  const queue = useStore((s) => s.queue);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  const segments = detail?.segments ?? [];
  const live = recorderState === 'recording';

  // Auto-scroll to the newest segment while live.
  useEffect(() => {
    if (live && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [segments.length, live]);

  // Scroll a cited segment into view and flash it.
  useEffect(() => {
    if (!focusSegmentId) return;
    const row = rowRefs.current.get(focusSegmentId);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('segment--flash');
      const timer = setTimeout(() => row.classList.remove('segment--flash'), 1600);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [focusSegmentId]);

  if (loading) {
    return <div className="panel__center"><p className="loading">Loading transcript…</p></div>;
  }
  if (error) {
    return (
      <div className="panel__center">
        <EmptyState icon="warning" title="Couldn’t load the transcript" hint={error} />
      </div>
    );
  }
  if (segments.length === 0) {
    return (
      <div className="panel__center">
        <EmptyState
          icon="transcript"
          title={live ? 'Listening…' : 'No transcript yet'}
          hint={
            live
              ? 'Words appear here moments after they are spoken.'
              : 'Press Record to start capturing and transcribing.'
          }
        />
      </div>
    );
  }

  return (
    <div className="transcript" ref={scrollRef}>
      <ol className="transcript__list" role="list">
        {segments.map((seg) => (
          <li
            key={seg.id}
            className={clsx('segment', focusSegmentId === seg.id && 'segment--focused')}
            ref={(el) => {
              if (el) rowRefs.current.set(seg.id, el);
              else rowRefs.current.delete(seg.id);
            }}
          >
            <span className="segment__time tabular">{formatTimecode(seg.start_ms)}</span>
            <p className="segment__text">
              {seg.text}
              {seg.language && <span className="segment__lang">{seg.language}</span>}
            </p>
          </li>
        ))}
      </ol>
      {live && (
        <p className="transcript__live" aria-live="polite">
          <span className="transcript__pulse" aria-hidden />
          {queue.pending > 0 ? `Transcribing ${queue.pending} chunk${queue.pending > 1 ? 's' : ''}…` : 'Listening…'}
        </p>
      )}
    </div>
  );
}
