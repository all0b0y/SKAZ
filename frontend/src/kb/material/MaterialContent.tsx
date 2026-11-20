import { useEffect, useState } from 'react';
import type { KbMaterialDisplay } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { useServices } from '../state/context';
import { Button } from '../ui';

/** Render only the elements in SKAZ's own card format. Source markup never enters the app DOM. */
function DocumentContent({ content }: { content: string }) {
  const doc = new DOMParser().parseFromString(content, 'text/html');
  function textOf(element: Element) { return element.textContent ?? ''; }
  return <div className="kb-document-content">{Array.from(doc.querySelectorAll('section[data-page]'), (page) =>
    <section key={page.getAttribute('data-page')} aria-label={`Page ${page.getAttribute('data-page')}`}>
      {Array.from(page.children, (block, i) => {
        if (block.tagName === 'FIGURE') {
          const asset = doc.getElementById(`asset-${block.getAttribute('data-asset')}`)?.getAttribute('href');
          return asset?.startsWith('data:image/webp;base64,')
            ? <figure key={i}><img src={asset} loading="lazy" alt={`Illustration on page ${page.getAttribute('data-page')}`} /></figure> : null;
        }
        if (block.tagName === 'DETAILS') return <details key={i}><summary>Recognized text</summary>
          {Array.from(block.querySelectorAll('p'), (p, j) => <p key={j}>{textOf(p)}</p>)}</details>;
        if (block.tagName === 'H2') return <h3 key={i}>{textOf(block)}</h3>;
        if (block.tagName === 'H3') return <h4 key={i}>{textOf(block)}</h4>;
        return block.tagName === 'P' ? <p key={i}>{textOf(block)}</p> : null;
      })}
    </section>)}</div>;
}

export function MaterialContent({ id, title }: { id: string; title: string }) {
  const { client } = useServices();
  const [data, setData] = useState<KbMaterialDisplay | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    void client.call('GET /kb/materials/{material_id}/display', { path: { material_id: id } }).then(
      (value) => { if (alive) setData(value); }, (e: unknown) => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [client, id, retry]);
  if (error) return <p role="alert">{error} <Button size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button></p>;
  if (!data) return <p role="status" className="kb-muted">Opening material…</p>;
  if (data.format === 'document') return <DocumentContent content={data.content} />;
  if (data.format !== 'image') return null;
  return <div className="kb-material-photo"><button type="button" aria-label={zoom ? 'Fit image to card' : 'Show image at full size'}
    aria-pressed={zoom} onClick={() => setZoom((v) => !v)}><img src={`data:image/webp;base64,${data.content}`}
      className={zoom ? 'is-full-size' : undefined} alt={title} /></button></div>;
}
