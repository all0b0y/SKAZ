import type { KbJob, KbMaterial, KbMaterialWiki } from '../../api/kb/types.gen';
import { Button, Icon, type IconName } from '../ui';
import { plural } from '../document/text';
import { useServices, useUi } from '../state/context';

const STEP_LABEL: Record<string, string> = {
  reading: 'Reading the material',
  checking_recognition: 'Checking recognition',
  writing_notes: 'Writing notes',
  concepts: 'Updating concepts',
  saving: 'Saving to the wiki',
};

/** What a running job is doing now, in words; unknown steps fall back to the job's own label. */
export function stepLabel(job: KbJob): string {
  const known = job.step ? STEP_LABEL[job.step] : undefined;
  if (known) return known;
  return job.label || 'Processing';
}

const SPEECH: ReadonlyArray<KbMaterial['kind']> = ['recording', 'audio', 'video', 'video_link'];

function Pill({ tone, icon, spin, children, onClick, label }: {
  tone: 'done' | 'run' | 'todo' | 'error' | 'warn';
  icon?: IconName;
  spin?: boolean;
  children: string;
  onClick?: () => void;
  label?: string;
}) {
  const body = (
    <>
      {spin ? <span className="kb-spinner kb-spinner--xs" aria-hidden="true" /> : icon ? <Icon name={icon} size={12} /> : null}
      <span>{children}</span>
      {onClick && <Icon name="external" size={11} />}
    </>
  );
  if (onClick) {
    return <button type="button" className={`kb-pst kb-pst--${tone} is-link`} onClick={onClick} aria-label={label}>{body}</button>;
  }
  return <span className={`kb-pst kb-pst--${tone}`} role="status">{body}</span>;
}

/** Processing strip (v10, decision 24): what is done, what runs now, links into the wiki. */
export function StatusChips({ material, jobs, onAddToWiki, adding }: {
  material: KbMaterial;
  jobs: KbJob[];
  onAddToWiki: () => void;
  adding: boolean;
}) {
  const openDocument = useUi((s) => s.openDocument);
  const { prefs } = useServices();
  const speech = SPEECH.includes(material.kind);
  const first = speech ? 'Recognised' : material.kind === 'web' ? 'Text cleaned' : material.kind === 'text' ? 'Text saved' : 'Text extracted';
  const running = jobs.find((j) => j.state === 'running');
  // Package-1 backends have no `wiki`: then nothing is claimed about the wiki.
  const wiki = material.wiki as KbMaterialWiki | undefined;
  const counts = material.correction_counts;

  return (
    <div className="kb-pipe" aria-label="Processing">
      {material.status === 'recording' && <Pill tone="run" spin>Recording</Pill>}
      {material.status === 'processing' && <Pill tone="run" spin>{speech ? 'Recognising…' : 'Reading…'}</Pill>}
      {material.status === 'failed' && <Pill tone="error" icon="warning">{speech ? 'Recognition failed' : 'Couldn’t read'}</Pill>}
      {material.status === 'ready' && <Pill tone="done" icon="check">{first}</Pill>}
      {material.translation && material.translation.fragments.length > 0 && <Pill tone="done" icon="check">Translated</Pill>}
      {speech && counts.applied > 0 && <Pill tone="done" icon="check">{plural(counts.applied, 'correction')}</Pill>}
      {speech && counts.doubtful > 0 && <Pill tone="warn" icon="warning">{`${counts.doubtful} doubtful`}</Pill>}
      {running && <Pill tone="run" spin>{stepLabel(running)}</Pill>}
      {!running && wiki?.state === 'processing' && <Pill tone="run" spin>Adding to the wiki</Pill>}
      {wiki?.state === 'in_wiki' && wiki.note_page_id && (
        <Pill tone="done" icon="pdf" label="Open the notes" onClick={() => openDocument({ type: 'page', id: wiki.note_page_id! })}>Notes</Pill>
      )}
      {wiki?.state === 'in_wiki' && (
        <Pill tone="done" icon="concept" label={`${plural(wiki.concept_count, 'concept')} in wiki — show the wiki`}
          onClick={() => prefs.getState().set({ section: 'wiki', sideOpen: true })}>
          {`${plural(wiki.concept_count, 'concept')} in wiki`}
        </Pill>
      )}
      {wiki?.state === 'not_in_wiki' && material.status === 'ready' && (
        <>
          <Pill tone="todo">Not in wiki</Pill>
          <Button size="sm" variant="quiet" icon="plus" busy={adding} onClick={onAddToWiki}>Add to wiki</Button>
        </>
      )}
      {wiki?.state === 'failed' && (
        <>
          <Pill tone="error" icon="warning">{wiki.error ? `Wiki: ${wiki.error}` : 'Couldn’t add to the wiki'}</Pill>
          <Button size="sm" variant="quiet" icon="retry" busy={adding} onClick={onAddToWiki}>Try again</Button>
        </>
      )}
    </div>
  );
}
