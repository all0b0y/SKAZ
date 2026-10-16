import { useState } from 'react';
import type { KbRecognitionSettings } from '../../api/kb/types.gen';
import type { EngineId } from '../api/names';
import { errorText } from '../api/client';
import { Icon, Segmented } from '../ui';
import { ENGINE_NAME, ENGINE_ORDER, agentOf } from '../state/agents';
import { useAgents, useServices } from '../state/context';
import { useLoad } from '../document/useLoad';

type Choice = KbRecognitionSettings['engine'];

/**
 * Settings → Models → Recognition check (B20): the agent that checks recordings for recognition
 * errors — the same as \"Wiki pages and notes\" by default, a chosen agent with its own model and
 * effort, or Off (the step is skipped and the job says so).
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
  return (
    <span className="kb-recog">
      <Segmented<Choice> label={label} size="sm" value={value.engine}
        onChange={(v) => {
          if (v !== 'same_as_wiki' && v !== 'off' && agentOf(agents, v)?.state !== 'ready') {
            setError(`${ENGINE_NAME[v]} isn’t connected — set it up in Accounts & keys.`);
            return;
          }
          void save({ engine: v });
        }}
        options={[
          { value: 'same_as_wiki', label: 'Same as wiki pages' },
          ...ENGINE_ORDER.map((e) => ({ value: e as Choice, label: ENGINE_NAME[e].replace(' Agent', '') })),
          { value: 'off', label: 'Off' },
        ]} />
      {chosen && chosen.models.length > 0 && (
        <span className="kb-select">
          <select aria-label="Model for the recognition check" value={value.model ?? ''}
            onChange={(e) => void save({ engine: value.engine, model: e.target.value || null, effort: null })}>
            <option value="">Agent default model</option>
            {chosen.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <Icon name="chevronDown" size={12} className="kb-select__chev" />
        </span>
      )}
      {model && model.efforts.length > 0 && (
        <span className="kb-select">
          <select aria-label="Effort for the recognition check" value={value.effort ?? ''}
            onChange={(e) => void save({ engine: value.engine, model: value.model, effort: e.target.value || null })}>
            <option value="">Default effort{model.default_effort ? ` (${model.default_effort})` : ''}</option>
            {model.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </select>
          <Icon name="chevronDown" size={12} className="kb-select__chev" />
        </span>
      )}
      {value.engine === 'off' && <span className="kb-muted">Recordings go to the wiki as recognised.</span>}
      {error && <span className="kb-inline-error kb-inline-error--flat" role="alert">{error}</span>}
    </span>
  );
}
