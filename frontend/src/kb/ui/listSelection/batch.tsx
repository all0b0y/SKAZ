import { useEffect, useState, type ReactNode } from 'react';
import { errorText } from '../../api/client';
import { Banner } from '../Banner';
import { Button } from '../Button';
import { Modal } from '../Modal';
import { Spinner } from '../Status';

/** What a batch did: the ids done, and each skipped id with the backend's reason (409 and others). */
export interface BatchResult { done: string[]; skipped: Array<{ id: string; reason: string }> }

/**
 * One request per item, in order, over the existing routes (contract: no batch endpoint). A failure
 * doesn't stop the rest: it is kept with its reason.
 */
export async function runOneByOne(ids: readonly string[], fn: (id: string) => Promise<unknown>): Promise<BatchResult> {
  const out: BatchResult = { done: [], skipped: [] };
  for (const id of ids) {
    try {
      await fn(id);
      out.done.push(id);
    } catch (error) {
      out.skipped.push({ id, reason: errorText(error) });
    }
  }
  return out;
}

export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Deleted 3 chats" or "Deleted 2, skipped 1 — <reason>". */
export function resultText(verb: string, result: BatchResult, one: string, many?: string): string {
  if (!result.skipped.length) return `${verb} ${countOf(result.done.length, one, many)}`;
  const reasons = [...new Set(result.skipped.map((s) => s.reason))];
  const why = reasons.length === 1 ? reasons[0] : `${reasons[0]} (and ${reasons.length - 1} more reason${reasons.length > 2 ? 's' : ''})`;
  return `${verb} ${result.done.length}, skipped ${result.skipped.length} — ${why}`;
}

/** "«A», «B» and «C»" — at most `max` names, then "and N more". */
export function namesList(titles: readonly string[], max = 3): ReactNode {
  const shown = titles.slice(0, max);
  const rest = titles.length - shown.length;
  const parts: ReactNode[] = [];
  shown.forEach((t, i) => {
    if (i > 0) parts.push(i === shown.length - 1 && rest === 0 ? ' and ' : ', ');
    parts.push(<b key={`${i}-${t}`}>{t}</b>);
  });
  if (rest > 0) parts.push(` and ${rest} more`);
  return <>{parts}</>;
}

/**
 * The one consequences window of a batch delete (mockups lib-v1 «Delete 3», lib-v2): what goes,
 * what stays, built by the caller from the existing delete previews. Nothing is removed before
 * Delete; the outcome (deleted N, skipped M with the reason) is reported by the caller.
 */
export function BatchDeleteDialog({ open, title, count, preview, onClose, onDelete, testId }: {
  open: boolean;
  title: string;
  count: number;
  /** Builds the list of consequences (reads the previews); null while there is nothing to read. */
  preview: () => Promise<ReactNode>;
  onClose: () => void;
  onDelete: () => Promise<void>;
  testId?: string;
}) {
  const [body, setBody] = useState<ReactNode | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setBody(null); setLoadError(null); setBusy(false);
    preview().then((b) => { if (live) setBody(b); }, (e: unknown) => { if (live) setLoadError(errorText(e)); });
    return () => { live = false; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- read once per opening
  return (
    <Modal open={open} onClose={onClose} title={title} className="kb-modal--narrow kb-batchdel" testId={testId ?? 'batch-delete'} pane="batch-delete">
      <div className="kb-modal__body">
        <p className="kb-modal__hint">Nothing is removed before you press Delete.</p>
        {!body && !loadError && <div className="kb-doc__wait"><Spinner label="Checking what changes" /></div>}
        {loadError && <Banner tone="error" title="Couldn’t check what changes.">{loadError}</Banner>}
        {body}
        <div className="kb-modal__foot">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon="trash" busy={busy} disabled={!body || busy}
            onClick={async () => { setBusy(true); try { await onDelete(); } finally { setBusy(false); } }}>
            Delete {count}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
