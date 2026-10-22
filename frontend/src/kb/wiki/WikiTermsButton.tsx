import { useRef, useState } from 'react';
import { Button, IconButton } from '../ui';
import type { Placement } from '../ui/geometry';
import { WikiLegend } from './WikiLegend';

/** “?” on a wiki page and on the Wiki panel: opens the wiki legend beside it. */
export function WikiTermsButton({ size, placement = 'bottom-end' }: { size?: 'sm'; placement?: Placement }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton ref={ref} icon="help" size={size} label="What these labels mean" aria-haspopup="dialog"
        aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      <WikiLegend open={open} onClose={() => setOpen(false)} anchorRef={ref} placement={placement} />
    </>
  );
}

/** Settings → Wiki → Help → Wiki terms: “Show…” opens the same legend, anchored to the button. */
export function WikiTermsShowButton() {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button ref={ref} size="sm" icon="help" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>Show…</Button>
      <WikiLegend open={open} onClose={() => setOpen(false)} anchorRef={ref} />
    </>
  );
}
