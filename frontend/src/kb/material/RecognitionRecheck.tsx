import { useEffect, useState } from 'react';
import type { KbJob, KbMaterial } from '../../api/kb/types.gen';
import { errorText } from '../api/client';
import type { MenuItem } from '../ui/Popover';
import { Button } from '../ui';
import { agentOf } from '../state/agents';
import { useAgents, useServices, useSettings, useUi } from '../state/context';

const SPEECH = new Set<KbMaterial['kind']>(['recording', 'audio', 'video', 'video_link']);
const AGENT_UNAVAILABLE = 'AGENT_UNAVAILABLE';

type Result = { kind: 'error'; text: string; agent: boolean } | { kind: 'done'; text: string } | null;

/**
 * "Check recognition again" in a recording's ⋯ menu (B20): a backend job on the agent chosen in
 * Settings → Models → Recognition check. Disabled, with the reason as the item's note, when it
 * can't run: the text isn't ready, the check is off, or no agent for it is connected. A job that
 * ends without a result says why under the title.
 */
export function useRecognitionRecheck(material: KbMaterial | null, jobs: KbJob[], reload: () => void) {
  const { client, settings } = useServices();
  const agents = useAgents((s) => s.agents);
  const wiki = useSettings((s) => s.wiki.value);
  const openSettings = useUi((s) => s.openSettings);
  const [choice, setChoice] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);
  const speech = material !== null && SPEECH.has(material.kind);

  useEffect(() => {
    if (!speech) return undefined;
    let live = true;
    client.call('GET /kb/settings/recognition').then((r) => { if (live) setChoice(r.engine); }, () => undefined);
    if (!settings.getState().wiki.value) void settings.getState().loadWiki();
    return () => { live = false; };
  }, [client, settings, speech, material?.id]);

  useEffect(() => { setJobId(null); setResult(null); }, [material?.id]);

  // The job's end: say how it went (the material itself reloads while it runs).
  const job = jobId ? jobs.find((j) => j.id === jobId) : undefined;
  useEffect(() => {
    if (!job || job.state === 'running') return;
    setJobId(null);
    if (job.state === 'done') setResult({ kind: 'done', text: 'Recognition checked again.' });
    else setResult({ kind: 'error', text: job.error?.trim() || 'The recognition check didn’t finish.', agent: job.error_code === AGENT_UNAVAILABLE });
  }, [job]);

  if (!speech || !material) return { item: null, message: null };
  const engine = choice && choice !== 'same_as_wiki' && choice !== 'off' ? choice : (wiki?.wiki_engine ?? agents?.default ?? null);
  const agent = engine ? agentOf(agents, engine as Parameters<typeof agentOf>[1]) : undefined;
  const running = jobs.some((j) => j.state === 'running');
  const reason = material.status !== 'ready' ? 'Not finished'
    : material.fragments.length === 0 ? 'No speech'
      : choice === 'off' ? 'Check is off in Settings'
        : agents && agent?.state !== 'ready' ? 'No agent connected'
          : running ? 'Busy' : undefined;
  const item: MenuItem = {
    id: 'recheck-recognition', label: 'Check recognition again', icon: 'retry', disabled: Boolean(reason), note: reason,
    onSelect: () => {
      setResult(null);
      client.call('POST /kb/materials/{material_id}/recognition-check', { path: { material_id: material.id } }).then(
        (started) => { setJobId(started.id); reload(); },
        (error: unknown) => setResult({ kind: 'error', text: errorText(error), agent: /agent/i.test(errorText(error)) }),
      );
    },
  };
  const message = result ? (
    result.kind === 'done' ? <p className="kb-mat__note" role="status">{result.text}</p> : (
      <div className="kb-inline-error" role="alert">
        <b>Couldn’t check recognition again.</b> {result.text}
        {result.agent && <Button size="sm" variant="outline" icon="settings" onClick={() => openSettings('conn')}>Open Accounts &amp; keys</Button>}
      </div>
    )
  ) : null;
  return { item, message };
}
