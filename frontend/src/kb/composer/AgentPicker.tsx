import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { KbAgent, KbAgentModel } from '../../api/kb/types.gen';
import type { EngineId } from '../api/names';
import { Icon } from '../ui';
import { Popover } from '../ui/Popover';
import { EngineBadge } from '../ui/EngineBadge';
import { ProviderIcon } from '../ui/ProviderIcon';
import { agentShown, favoritesOf, matchesModel, modelName, ownProvider, sectionsOf, shownInPicker } from './modelCatalog';
import { ENGINE_ORDER, ENGINE_NAME } from '../state/agents';
import type { AgentChoice } from '../state/chats';
import { useAgents, useServices, useUi } from '../state/context';

const STATE_LABEL: Partial<Record<KbAgent['state'], string>> = {
  not_installed: 'not installed',
  signed_out: 'not signed in',
  outdated: 'needs an update',
  unavailable: 'unavailable',
  preparing: 'preparing',
};

const EFFORT_LABEL: Record<string, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high' };
export const effortLabel = (e: string) => EFFORT_LABEL[e] ?? e.charAt(0).toUpperCase() + e.slice(1);

function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  // In the search field only ↓ leaves it for the list; the other keys edit the text.
  if (event.target instanceof HTMLInputElement && event.key !== 'ArrowDown') return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])'));
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (event.key === 'ArrowDown') next = items[(i + 1) % items.length];
  else if (event.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
  else if (event.key === 'Home') next = items[0];
  else if (event.key === 'End') next = items[items.length - 1];
  if (next) { event.preventDefault(); next.focus(); }
}

/** Provider sections the user folded in this window (decision Q15: a provider heading collapses). */
const folded = new Set<string>();

function ModelItem({ agent, model, checked, ready, label, onPick, onStar }: {
  agent: KbAgent;
  model: KbAgentModel;
  checked: boolean;
  ready: boolean;
  /** "hidden" when search or "+ N hidden" shows a model the picker normally leaves out. */
  label?: string;
  onPick: () => void;
  onStar: () => void;
}) {
  const star = model.favorite ? 'Remove from favorites' : 'Add to favorites';
  return (
    <div className="kb-agentmenu__row" data-model={model.id}>
      <button type="button" role="menuitemradio" tabIndex={-1} className="kb-menu__item kb-agentmenu__item"
        aria-checked={checked} aria-disabled={!ready || undefined} aria-label={`${modelName(model)}${label ? `, ${label}` : ''}`}
        title={`${model.id}${label ? ` · ${label}` : ''} · ⇧Click: ${star.toLowerCase()}`}
        onClick={(e) => {
          if (e.shiftKey) { e.preventDefault(); onStar(); return; }
          if (ready) onPick();
        }}>
        <span className="kb-menu__label">{model.name || model.label}</span>
        {model.tag && <span className="kb-agentmenu__tag">{model.tag}</span>}
        {label && <span className="kb-agentmenu__hidden">{label}</span>}
        {checked && <Icon name="check" size={14} />}
      </button>
      <button type="button" tabIndex={-1} className={`kb-agentmenu__star${model.favorite ? ' is-on' : ''}`} aria-label={`${star}: ${modelName(model)} (${agent.name})`}
        aria-pressed={model.favorite} onClick={onStar}>
        <Icon name="star" size={13} />
      </button>
    </div>
  );
}

/**
 * Agent + model in the message field (v21, decision 34; 0.3.1 K4 variant A, like Hermes desktop):
 * a search on top that also finds hidden models, Favorites (★ or ⇧Click, in the order they were
 * added), then the agents shown in the picker, each with its provider sections and the models shown
 * there, "+ N hidden" to see the rest. Only connected agents can be chosen — the others say why. On
 * an existing chat the new agent gets the conversation as context. Nothing is swapped silently.
 */
