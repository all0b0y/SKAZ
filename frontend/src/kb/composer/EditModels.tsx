import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KbAgent, KbAgentModel, KbModelChange } from '../../api/kb/types.gen';
import type { EngineId } from '../api/names';
import { Button, Icon, Modal, Switch } from '../ui';
import { EngineBadge } from '../ui/EngineBadge';
import { ProviderIcon } from '../ui/ProviderIcon';
import { ENGINE_ORDER } from '../state/agents';
import { useAgents, useServices, useUi } from '../state/context';
import { matchesModel, modelName, ownProvider, sectionsOf } from './modelCatalog';

/** Which list the right side shows: one provider of one agent. */
interface Place { engine: EngineId; provider: string }

/**
 * "Edit models…" (0.3.1 K4 variant A, like Hermes desktop): on the left the agents and their
 * providers with how many models are shown, each with its own switch; on the right the chosen
 * provider's models with check boxes and stars, a search over every model, "Show defaults" (the
 * first 50 of the provider in the agent's order) and "Hide all". Changes apply at once.
 */
export function EditModelsModal() {
  const target = useUi((s) => s.editModels);
  const close = useUi((s) => s.closeEditModels);
  const agents = useAgents((s) => s.agents);
  const { agents: store } = useServices();
  const [place, setPlace] = useState<Place | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const id = useId();
  const open = target !== null;

  const list = useMemo(() => (agents ? ENGINE_ORDER.map((e) => agents.agents.find((a) => a.id === e)).filter((a): a is KbAgent => !!a) : []), [agents]);

  // Opened from the picker on the current agent (or a provider): start there; else the first with models.
  useEffect(() => {
    if (!open) { setPlace(null); setQuery(''); setError(null); return; }
    if (place) return;
    const start = list.find((a) => a.id === target?.engine && a.models.length > 0) ?? list.find((a) => a.models.length > 0);
    if (!start) return;
    const provider = target?.provider ?? sectionsOf(start)[0]?.provider.id;
    if (provider) setPlace({ engine: start.id, provider });
  }, [open, target, list, place]);

  const change = async (changes: KbModelChange[]) => {
    setError(null);
    const r = await store.getState().changeModels(changes);
    if (!r.ok) setError(r.error);
  };

  const agent = place ? list.find((a) => a.id === place.engine) : undefined;
  const section = agent && place ? sectionsOf(agent).find((s) => s.provider.id === place.provider) : undefined;
  const searching = query.trim().length > 0;
  const found = searching ? list.flatMap((a) => a.models.filter((m) => matchesModel(query, a, m)).map((m) => ({ agent: a, model: m }))) : [];

  const row = (a: KbAgent, m: KbAgentModel, withPlace: boolean) => (
    <li key={`${a.id}:${m.id}`} className="kb-editmodels__model" data-model={m.id}>
      <label className="kb-editmodels__check">
        <input type="checkbox" checked={m.visible} onChange={(e) => void change([{ kind: 'model', engine: a.id, model: m.id, value: e.target.checked }])} />
        <span className="kb-editmodels__name">{m.name || m.label}</span>
        {m.tag && <span className="kb-agentmenu__tag">{m.tag}</span>}
        {withPlace && <span className="kb-muted kb-editmodels__where">{a.name}{ownProvider(a) ? '' : ` · ${m.provider_label}`}</span>}
      </label>
      <span className="kb-muted kb-editmodels__id" title={m.id}>{m.id}</span>
      <button type="button" className={`kb-agentmenu__star kb-editmodels__star${m.favorite ? ' is-on' : ''}`} aria-pressed={m.favorite}
        aria-label={`${m.favorite ? 'Remove from favorites' : 'Add to favorites'}: ${modelName(m)}`}
        onClick={() => void change([{ kind: 'favorite', engine: a.id, model: m.id, value: !m.favorite }])}>
        <Icon name="star" size={14} />
      </button>
    </li>
  );

  return (
    <Modal open={open} onClose={close} title="Edit models" className="kb-editmodels" testId="edit-models" initialFocusRef={search}>
      <div className="kb-modal__body kb-editmodels__frame">
      <p className="kb-muted kb-editmodels__intro">
        What the model picker shows. Search there still finds hidden models, and a chat on a hidden model keeps working.
      </p>
      <div className="kb-settings__search kb-editmodels__search">
        <Icon name="search" size={14} />
        <label className="kb-visually-hidden" htmlFor={`${id}-q`}>Find a model</label>
        <input id={`${id}-q`} ref={search} type="search" placeholder="Find a model" value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); } }} />
      </div>
      <div className="kb-editmodels__body">
        <nav className="kb-editmodels__side" aria-label="Agents and providers">
          {list.map((a) => {
            const isDefault = agents?.default === a.id;
            return (
              <section key={a.id} className="kb-editmodels__agent" aria-label={a.name}>
                <div className="kb-editmodels__agenthead">
                  <EngineBadge engine={a.id} />
                  <b className="kb-editmodels__agentname">{a.name}</b>
                  <Switch label={`Show ${a.name} in the picker`} checked={a.visible || isDefault} disabled={isDefault}
                    onChange={(on) => void change([{ kind: 'agent', engine: a.id, value: on }])} />
                </div>
                {isDefault && <p className="kb-muted kb-editmodels__note">Default agent: always shown.</p>}
                {a.models.length === 0 && <p className="kb-muted kb-editmodels__note">{a.state === 'ready' ? `Models are chosen in ${a.name.replace(' Agent', '')}.` : 'No models until it is ready.'}</p>}
                <ul>
                  {sectionsOf(a).map((s) => {
                    const current = !searching && place?.engine === a.id && place.provider === s.provider.id;
                    return (
                      <li key={s.provider.id} className={`kb-editmodels__provider${current ? ' is-current' : ''}`}>
                        <button type="button" className="kb-row" aria-current={current ? 'true' : undefined}
                          onClick={() => { setQuery(''); setPlace({ engine: a.id, provider: s.provider.id }); }}>
                          {ownProvider(a) ? <Icon name="models" size={14} /> : <ProviderIcon provider={s.provider.id} name={s.provider.label} size={16} />}
                          <span className="kb-row__text">{ownProvider(a) ? 'Models' : s.provider.label}</span>
                          <span className="kb-muted kb-editmodels__count">{s.models.filter((m) => m.visible).length}/{s.models.length}</span>
                        </button>
                        {!ownProvider(a) && (
                          <Switch label={`Show ${s.provider.label} in the picker`} checked={s.provider.visible}
                            onChange={(on) => void change([{ kind: 'provider', engine: a.id, provider: s.provider.id, value: on }])} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </nav>
        <div className="kb-editmodels__main">
          {searching ? (
            <>
              <h4 className="kb-sgroup__title">Search</h4>
              {found.length === 0 ? <p className="kb-muted">No model matches “{query.trim()}”.</p>
                : <ul className="kb-editmodels__models">{found.map(({ agent: a, model }) => row(a, model, true))}</ul>}
            </>
          ) : agent && section ? (
            <>
              <div className="kb-editmodels__mainhead">
                <span className="kb-editmodels__heading">
                  {ownProvider(agent) ? <EngineBadge engine={agent.id} /> : <ProviderIcon provider={section.provider.id} name={section.provider.label} size={18} />}
                  {/* U1: a long agent/provider name is cut, never pushed under the actions. */}
                  <h4 className="kb-sgroup__title kb-editmodels__title"
                    title={ownProvider(agent) ? agent.name : `${agent.name} · ${section.provider.label}`}>
                    {ownProvider(agent) ? agent.name : `${agent.name} · ${section.provider.label}`}
                  </h4>
                </span>
                <span className="kb-editmodels__actions">
                  <Button size="sm" variant="quiet" onClick={() => void change([{ kind: 'defaults', engine: agent.id, provider: section.provider.id }])}>Show defaults</Button>
                  <Button size="sm" variant="quiet" onClick={() => void change([{ kind: 'hide_all', engine: agent.id, provider: section.provider.id }])}>Hide all</Button>
                </span>
              </div>
              <p className="kb-muted kb-editmodels__note">
                By default the first 50 of a provider are shown. New models follow that rule; your choices stay.
              </p>
              <ul className="kb-editmodels__models">{section.models.map((m) => row(agent, m, false))}</ul>
            </>
          ) : (
            <p className="kb-muted">No agent has models to choose from yet. Connect one in Accounts & keys.</p>
          )}
          {error && <p className="kb-inline-error kb-inline-error--flat" role="alert">{error}</p>}
        </div>
      </div>
      </div>
    </Modal>
  );
}
