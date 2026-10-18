import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { Menu, type MenuItem } from '../Popover';

/** Right-click menu at the pointer: the ui Menu anchored to a 1px point (arrows, Enter, Esc as usual). */
export function ContextMenu({ at, onClose, label, items }: {
  at: { x: number; y: number } | null;
  onClose: () => void;
  label: string;
  items: ReadonlyArray<MenuItem>;
}) {
  const point = useRef<HTMLSpanElement | null>(null);
  return (
    <>
      {at && createPortal(
        <span ref={point} aria-hidden="true" className="kb-ctxpoint" style={{ position: 'fixed', left: at.x, top: at.y, width: 1, height: 1 }} />,
        document.body,
      )}
      <Menu open={at !== null} onClose={onClose} anchorRef={point} label={label} items={items} placement="bottom-start" />
    </>
  );
}
