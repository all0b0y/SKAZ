import type { KbContinue, KbExploreJob, KbRepeatCheck, KbWeeklyCheck } from '../../api/kb/types.gen';

export function stopExplanation(job: KbExploreJob): string {
  switch (job.stop_reason) {
    case 'science_consent_required': return 'Science search needs your permission. Enable it in Settings → Search, then Continue.';
    case 'openalex_daily_limit': return `OpenAlex daily limit reached. Add a key in Settings or Continue after ${job.retry_at ?? 'the limit resets'}.`;
    case 'provider_unavailable': return 'The provider is unavailable. Continue to retry when it is available.';
    case 'decision_model_required': return 'Choose how to compare candidates. A local model is free; OpenRouter Jev uses your account.';
    case 'budget': return 'This batch reached its budget. Continue starts the next batch.';
    case 'app_exit': return 'Paused when SKAZ closed. Free steps resume by themselves; paid checks wait for Continue.';
    case 'user_pause': return 'Paused by you. Continue resumes from the saved point.';
    default: return 'The check stopped. Its latest saved state is shown here.';
  }
}

export function CheckProgress({ job, kind, busy, onPause, onResume, onOpenSettings }: {
  job: KbRepeatCheck | KbWeeklyCheck;
  kind: 'repeat' | 'weekly';
  busy: boolean;
  onPause: () => void;
  onResume: (choice?: KbContinue['decision_choice']) => void;
  onOpenSettings: () => void;
}) {
  if (!['queued', 'running', 'paused', 'error'].includes(job.state)) return null;
  const paused = job.state === 'paused';
  const name = kind === 'weekly' ? 'Weekly check' : 'Repeat check';
  const settings = job.stop_reason === 'science_consent_required' || job.stop_reason === 'openalex_daily_limit';
  return (
    <section className="kb-explore-repeats-box" role="region" aria-label={name}>
      <div className="kb-explore-repeats-box__title">
        {paused ? `${name} paused` : job.state === 'error' ? `${name} stopped` : kind === 'repeat' ? 'Checking older materials' : `Weekly check ${job.state}`}
      </div>
      {'materials_checked' in job && <div className="kb-explore-repeats-box__meta">
        {job.materials_checked} of {job.materials_checked + job.materials_remaining} materials checked
      </div>}
      <div className="kb-explore-repeats-box__meta">Budget used: {job.budget.used} of {job.budget.limit} {job.budget.unit === 'claim_comparison' ? 'claim comparisons' : 'candidates'}</div>
      {(paused || job.state === 'error') && <p className="kb-explore-stop-box__text">{stopExplanation(job)}</p>}
      <div className="kb-explore-repeats-box__actions">
        {job.state === 'running' && <button type="button" className="kb-explore-btn" disabled={busy} onClick={onPause}>Pause</button>}
        {settings && <button type="button" className="kb-explore-btn" onClick={onOpenSettings}>Open Settings</button>}
        {paused && (job.stop_reason === 'decision_model_required' ? job.decision_choices.map((choice) => (
          <button key={choice} type="button" className="kb-explore-btn" disabled={busy || !job.checkpoint} onClick={() => onResume(choice)}>
            {choice === 'download_local' ? 'Download local model · free' : 'Use OpenRouter Jev'}
          </button>
        )) : <button type="button" className="kb-explore-btn" disabled={busy || !job.checkpoint} onClick={() => onResume()}>Continue</button>)}
      </div>
    </section>
  );
}
