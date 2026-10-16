import { useEffect, useState } from 'react';
import type { KbJob } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import { Button, Icon, Modal } from '../ui';
import { useServices } from '../state/context';

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'confirm'; path: string; entries: number }
  | { kind: 'running'; path: string; job: KbJob }
  | { kind: 'done'; path: string; text: string }
  | { kind: 'error'; text: string };

const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/**
 * Settings → Storage → Export (B20): the whole wiki as plain .md (links kept, sources as footnotes
 * with the quote) plus the materials' .md into a folder picked in the native chooser. A folder in
 * the library is refused; a non-empty one only after a confirmation. Progress while it runs, then
 * the result with "Show in Finder" (also a notification).
 */
export function ExportRow() {
  const { bridge, client } = useServices();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [opened, setOpened] = useState<boolean | null>(null);
  const runningId = phase.kind === 'running' ? phase.job.id : null;
  const runningPath = phase.kind === 'running' ? phase.path : null;

  useEffect(() => {
    if (!runningId || !runningPath) return undefined;
    let live = true;
    const path = runningPath;
    const timer = window.setInterval(() => {
      client.call('GET /kb/jobs/{job_id}', { path: { job_id: runningId } }).then((job) => {
        if (!live) return;
        if (job.state === 'running') { setPhase({ kind: 'running', path, job }); return; }
        if (job.state === 'done') setPhase({ kind: 'done', path, text: job.journal.at(-1)?.message ?? 'Exported.' });
        else setPhase({ kind: 'error', text: job.error ?? 'The export didn’t finish.' });
      }, (error: unknown) => { if (live) setPhase({ kind: 'error', text: `SKAZ lost track of the export: ${errorText(error)}` }); });
    }, 1000);
    return () => { live = false; window.clearInterval(timer); };
  }, [client, runningId, runningPath]);

  if (!bridge.chooseExportFolder) return <span className="kb-muted">Export works in the SKAZ desktop app.</span>;

  const start = async (path: string, overwrite: boolean) => {
    try {
      const job = await client.call('POST /kb/export', { body: { path, overwrite } });
      setOpened(null);
      setPhase({ kind: 'running', path, job });
    } catch (error) {
      setPhase({ kind: 'error', text: errorText(error) });
    }
  };
  const choose = async () => {
    const path = await bridge.chooseExportFolder!().catch(() => null);
    if (!path) return;
    setPhase({ kind: 'checking' });
    try {
      const target = await client.call('GET /kb/export/target', { query: { path } });
      if (target.reason) { setPhase({ kind: 'error', text: target.reason }); return; }
      if (target.non_empty) { setPhase({ kind: 'confirm', path: target.path, entries: target.entries }); return; }
      await start(target.path, false);
    } catch (error) {
      setPhase({ kind: 'error', text: errorText(error) });
    }
  };
  const progress = phase.kind === 'running' ? phase.job.progress : null;
  const pct = progress && progress.parts_total > 0 ? Math.round((progress.parts_done / progress.parts_total) * 100) : null;

  return (
    <span className="kb-export">
      {phase.kind === 'running' ? (
        <span className="kb-progress-row">
          <span className="kb-progress" role="progressbar" aria-label="Exporting" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
            <i style={{ width: `${pct ?? 10}%` }} />
          </span>
          <span className="kb-muted">Exporting{progress && progress.parts_total ? ` · ${progress.parts_done} of ${progress.parts_total}` : '…'}</span>
        </span>
      ) : (
        <Button size="sm" busy={phase.kind === 'checking'} onClick={() => void choose()}>Export…</Button>
      )}
      {phase.kind === 'done' && (
        <>
          <span className="kb-status kb-status--ok" role="status"><Icon name="check" size={13} />{phase.text}</span>
          {bridge.showInFinder && (
            <Button size="sm" variant="outline" onClick={async () => setOpened(await bridge.showInFinder!({ kind: 'export', path: phase.path }).catch(() => false))}>
              Show in Finder
            </Button>
          )}
          {opened === false && <span className="kb-inline-error kb-inline-error--flat" role="alert">Finder couldn’t open “{folderName(phase.path)}”.</span>}
        </>
      )}
      {phase.kind === 'error' && <span className="kb-inline-error kb-inline-error--flat" role="alert">{phase.text}</span>}
      <Modal open={phase.kind === 'confirm'} onClose={() => setPhase({ kind: 'idle' })} title="Export into a folder that isn’t empty?"
        className="kb-confirm" testId="confirm-export">
        {phase.kind === 'confirm' && (
          <>
            <div className="kb-confirm__body">
              <p>“{folderName(phase.path)}” already holds {phase.entries === 1 ? '1 item' : `${phase.entries} items`}.</p>
              <p className="kb-muted">Files with the same names are replaced; everything else in the folder stays.</p>
            </div>
            <footer className="kb-confirm__foot">
              <Button onClick={() => setPhase({ kind: 'idle' })}>Cancel</Button>
              <Button variant="fill" onClick={() => void start(phase.path, true)}>Export here</Button>
            </footer>
          </>
        )}
      </Modal>
    </span>
  );
}
