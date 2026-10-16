import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders a column's popup at <body> while leaving a hidden marker in the
 * column, so the popup can still be bounded by that column
 * (`usePanePlacement(..., { boundsFrom: markerRef })`).
 *
 * The popup leaves the column's DOM for one reason: anything inside a column
 * that scrolls, clips, animates a transform or declares a size container would
 * capture a `position: fixed` child and cut it away or offset it. At <body> the
 * popup is positioned against the window and only the placement code decides
 * where it may go.
 */
export function PanePortal({ markerRef, children }: {
  markerRef: RefObject<HTMLSpanElement>;
  children: ReactNode;
}) {
  return (
    <>
      <span ref={markerRef} hidden data-pane-marker="" />
      {createPortal(children, document.body)}
    </>
  );
}
