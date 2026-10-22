// The agents' models as the picker and "Edit models…" show them (0.3.1 K2/K4, decision Q15):
// agent → provider section → model, with the human names the backend gives.

import type { KbAgent, KbAgentModel, KbAgentProvider, KbAgents } from '../../api/kb/types.gen';
import type { EngineId } from '../api/names';

export interface ProviderSection {
  provider: KbAgentProvider;
  models: KbAgentModel[];
}

/** Provider sections in the agent's order (a provider the backend didn't list comes last). */
export function sectionsOf(agent: KbAgent): ProviderSection[] {
  const known = agent.providers.map((provider) => ({ provider, models: agent.models.filter((m) => m.provider === provider.id) }));
  const rest = agent.models.filter((m) => !agent.providers.some((p) => p.id === m.provider));
  const extra: ProviderSection[] = [];
  for (const m of rest) {
    let section = extra.find((s) => s.provider.id === m.provider);
    if (!section) {
      section = { provider: { id: m.provider, label: m.provider_label, visible: true, shown: 0, total: 0 }, models: [] };
      extra.push(section);
    }
    section.models.push(m);
  }
  return [...known, ...extra];
}

/** Codex and Claude Code are their own single provider: no provider heading under the agent. */
export function ownProvider(agent: KbAgent): boolean {
  return agent.providers.length <= 1 && (agent.providers[0]?.id ?? agent.id) === agent.id;
}

/** The model's name as the picker shows it: "Opus 5.5", with its grey tag. */
export function modelName(model: Pick<KbAgentModel, 'name' | 'label' | 'id' | 'tag'>): string {
  const name = model.name || model.label || model.id;
  return model.tag ? `${name} ${model.tag}` : name;
}

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** Every word of the query is in the model's name, id, provider or agent (search finds hidden ones too). */
export function matchesModel(query: string, agent: KbAgent, model: KbAgentModel): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold([model.name, model.tag ?? '', model.label, model.id, model.provider_label, agent.name].join(' '));
  return words.every((w) => hay.includes(w));
}

export interface FavoriteEntry {
  agent: KbAgent;
  model: KbAgentModel;
}

/** Starred models that still exist, in the order they were added. */
export function favoritesOf(agents: KbAgents): FavoriteEntry[] {
  const out: FavoriteEntry[] = [];
  for (const f of agents.favorites) {
    const agent = agents.agents.find((a) => a.id === f.engine);
    const model = agent?.models.find((m) => m.id === f.model);
    if (agent && model) out.push({ agent, model });
  }
  return out;
}

/** Shown in the picker without a search: its own flag, its section's and its agent's. */
export function shownInPicker(agent: KbAgent, model: KbAgentModel): boolean {
  const section = agent.providers.find((p) => p.id === model.provider);
  return model.visible && (section?.visible ?? true);
}

export function agentShown(agents: KbAgents, engine: EngineId): boolean {
  const agent = agents.agents.find((a) => a.id === engine);
  return !!agent && (agent.visible || agents.default === engine);
}
