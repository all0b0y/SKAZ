import { useState } from 'react';
import type { KbInstallTask } from '../../api/kb/types.gen';
import { copyToClipboard } from '../../lib/clipboard';
import type { EngineId } from '../api/names';
import { Button, Icon, Modal } from '../ui';
import { StippleGlobe } from '../fx/stipple/StippleWork';
import { StippleStrip } from '../fx/stipple/StippleStrip';
import { Elapsed } from '../chat/ThoughtLine';
import { useAgents, useAgentUpdates, useServices } from '../state/context';
import { agentOf, ENGINE_NAME } from '../state/agents';
import { updateOf } from '../state/agentUpdates';

type Kind = 'install' | 'update';
const TITLE: Record<KbInstallTask['action'], string> = {
  install: 'Install', update: 'Update', upgrade: 'Update', rollback: 'Roll back', first_check: 'Check', repair: 'Repair',
};
const RUNNING: Record<KbInstallTask['action'], string> = {
  install: 'Installing…', update: 'Updating…', upgrade: 'Updating…', rollback: 'Rolling back…', first_check: 'Checking…', repair: 'Repairing…',
};
export function installStatus(task: KbInstallTask): string {
  if (task.state === 'running') return task.stages?.find((s) => s.state === 'running')?.label ?? RUNNING[task.action];
  if (task.state === 'succeeded') return `Done${task.version ? ` · ${task.version}` : ''}`;
  return task.state === 'cancelled' ? 'Cancelled' : 'Failed';
}

/** The row keeps only status/progress and Details; the task itself is not owned by this view. */
export function InstallSummary({ engine }: { engine: EngineId }) {
  const { agents } = useServices();
  const view = useAgents((s) => s.installs[engine]);
  const error = useAgents((s) => s.installErrors[engine]);
  const update = useAgentUpdates((s) => updateOf(s.view, engine));
  if (!view || (update && update.phase !== 'idle' && update.task_id !== view.task.id)
    || (update?.failure && (view.task.action === 'upgrade' || view.task.action === 'rollback'))) return null;
  const running = view.task.state === 'running' && !error;
  return (
    <div className="kb-install-summary">
      <span role="status">{error ? 'Progress unavailable' : installStatus(view.task)}</span>
      <Button size="sm" variant="quiet" onClick={() => agents.getState().showInstall(engine,
        view.task.action === 'upgrade' || view.task.action === 'rollback' ? 'update' : 'install')}>Details</Button>
      {running && <StippleStrip />}
    </div>
  );
}

/** One global host: closing it changes presentation only, not monitoring or execution. */
export function InstallProgressModal() {
  const { agents } = useServices();
  const engine = useAgents((s) => s.installDialog);
  const kind = useAgents((s) => s.installDialogKind);
  const action = useAgents((s) => engine ? s.installs[engine]?.task.action : undefined);
  const title = engine ? `${kind === 'update' ? 'Update' : TITLE[action ?? 'install']} ${ENGINE_NAME[engine]}` : 'Installation';
  return (
    <Modal open={engine !== null} onClose={() => agents.getState().closeInstallDialog()} title={title}
      className="kb-install-progress" testId="install-progress" initialFocus="dialog" pane="install-progress">
      {engine && <InstallProgress key={`${engine}/${kind}`} engine={engine} kind={kind} />}
    </Modal>
  );
}

