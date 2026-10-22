import { useState } from 'react';
import type { KbAgents, KbWikiSettings, KbWikiSettingsUpdate } from '../../api/kb/types.gen';
import type { EngineId } from '../api/names';
import { ENGINE_NAME, agentOf } from '../state/agents';
import { useAgents, useServices, useSettings } from '../state/context';
import { modelName } from '../composer/modelCatalog';
import { AgentPicker, effortLabel } from '../composer/AgentPicker';
import { Button } from '../ui';

const short = (engine: EngineId) => ENGINE_NAME[engine].replace(' Agent', '');

/** "Codex, GPT-5.6-luna-mini, High" — what the wiki jobs will use, in words. */
function described(wiki: KbWikiSettings, agents: KbAgents): { engine: EngineId | null; parts: string[] } {
  if (!wiki.wiki_engine) return { engine: null, parts: ['Default agent’s own setting'] };
  const agent = agentOf(agents, wiki.wiki_engine);
  const model = agent?.models.find((m) => m.id === wiki.wiki_model);
  const parts = [short(wiki.wiki_engine)];
  if (!wiki.wiki_model) parts.push('agent’s own setting');
  else parts.push(model ? modelName(model) : wiki.wiki_model);
  if (wiki.wiki_model && wiki.wiki_effort) parts.push(effortLabel(wiki.wiki_effort));
  return { engine: wiki.wiki_engine, parts };
}

/**
 * Settings → Models → Wiki model (models screen v2, variant A): one picker button like the message
 * field's, on the label's line. Choosing another agent's model brings back the reasoning last chosen
 * for it; the menu shows each agent's last model. Reasoning sits at the bottom of the same menu.
 * Hints and warnings live under the label (`WikiModelNote`). Chats never change this profile.
 */
export function WikiModelRow({ label }: { label: string }) {
  const { settings } = useServices();
  const wiki = useSettings((s) => s.wiki);
  const agents = useAgents((s) => s.agents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!wiki.value && wiki.error) {
    // As every live row: say the read failed and offer a retry, never a dummy choice.
    return (
      <span className="kb-inline-error kb-inline-error--flat kb-srow__fail" role="alert">
        Couldn’t read: {wiki.error}
        <Button size="sm" variant="quiet" icon="retry" onClick={() => void settings.getState().loadWiki()}>Try again</Button>
      </span>
    );
  }
  if (!wiki.value || !agents) return <span className="kb-muted" role="status">Reading…</span>;
  const value = wiki.value;
  const save = async (next: KbWikiSettingsUpdate) => {
    setBusy(true);
    try {
      const result = await settings.getState().updateWiki(next);
      setError(result.ok ? null : result.error);
    } finally {
      setBusy(false);
    }
  };
  const chosen = value.wiki_engine ? agentOf(agents, value.wiki_engine) : undefined;
  const model = chosen?.models.find((m) => m.id === value.wiki_model);
  const { engine, parts } = described(value, agents);
  return (
    <span className="kb-wiki-pick" aria-busy={busy}>
      {error && <span className="kb-inline-error kb-inline-error--flat" role="alert">{error}</span>}
      <AgentPicker existingChat={false}
        choice={value.wiki_engine ? { engine: value.wiki_engine, model: value.wiki_model, effort: value.wiki_effort } : null}
        lastOf={(id) => value.wiki_remembered[id]}
        onChoose={(next) => {
          if (agentOf(agents, next.engine)?.state !== 'ready') {
            setError(`${ENGINE_NAME[next.engine]} isn’t connected — set it up in Accounts & keys.`);
            return;
          }
          void save({ wiki_engine: next.engine, wiki_model: next.model, wiki_effort: next.model ? next.effort : null });
        }}
        settings={{
          menuLabel: label, testId: 'wiki-model-picker', buttonEngine: engine,
          buttonLabel: `${label}: ${parts.join(', ')}`, buttonText: parts.join(' · '),
          topItems: [{ id: 'default', label: 'Default agent’s own setting', checked: !value.wiki_engine,
            onPick: () => void save({ wiki_engine: null }) }],
          reasoning: model ? { efforts: model.efforts, value: value.wiki_effort, onChange: (e) => void save({ wiki_effort: e }) } : undefined,
        }} />
    </span>
  );
}

/** Under the Wiki model label: what is used and what needs a choice — never a silent replacement. */
export function WikiModelNote() {
  const wiki = useSettings((s) => s.wiki.value);
  const agents = useAgents((s) => s.agents);
  if (!wiki || !agents) return null;
  const chosen = wiki.wiki_engine ? agentOf(agents, wiki.wiki_engine) : undefined;
  if (chosen && wiki.wiki_model && !chosen.models.some((m) => m.id === wiki.wiki_model)) {
    return (
      <div className="kb-inline-error kb-inline-error--flat kb-srow__warn" role="alert">
        {wiki.wiki_model} is no longer in {chosen.name.replace(' Agent', '')}’s list. Wiki jobs wait until you choose another — nothing is replaced on its own.
      </div>
    );
  }
  if (chosen && chosen.models.length === 0 && chosen.id !== 'hermes') {
    return <div className="kb-srow__hint">Model list unavailable. Check the agent in Accounts & keys.</div>;
  }
  if (!wiki.wiki_model) {
    return <div className="kb-srow__hint">Usage isn’t tracked until you choose a model.</div>;
  }
  return null;
}
