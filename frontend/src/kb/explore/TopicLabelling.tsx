import type { KbTopicLabelling } from '../../api/kb/types.gen';
import type { SettingsSection } from '../state/ui';

export function TopicLabelling({ job, unsorted, busy, onSort, onSettings }: {
  job: KbTopicLabelling; unsorted: number; busy: boolean; onSort: () => void; onSettings: (section: SettingsSection) => void;
}) {
  if (job.state === 'idle' && unsorted === 0) return null;
  const decisionMissing = job.reason_code === 'decision_model_required';
  return <section className="kb-topic-labelling" aria-label="Topic organization" aria-live="polite">
    {job.state === 'not_ready' ? <>
      <p>{decisionMissing ? 'Set up a decision model to organize your topics.' : 'Set up a wiki engine to organize your topics.'}</p>
      <button type="button" className="kb-explore-btn" onClick={() => onSettings(decisionMissing ? 'search' : 'wiki')}>{decisionMissing ? 'Search settings' : 'Wiki settings'}</button>
    </> : job.state === 'running' || job.state === 'paused' ? <>
      <p>{job.state === 'paused' ? 'Topic organization paused' : 'Organizing your topics'} · {job.done} of {job.total} materials{job.engine ? ` · ${job.engine}` : ''}</p>
      {job.state === 'running' && <progress aria-label="Materials organized" value={job.done} max={Math.max(1, job.total)} />}
      {job.state === 'paused' && <>
        <p className="kb-explore-cap">{job.reason_code === 'engine_limit' ? 'The wiki engine reached its limit. Your progress is saved; you can continue when it is available.' : 'Your progress is saved. Continue when you are ready.'}</p>
        <button type="button" className="kb-explore-btn" disabled={busy} onClick={onSort}>Continue organizing</button>
        <button type="button" className="kb-explore-link" onClick={() => onSettings(decisionMissing ? 'search' : 'wiki')}>Open settings</button>
      </>}
    </> : <>
      <p>{unsorted} {unsorted === 1 ? 'material has' : 'materials have'} no topic yet.</p>
      <button type="button" className="kb-explore-btn" disabled={busy} onClick={onSort}>Organize topics</button>
    </>}
  </section>;
}
