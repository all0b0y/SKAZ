import { Icon } from '../ui';

/**
 * PDF text SKAZ couldn't read (a font without a usable character map, user bug 1016-4): it is
 * left out of the material — never sent to agents, never quoted — and named here by page, next
 * to the excluded fragments.
 */
export function UnreadableText({ pages }: { pages: readonly number[] }) {
  if (pages.length === 0) return null;
  const where = `${pages.length === 1 ? 'page' : 'pages'} ${pages.join(', ')}`;
  return (
    <div className="kb-excl kb-excl--unreadable" role="note" aria-label="Unreadable text in the PDF">
      <p className="kb-excl__toggle">
        <Icon name="warning" size={14} />
        <span>Unreadable text in the PDF ({where})</span>
      </p>
      <p className="kb-muted">
        Its font has no usable character map, so that text is left out of the material: agents don’t see it and it is never quoted.
        Open the original PDF to read it.
      </p>
    </div>
  );
}
