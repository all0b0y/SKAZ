import type { ReactNode } from 'react';
import type { KbTimelineBlock } from '../../../api/kb/types.gen';
import { citationRef, useOpenDocument } from '../../state/document';
import { clock } from '../../ui/time';
import { BlockItem, useBlockScope } from './hover';
import { timecode, type BlockItemData } from './sources';

/** timeline: events in order — a date, or a moment of a recording (its time opens the recording there). */
export function TimelineBlock({ block }: { block: KbTimelineBlock }) {
  const { sources } = useBlockScope();
  const open = useOpenDocument();
  return (
    <ol className="kb-blk-tl">
      {block.events.map((event) => {
        let when: ReactNode;
        const at = event.when === null ? timecode(event, sources) : null;
        if (event.when !== null) when = <span className="kb-blk-tl__when">{event.when}</span>;
        else if (at && at.citation.available) {
          when = (
            <button type="button" className="kb-blk-tl__when kb-blk-tl__when--tc"
              aria-label={`Open the recording at ${clock(at.ms)}`} onClick={() => open(citationRef(at.citation))}>
              {clock(at.ms)}
            </button>
          );
        } else when = <span className="kb-blk-tl__when">{at ? clock(at.ms) : '—'}</span>;
        return (
          <BlockItem key={event.id} item={event} as="li">
            {when}
            <span className="kb-blk-tl__dot" aria-hidden="true" />
            <div className="kb-blk-tl__main">
              <div className="kb-blk-tl__title">{event.title}</div>
              {event.text && <div className="kb-blk-tl__text">{event.text}</div>}
            </div>
          </BlockItem>
        );
      })}
    </ol>
  );
}

export const timelineItems = (block: KbTimelineBlock): BlockItemData[] => block.events;
