import { useEffect, useRef, useState } from 'react';
import type { PaperReaderState } from '../../api/bridge';
import { Icon } from '../ui';

function reader() {
  return typeof window === 'undefined' ? undefined : window.skaz?.paperReader;
}

/**
 * EX3 (UX-1a): the paper's own page, shown in place. In the app it is a sandboxed view of its own laid over
 * this slot (electron/paperViewRuntime.ts) — publishers that refuse to be framed open there too, site
 * logins are kept, and nothing is downloaded. Outside the app (a browser preview, tests) the slot offers
 * the link instead. `covered` hides the view while a menu or dialog of the page is open over the slot:
 * a native view would otherwise sit on top of it.
 */
export function PaperReader({ url, covered }: { url: string | null; covered: boolean }) {
  const slot = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<PaperReaderState | null>(null);
  const api = reader();

  useEffect(() => api?.onState(setState), [api]);

  useEffect(() => {
    const el = slot.current;
    if (!api || !el || !url || covered) { void api?.hide(); return undefined; }
    const rect = () => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    void api.show(url, rect());
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => void api.bounds(rect()));
    observer?.observe(el);
    const onResize = () => void api.bounds(rect());
    window.addEventListener('resize', onResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      void api.hide();
    };
  }, [api, url, covered]);

  if (!url) {
    return <div className="kb-ex-reader__none">This paper has no page to open.</div>;
  }
  const shown = state?.url ?? url;
  return (
    <div className="kb-ex-reader__frame">
      <div className="kb-ex-reader__bar">
        {api && <>
          <button type="button" className="kb-ex-reader__nav" aria-label="Back" disabled={!state?.canGoBack} onClick={() => void api.navigate('back')}>
            <Icon name="chevronLeft" size={14} />
          </button>
          <button type="button" className="kb-ex-reader__nav" aria-label="Forward" disabled={!state?.canGoForward} onClick={() => void api.navigate('forward')}>
            <Icon name="chevronRight" size={14} />
          </button>
          <button type="button" className="kb-ex-reader__nav" aria-label="Reload" onClick={() => void api.navigate('reload')}>
            <Icon name="retry" size={14} className={state?.loading ? 'kb-explore-spin' : undefined} />
          </button>
        </>}
        <Icon name="shield" size={12} />
        <span className="kb-ex-reader__url" title={shown}>{shown}</span>
        {state?.error
          ? <span className="kb-ex-reader__error" role="alert">Didn&apos;t open: {state.error}</span>
          : <span className="kb-ex-reader__note">sandboxed · nothing saved</span>}
      </div>
      {api ? (
        // The page itself is drawn over this box by the app; the box only holds its place.
        <div ref={slot} className="kb-ex-reader__slot" data-testid="paper-slot" />
      ) : (
        <div className="kb-ex-reader__outside">
          <p>The page opens here in the SKAZ app.</p>
          <a href={url} target="_blank" rel="noreferrer noopener">Open in browser</a>
        </div>
      )}
    </div>
  );
}
