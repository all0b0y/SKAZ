import { useRef, useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import { useServices } from '../state/context';
import { IconButton } from './Button';
import { useIconPlay } from './Icon';
import { Menu } from './Popover';

export function ShareButton({ label, text, target, size = 'md' }: {
  label: string; text: () => string | Promise<string>;
  target?: { kind: 'material' | 'page'; id: string }; size?: 'sm' | 'md';
}) {
  const { bridge } = useServices();
  const anchor = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [fallback, setFallback] = useState(false);
  const [error, setError] = useState('');
  const [play, replay] = useIconPlay();
  const share = async () => {
    if (busy.current) return;
    if (fallback) { setFallback(false); return; }
    busy.current = true;
    setError('');
    replay();
    try {
      const result = bridge.share ? await bridge.share(target ?? { kind: 'text', text: await text() }) : 'unavailable';
      if (result === 'unavailable') setFallback(true);
      if (result === 'failed') setError('Couldn’t open sharing for this item.');
    } catch { setError('Couldn’t prepare this item for sharing.'); }
    finally { busy.current = false; }
  };
  return <>
    <IconButton ref={anchor} icon="share" iconPlay={play} label={label} size={size}
      aria-haspopup="menu" aria-expanded={fallback} onClick={() => void share()} />
    <Menu open={fallback} label={label} anchorRef={anchor} onClose={() => setFallback(false)} items={[
      { id: 'copy', label: 'Copy text', icon: 'copy', onSelect: () => {
        void Promise.resolve().then(text).then(copyToClipboard).then((ok) => {
          if (!ok) setError('Couldn’t copy the text.');
        }).catch(() => setError('Couldn’t prepare the text.'));
      } },
    ]} />
    {error && <span role="alert" className="kb-inline-error">{error}</span>}
  </>;
}
