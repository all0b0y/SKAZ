import { useState } from 'react';
import type { KbRecognitionSettings } from '../../api/kb/types.gen';
import type { EngineId } from '../api/names';
import { errorText } from '../api/client';
import { Icon } from '../ui';
import { ENGINE_NAME, agentOf } from '../state/agents';
import { useAgents, useServices } from '../state/context';
import { useLoad } from '../document/useLoad';
import { modelName } from '../composer/modelCatalog';
import { AgentPicker, effortLabel } from '../composer/AgentPicker';

type Choice = KbRecognitionSettings['engine'];

/**
 * Settings → Models → Recognition check (B20; models screen v2): the agent that checks recordings
 * for recognition errors — the same picker as the wiki model, with "Same as wiki model" (default)
 * and "Off" (the step is skipped and the job says so) on top.
 */
export function RecognitionCheckRow({ label }: { label: string }) {
  const { client } = useServices();
  const agents = useAgents((s) => s.agents);
  const { state, set, reload } = useLoad('recognition-settings', () => client.call('GET /kb/settings/recognition'));
  const [error, setError] = useState<string | null>(null);
  const value = state.value;
  if (!value) {
    if (state.load === 'error') {
      return (
        <span className="kb-inline-error kb-inline-error--flat" role="alert">
          Couldn’t read: {state.error}
          <button type="button" className="kb-linkbtn" onClick={reload}><Icon name="retry" size={12} />Try again</button>
        </span>
      );
    }
    return <span className="kb-muted" role="status">Reading…</span>;
  }
  const save = async (next: { engine: Choice; model?: string | null; effort?: string | null }) => {
    try {
      set(await client.call('PUT /kb/settings/recognition', { body: { engine: next.engine, model: next.model ?? null, effort: next.effort ?? null } }));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const chosen = value.engine !== 'same_as_wiki' && value.engine !== 'off' ? agentOf(agents, value.engine as EngineId) : undefined;
  const model = chosen?.models.find((m) => m.id === value.model);
  const words = value.engine === 'same_as_wiki' ? ['Same as wiki model'] : value.engine === 'off' ? ['Off']
    : [ENGINE_NAME[value.engine as EngineId].replace(' Agent', ''), model ? modelName(model) : value.model ?? 'agent’s own setting',
      ...(model && value.effort ? [effortLabel(value.effort)] : [])];
  return (
    <span className="kb-recog">
      <AgentPicker existingChat={false} lastOf={() => null}
        choice={chosen ? { engine: chosen.id, model: value.model, effort: value.effort } : null}
        onChoose={(next) => {
          if (agentOf(agents, next.engine)?.state !== 'ready') {
            setError(`${ENGINE_NAME[next.engine]} isn’t connected — set it up in Accounts & keys.`);
            return;
          }
          void save({ engine: next.engine, model: next.model, effort: next.model ? next.effort : null });
        }}
        settings={{
          menuLabel: label, testId: 'recognition-picker', buttonEngine: chosen?.id ?? null,
          buttonLabel: `${label}: ${words.join(', ')}`, buttonText: words.join(' · '),
          topItems: [
            { id: 'same', label: 'Same as wiki model', checked: value.engine === 'same_as_wiki', onPick: () => void save({ engine: 'same_as_wiki' }) },
            { id: 'off', label: 'Off', checked: value.engine === 'off', onPick: () => void save({ engine: 'off' }) },
          ],
          reasoning: model ? { efforts: model.efforts, value: value.effort,
            onChange: (e) => void save({ engine: value.engine, model: value.model, effort: e }) } : undefined,
        }} />
      {value.engine === 'off' && <span className="kb-muted">Recordings go to the wiki as recognised.</span>}
      {error && <span className="kb-inline-error kb-inline-error--flat" role="alert">{error}</span>}
    </span>
  );
}