function InstallProgress({ engine, kind }: { engine: EngineId; kind: Kind }) {
  const { agents, agentUpdates } = useServices();
  const view = useAgents((s) => s.installs[engine]);
  const progressError = useAgents((s) => s.installErrors[engine]);
  const agent = useAgents((s) => agentOf(s.agents, engine));
  const update = useAgentUpdates((s) => updateOf(s.view, engine));
  const [output, setOutput] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const failure = kind === 'update' && update?.phase === 'idle' ? update.failure : null;
  const queued = kind === 'update' && update?.phase === 'queued';
  const raw = view?.task;
  const matches = kind === 'install' || (update?.task_id ? update.task_id === raw?.id
    : !failure && !queued && (raw?.action === 'upgrade' || raw?.action === 'rollback'));
  const task = matches ? raw : undefined;
  const starting = kind === 'update' && update?.phase === 'updating' && !task;
  const active = queued || starting || task?.state === 'running';
  const failed = !active && (!!failure || task?.state === 'failed');
  const observed = !progressError && (starting || task?.state === 'running');
  const lines = task && view ? view.lines.map((l) => l.text) : failure?.output ?? [];
  const command = failure?.command || task?.manual_command;
  const docs = failure?.docs_url || task?.install.docs_url;
  const state = progressError ? 'Progress unavailable' : queued ? 'Updates after current work.'
    : starting ? 'Starting update…' : failed ? 'Failed' : task ? installStatus(task) : 'Reading progress…';
  const from = Date.parse(task?.started_at ?? '');
  const run = async (what: 'cancel' | 'retry' | 'rollback' | 'check') => {
    if (busy) return;
    setBusy(what); setError(null);
    const result = what === 'check' ? await agents.getState().check(engine)
      : what === 'rollback' ? await agentUpdates.getState().rollback(engine)
        : what === 'cancel' ? (kind === 'update' ? await agentUpdates.getState().cancel(engine) : await agents.getState().cancelInstall(engine))
          : kind === 'update' ? await agentUpdates.getState().update(engine)
            : await agents.getState().install(engine, task?.action === 'first_check' || task?.action === 'repair' || task?.action === 'update' ? task.action : 'install');
    if (!result.ok) setError(result.error);
    setBusy(null);
  };
  return (
    <>
      <div className="kb-install-progress__body">
        {kind === 'update' && update && <p className="kb-muted">{update.note} {update.services_note}</p>}
        {observed && <div className="kb-install-progress__stage"><StippleGlobe /></div>}
        <p className="kb-install-progress__now" role="status">{state}
          {observed && Number.isFinite(from) && <Elapsed className="kb-web__time" from={from} />}
        </p>
        {queued && <p className="kb-muted">Current work is not interrupted. New answers from {ENGINE_NAME[engine]} wait for the update.</p>}
        {!queued && task?.stages && task.stages.length > 0 && (
          <ol className="kb-install-progress__steps" aria-label="Installation steps">
            {task.stages.map((stage, i) => <li key={i} data-state={stage.state} aria-current={stage.state === 'running' ? 'step' : undefined}>
              {stage.state === 'done' || stage.state === 'error' || stage.state === 'stopped'
                ? <Icon name={stage.state === 'done' ? 'check' : stage.state === 'error' ? 'warning' : 'cancelled'} size={13} />
                : <span className="kb-install-progress__pending" aria-hidden="true" />}
              <span>{stage.label}</span><span className="kb-muted">{stage.state}</span>
            </li>)}
          </ol>
        )}
        {failed && <>
          <p className="kb-inline-error kb-inline-error--flat" role="alert">{failure?.reason ?? task?.reason ?? 'The task did not complete.'}</p>
          <p className="kb-muted">An unsuccessful installer does not confirm whether the agent still works.</p>
          {agent && <p className="kb-muted">Last checked: {agent.state === 'ready' ? `Connected${agent.version ? ` · ${agent.version}` : ''}` : agent.reason ?? agent.state}</p>}
          <Button size="sm" variant="quiet" disabled={!!busy} busy={busy === 'check'} onClick={() => void run('check')}>Check agent</Button>
        </>}
        {progressError && <p role="alert" className="kb-inline-error kb-inline-error--flat">{progressError} The task may still be running.
          {' '}<Button size="sm" variant="quiet" onClick={() => {
            const id = view?.task.id ?? agent?.install_task;
            if (id) agents.getState().followInstall(engine, id);
          }}>Read progress again</Button>
        </p>}
        <button type="button" className="kb-install-progress__fold" aria-label={output ? 'Hide output' : 'Show output'} aria-expanded={output} onClick={() => setOutput((v) => !v)}>
          <Icon name={output ? 'chevronDown' : 'chevronRight'} size={13} />{output ? 'Hide output' : 'Show output'} · {lines.length} {lines.length === 1 ? 'line' : 'lines'}
        </button>
        {output && <pre className="kb-installlog__lines" aria-label="Install log" tabIndex={0}>
          {task && task.dropped > 0 && `… ${task.dropped} earlier lines\n`}{lines.join('\n')}
        </pre>}
        {failed && command && <div className="kb-install-progress__manual">
          <p>Run it yourself in Terminal:</p><code>{command}</code>
          <Button size="sm" variant="quiet" onClick={() => void copyToClipboard(command).then((ok) => {
            if (ok) setCopied(command); else setError('Could not copy the command. Select it and copy manually.');
          })}>{copied === command ? 'Copied' : 'Copy command'}</Button>
        </div>}
        {failed && docs && <a className="kb-md__link" href={docs} target="_blank" rel="noreferrer noopener">instructions</a>}
        {failed && failure?.rollback === 'manual' && <p className="kb-muted">SKAZ can’t roll {ENGINE_NAME[engine]} back. Roll back manually{failure.previous ? ` to ${failure.previous}` : ''} using the instructions.</p>}
        {failed && failure?.rollback === 'skaz' && failure.previous && <>
          <Button size="sm" disabled={!!busy} busy={busy === 'rollback'} onClick={() => void run('rollback')}>Roll back to {failure.previous}</Button>
          {engine === 'claude_code' && <p className="kb-muted">Claude Code may update itself again.</p>}
        </>}
        {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
      </div>
      <footer className="kb-install-progress__foot">
        {active ? <>
          <Button onClick={() => agents.getState().closeInstallDialog()}>Run in background</Button>
          <Button disabled={!!busy} busy={busy === 'cancel'} onClick={() => void run('cancel')}>Cancel installation</Button>
        </> : <>
          {failed && <Button variant="fill" disabled={!!busy} busy={busy === 'retry'} onClick={() => void run('retry')}>Try again</Button>}
          <Button onClick={() => agents.getState().closeInstallDialog()}>Close</Button>
        </>}
      </footer>
    </>
  );
}