export function AgentPicker({ choice, onChoose, existingChat }: {
  choice: AgentChoice | null;
  onChoose: (choice: AgentChoice) => void;
  existingChat: boolean;
}) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [, setFoldTick] = useState(0);
  const agents = useAgents((s) => s.agents);
  const { agents: agentsStore } = useServices();
  // Opening the menu checks the agents by themselves (throttled in the store).
  useEffect(() => { if (open) agentsStore.getState().autoCheck('open'); }, [open, agentsStore]);
  useEffect(() => { if (!open) { setQuery(''); setExpanded(new Set()); } }, [open]);
  const openSettings = useUi((s) => s.openSettings);
  const openEditModels = useUi((s) => s.openEditModels);
  const current = choice ? agents?.agents.find((a) => a.id === choice.engine) : undefined;
  const currentModel = choice?.model ? current?.models.find((m) => m.id === choice.model) : undefined;
  const modelLabel = choice?.model
    ? (currentModel ? modelName(currentModel) : choice.model)
    : current?.id === 'hermes' ? 'As set in Hermes' : choice ? ENGINE_NAME[choice.engine] : 'No agent';

  const pick = (engine: EngineId, model: string | null) => {
    const agent = agents?.agents.find((a) => a.id === engine);
    const m = agent?.models.find((x) => x.id === model);
    const effort = engine === choice?.engine && m?.efforts.includes(choice.effort ?? '') ? choice.effort : m?.default_effort ?? null;
    setOpen(false);
    anchor.current?.focus({ preventScroll: true });
    onChoose({ engine, model, effort });
  };
  const star = (engine: EngineId, model: KbAgentModel) => {
    void agentsStore.getState().changeModels([{ kind: 'favorite', engine, model: model.id, value: !model.favorite }]);
  };
  const isChecked = (engine: EngineId, model: string) => choice?.engine === engine && choice.model === model;
  const item = (agent: KbAgent, m: KbAgentModel, label?: string) => (
    <ModelItem key={`${agent.id}:${m.id}`} agent={agent} model={m} checked={isChecked(agent.id, m.id)} ready={agent.state === 'ready'}
      label={label} onPick={() => pick(agent.id, m.id)} onStar={() => star(agent.id, m)} />
  );

  const searching = query.trim().length > 0;
  const favorites = agents ? favoritesOf(agents) : [];

  const agentGroup = (agent: KbAgent) => {
    const ready = agent.state === 'ready';
    const note = STATE_LABEL[agent.state];
    const head = (
      <div className="kb-agentmenu__head">
        <EngineBadge engine={agent.id} />
        <b>{agent.name}</b>
        {!agent.visible && <span className="kb-agentmenu__hidden">hidden</span>}
        {note && <span className="kb-agentmenu__state">{note}</span>}
      </div>
    );
    if (agent.models.length === 0) {
      if (searching && !matchesModel(query, agent, { id: '', label: '', name: `As set in ${agent.name}`, tag: null, provider: '', provider_label: '' } as KbAgentModel)) return null;
      return (
        <div key={agent.id} className="kb-agentmenu__group" role="group" aria-label={agent.name}>
          {head}
          <button type="button" role="menuitemradio" tabIndex={-1} className="kb-menu__item kb-agentmenu__item"
            aria-checked={choice?.engine === agent.id} aria-disabled={!ready || undefined}
            onClick={() => { if (ready) pick(agent.id, null); }}>
            <span className="kb-menu__label">As set in {agent.name.replace(' Agent', '')}</span>
            {choice?.engine === agent.id && <Icon name="check" size={14} />}
          </button>
        </div>
      );
    }
    const sections = sectionsOf(agent).map((section) => {
      const all = section.models;
      if (searching) {
        const found = all.filter((m) => matchesModel(query, agent, m));
        return { section, shown: found, hidden: [] as KbAgentModel[], searchHidden: found.filter((m) => !shownInPicker(agent, m)) };
      }
      if (!section.provider.visible && !all.some((m) => isChecked(agent.id, m.id))) return null;
      const shown = all.filter((m) => (section.provider.visible && m.visible) || isChecked(agent.id, m.id));
      return { section, shown, hidden: all.filter((m) => !shown.includes(m)), searchHidden: [] as KbAgentModel[] };
    }).filter((s): s is NonNullable<typeof s> => s !== null && (s.shown.length > 0 || (!searching && s.hidden.length > 0)));
    if (sections.length === 0) return null;
    const plain = ownProvider(agent);
    return (
      <div key={agent.id} className="kb-agentmenu__group" role="group" aria-label={agent.name}>
        {head}
        {sections.map(({ section, shown, hidden, searchHidden }) => {
          const key = `${agent.id}::${section.provider.id}`;
          const isFolded = !searching && folded.has(key);
          const more = expanded.has(key);
          return (
            <div key={key} className="kb-agentmenu__section" data-provider={section.provider.id}>
              {!plain && (
                <button type="button" tabIndex={-1} role="menuitem" className="kb-menu__item kb-agentmenu__provider" aria-expanded={!isFolded}
                  onClick={() => { if (isFolded) folded.delete(key); else folded.add(key); setFoldTick((n) => n + 1); }}>
                  <ProviderIcon provider={section.provider.id} name={section.provider.label} size={14} />
                  <span className="kb-menu__label">{section.provider.label}</span>
                  <Icon name={isFolded ? 'chevronRight' : 'chevronDown'} size={12} />
                </button>
              )}
              {!isFolded && shown.map((m) => item(agent, m, searchHidden.includes(m) || (!m.visible && !searching) ? 'hidden' : undefined))}
              {!isFolded && more && hidden.map((m) => item(agent, m, 'hidden'))}
              {!isFolded && !searching && hidden.length > 0 && (
                <button type="button" tabIndex={-1} role="menuitem" className="kb-menu__item kb-agentmenu__more"
                  onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; })}>
                  <span className="kb-menu__label">{more ? 'Show fewer' : `+ ${hidden.length} hidden`}</span>
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const shownAgents = agents ? ENGINE_ORDER.map((engine) => agents.agents.find((a) => a.id === engine))
    .filter((a): a is KbAgent => !!a && (searching || agentShown(agents, a.id) || a.id === choice?.engine)) : [];
  const groups = shownAgents.map(agentGroup).filter(Boolean);
  const favoriteRows = searching ? [] : favorites;

  return (
    <>
      <button ref={anchor} type="button" className="kb-picker" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Agent and model: ${[choice ? ENGINE_NAME[choice.engine] : 'none', modelLabel].filter((v, i, all) => all.indexOf(v) === i).join(', ')}`}
        onClick={() => setOpen((v) => !v)} data-testid="agent-picker">
        {choice && <EngineBadge engine={choice.engine} size={16} />}
        <span className="kb-picker__label">{modelLabel}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="top-end" label="Agent and model"
        role="menu" className="kb-menu kb-agentmenu" onKeyDown={moveFocus} width={340}>
        <div className="kb-agentmenu__search">
          <Icon name="search" size={13} />
          <input ref={search} type="search" aria-label="Search models" placeholder="Search models, hidden ones too" value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
            }} />
        </div>
        {!agents && <p className="kb-agentmenu__note">Agents couldn’t be read. Try again in a moment.</p>}
        {favoriteRows.length > 0 && (
          <div className="kb-agentmenu__group kb-agentmenu__favorites" role="group" aria-label="Favorites">
            <div className="kb-agentmenu__head"><Icon name="star" size={14} /><b>Favorites</b></div>
            {favoriteRows.map(({ agent, model }) => (
              <div key={`fav-${agent.id}:${model.id}`} className="kb-agentmenu__favrow">
                <EngineBadge engine={agent.id} size={16} />
                {item(agent, model)}
              </div>
            ))}
          </div>
        )}
        {groups}
        {agents && searching && groups.length === 0 && <p className="kb-agentmenu__note">No model matches “{query.trim()}”.</p>}
        <div className="kb-agentmenu__foot">
          {existingChat && <p className="kb-agentmenu__note">A new agent gets this whole chat as context.</p>}
          <button type="button" role="menuitem" tabIndex={-1} className="kb-menu__item"
            onClick={() => { setOpen(false); openEditModels(choice ? { engine: choice.engine } : undefined); }}>
            <Icon name="editModels" size={14} /><span className="kb-menu__label">Edit models…</span>
          </button>
          <button type="button" role="menuitem" tabIndex={-1} className="kb-menu__item"
            onClick={() => { setOpen(false); openSettings('models'); }}>
            <Icon name="settings" size={14} /><span className="kb-menu__label">Manage models…</span>
          </button>
        </div>
      </Popover>
    </>
  );
}

/** Reasoning effort of the chosen model; absent when the model has none (Hermes). */
export function EffortPicker({ efforts, value, onChange }: { efforts: string[]; value: string | null; onChange: (e: string) => void }) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  if (efforts.length === 0) return null;
  const shown = value && efforts.includes(value) ? value : efforts[0]!;
  return (
    <>
      <button ref={anchor} type="button" className="kb-picker kb-effort" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Effort: ${effortLabel(shown)}`} onClick={() => setOpen((v) => !v)}>
        <span className="kb-picker__label">{effortLabel(shown)}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="top-end" label="Effort" role="menu"
        className="kb-menu" onKeyDown={moveFocus} width={180}>
        {efforts.map((e) => (
          <button key={e} type="button" role="menuitemradio" tabIndex={-1} aria-checked={e === shown} className="kb-menu__item"
            onClick={() => { setOpen(false); anchor.current?.focus({ preventScroll: true }); onChange(e); }}>
            <span className="kb-menu__label">{effortLabel(e)}</span>
            {e === shown && <Icon name="check" size={14} />}
          </button>
        ))}
      </Popover>
    </>
  );
}
