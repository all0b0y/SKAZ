import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { LOCAL_VIDEO_AUDIO_ONLY_NOTICE } from '../../materials/addItems';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Modal } from '../../ui/Modal';
import { attachmentSendBlocker, canAddAttachmentToWiki, type DraftAttachment } from './draft';
import './attachmentDrafts.css';

export interface AttachmentDraftStripProps {
  items: readonly DraftAttachment[];
  onRemove: (key: string) => void;
  onToggleWiki: (key: string) => void;
  renderName?: (item: DraftAttachment) => ReactNode;
  focusEditor?: () => void;
  onReplace?: (key: string) => void;
  onResolveVideo?: (key: string, proceed: boolean) => void;
  readOnly?: boolean;
}

function AttachmentThumbnail({ item, large = false }: { item: DraftAttachment; large?: boolean }) {
  const blob = item.state === 'ready' && item.thumbnail?.type.startsWith('image/') ? item.thumbnail : undefined;
  const previewUnavailable = item.state === 'ready' && item.previewUnavailable;
  const [url, setUrl] = useState<{ blob: Blob; src: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== 'function') return;
    const src = URL.createObjectURL(blob);
    setUrl({ blob, src });
    return () => URL.revokeObjectURL(src);
  }, [blob]);

  const src = url && url.blob === blob && failed !== url.src ? url.src : null;
  if (src) return (
    <img className={large ? 'kb-attachment041-preview' : 'kb-attachment041-thumb'} src={src}
      alt={large ? `Preview of ${item.name}` : ''} onError={() => setFailed(src)} />
  );
  if (large) {
    if (!blob && !previewUnavailable) return null;
    const unavailable = previewUnavailable || failed === url?.src || typeof URL.createObjectURL !== 'function';
    return <p className="kb-attachment041-meta">{unavailable ? 'Preview unavailable.' : 'Loading preview…'}</p>;
  }
  return <Icon name={item.source === 'link' ? 'link' : item.source === 'text' ? 'text' : 'materials'} size={16} />;
}

function attachmentStatus(item: DraftAttachment): string | null {
  if (item.state === 'failed') return item.error || 'Attachment failed.';
  if (item.state === 'adding') return 'Preparing…';
  if (item.state === 'confirming') return 'Awaiting confirmation';
  return item.alreadyInLibrary ? 'Already in your library' : null;
}

