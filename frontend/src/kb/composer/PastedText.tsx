import { useRef, useState } from 'react';
import { Button, IconButton } from '../ui';
import { Popover } from '../ui/Popover';
import type { Attachment } from './Attach';

/**
 * A paste longer than this does not go into the message field: it becomes a "Pasted text" card in
 * the attachments row (the same item as "+" → Paste text), saved to Materials when the message is
 * sent. One constant; tune it here.
 */
export const LONG_PASTE = { chars: 2000, lines: 40 } as const;

export function isLongPaste(text: string): boolean {
  if (text.length > LONG_PASTE.chars) return true;
  return text.replace(/(\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/).length > LONG_PASTE.lines;
}

const count = (text: string) => text.length.toLocaleString('en-US');

export function pastedName(text: string): string {
  return `Pasted text · ${count(text)} characters`;
}

/** The name of a pasted-text card: opens a read-only preview with "Paste as text"; plus the same action on the card. */
export function PastedCard({ attachment, text, onPasteAsText }: {
  attachment: Attachment;
  text: string;
  onPasteAsText: () => void;
}) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const back = () => { setOpen(false); onPasteAsText(); };
  return (
    <>
      <button ref={anchor} type="button" className="kb-attachment__name kb-attachment__open" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Show the pasted text (${count(text)} characters)`} onClick={() => setOpen((v) => !v)}>
        {attachment.name}
      </button>
      {attachment.state !== 'adding' && (
        <IconButton icon="enter" size="sm" label="Paste as text" className="kb-attachment__act" onClick={back} tooltipPlacement="top" />
      )}
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="top-start" width={460} label="Pasted text" className="kb-pastepop">
        <div className="kb-pastepop__head">{attachment.name}</div>
        <div className="kb-pastepop__body" role="region" aria-label="Pasted text content" tabIndex={0}>{text}</div>
        <div className="kb-attachform__foot">
          {attachment.state !== 'adding' && <Button size="sm" variant="outline" icon="enter" onClick={back}>Paste as text</Button>}
        </div>
      </Popover>
    </>
  );
}