/** Key the strip by the active draft ID so an open detail follows the originating chat only. */
export function AttachmentDraftStrip({ items, onRemove, onToggleWiki, renderName, focusEditor, onReplace, onResolveVideo, readOnly }: AttachmentDraftStripProps) {
  const [view, setView] = useState<{ key?: string } | null>(null);
  const [visible, setVisible] = useState(2);
  const rowRef = useRef<HTMLUListElement | null>(null);
  const detailsRef = useRef<HTMLUListElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const removedKey = useRef<string | null>(null);
  const noticeId = useId();
  const selected = items.find((item) => item.key === view?.key);
  const modalOpen = view !== null && items.length > 0;
  const video = items.find((item) => item.state === 'confirming');
  const videoReplacement = items.find((item) => item.state === 'confirming' && item.replaceKey)?.key;

  const hasItems = items.length > 0;
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width) setVisible(width < 360 ? 1 : width < 560 ? 2 : 3);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [hasItems]);

  useLayoutEffect(() => {
    if (removedKey.current === null || items.some((item) => item.key === removedKey.current)) return;
    removedKey.current = null;
    if (modalOpen) detailsRef.current?.focus({ preventScroll: true });
    else if (!opener.current) {
      const first = rowRef.current?.querySelector('button');
      if (first) first.focus({ preventScroll: true });
      else focusEditor?.();
    }
  }, [items, modalOpen, focusEditor]);

  useEffect(() => {
    if (modalOpen || !opener.current) return;
    const target = opener.current.isConnected ? opener.current : rowRef.current?.querySelector('button');
    opener.current = null;
    if (target) target.focus({ preventScroll: true });
    else focusEditor?.();
  }, [modalOpen, focusEditor]);

  useEffect(() => { if (!items.length) setView(null); }, [items.length]);
  // A video picked from the details dialog needs its next action in the composer.
  useEffect(() => { if (videoReplacement) setView(null); }, [videoReplacement]);
  if (!items.length) return null;

  const ordered = [...items.filter((item) => item.state === 'failed'), ...items.filter((item) => item.state !== 'failed')];
  const hiddenCount = Math.max(0, items.length - visible);
  const blocker = attachmentSendBlocker(items);
  const failed = items.some((item) => item.state === 'failed');
  const openView = (button: HTMLButtonElement, key?: string) => {
    opener.current = button;
    setView({ key });
  };
  const removeButton = (item: DraftAttachment) => (
    <button type="button" className="kb-attachment041-remove" aria-label={`Remove ${item.name}`} disabled={readOnly} onClick={() => {
      removedKey.current = item.key;
      onRemove(item.key);
    }}>
      <Icon name="close" size={14} />
    </button>
  );

  return <>
    <ul ref={rowRef} className="kb-attachment041-row" aria-label="Draft attachments">
      {ordered.slice(0, visible).map((item) => {
        const status = attachmentStatus(item);
        return (
          <li key={item.key} className="kb-attachment041-chip" data-state={item.state}>
            {renderName?.(item) ?? (
              <button type="button" className="kb-attachment041-main" aria-haspopup="dialog"
                aria-label={`View ${item.name}`} title={item.name} onClick={(event) => openView(event.currentTarget, item.key)}>
                <AttachmentThumbnail item={item} />
                <span className="kb-attachment041-text">
                  <span>{item.name}</span>
                  {status && <small className="kb-attachment041-meta">{status}</small>}
                </span>
              </button>
            )}
            {removeButton(item)}
          </li>
        );
      })}
      {hiddenCount > 0 && (
        <li>
          <button type="button" className="kb-attachment041-more" aria-haspopup="dialog"
            aria-label={`Show all ${items.length} attachments`} onClick={(event) => openView(event.currentTarget)}>+{hiddenCount}</button>
        </li>
      )}
    </ul>
    {video && onResolveVideo && (
      <div key={video.key} className="kb-attachment041-confirm" role="group" aria-label={`Import audio from ${video.name}`}
        onKeyDown={(event) => {
          if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
          if (event.key !== 'Escape' || readOnly) return;
          event.preventDefault();
          event.stopPropagation();
          onResolveVideo(video.key, false);
        }}>
        <div className="kb-attachment041-confirm-copy">
          <strong>{video.name}</strong>
          <p id={noticeId} role="status">{LOCAL_VIDEO_AUDIO_ONLY_NOTICE}</p>
        </div>
        <div className="kb-attachment041-confirm-actions">
          <Button size="sm" variant="quiet" disabled={readOnly} onClick={(event) => {
            if (event.detail < 2) onResolveVideo(video.key, false);
          }}>Cancel</Button>
          <Button size="sm" disabled={readOnly} aria-describedby={noticeId} onClick={(event) => {
            if (event.detail < 2) onResolveVideo(video.key, true);
          }}>Import audio</Button>
        </div>
      </div>
    )}
    {blocker && !video && (
      <p className="kb-attachment041-blocker" role={failed ? 'alert' : 'status'} title={blocker}>{blocker}</p>
    )}
    <Modal open={modalOpen} onClose={() => setView(null)} title={selected?.name ?? 'Attachments'} className="kb-attachment041-dialog">
      <ul ref={detailsRef} className="kb-attachment041-details" aria-label="Attachments" tabIndex={-1}>
        {(selected ? [selected] : items).map((item) => {
          const status = attachmentStatus(item);
          return (
            <li key={item.key} className="kb-attachment041-detail" data-state={item.state}>
              {!selected && <AttachmentThumbnail item={item} />}
              <div className="kb-attachment041-detail-text">
                {!selected && (renderName?.(item) ?? <strong>{item.name}</strong>)}
                {status && <p className="kb-attachment041-meta">{status}</p>}
                {canAddAttachmentToWiki(item) && (
                  <label className="kb-attachment__wiki">
                    <input type="checkbox" checked={item.inWiki} disabled={readOnly} onChange={() => onToggleWiki(item.key)} />
                    In wiki
                  </label>
                )}
              </div>
              {item.state === 'failed' && item.source === 'file' && onReplace && (
                <Button size="sm" variant="outline" disabled={readOnly || items.some((entry) => entry.replaceKey === item.key)} aria-label={`Replace ${item.name}`}
                  onClick={() => { removedKey.current = item.key; onReplace(item.key); }}>Replace file</Button>
              )}
              {removeButton(item)}
            </li>
          );
        })}
      </ul>
      {selected && <AttachmentThumbnail key={selected.key} item={selected} large />}
      {selected && items.length > 1 && <Button size="sm" variant="outline" onClick={() => {
        setView({});
        detailsRef.current?.focus({ preventScroll: true });
      }}>All attachments</Button>}
    </Modal>
  </>;
}
