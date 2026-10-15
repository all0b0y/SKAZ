import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { KbAgent } from '../../api/kb/types.gen';
import type { EngineId } from '../api/names';
import { Icon } from '../ui';
import { Popover } from '../ui/Popover';
import { EngineBadge } from '../ui/EngineBadge';
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

/**
 * Agent + model in the message field (v21, decision 34): grouped by agent, only connected agents
 * can be chosen — the others say why. On an existing chat the new agent gets the conversation as
 * context. Nothing is swapped silently: a refusal is shown, the old choice stays.
 */
export function AgentPicker({ choice, onChoose, existingChat }: {
  choice: AgentChoice | null;
  onChoose: (choice: AgentChoice) => void;
  existingChat: boolean;
}) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const agents = useAgents((s) => s.agents);
  const { agents: agentsStore } = useServices();
  // Opening the menu checks the agents by themselves (throttled in the store).
  useEffect(() => { if (open) agentsStore.getState().autoCheck('open'); }, [open, agentsStore]);
  const openSettings = useUi((s) => s.openSettings);
  const current = choice ? agents?.agents.find((a) => a.id === choice.engine) : undefined;
  const modelLabel = choice?.model
    ? current?.models.find((m) => m.id === choice.model)?.label ?? choice.model
    : current?.id === 'hermes' ? 'As set in Hermes' : choice ? ENGINE_NAME[choice.engine] : 'No agent';

  const pick = (engine: EngineId, model: string | null) => {
    const agent = agents?.agents.find((a) => a.id === engine);
    const m = agent?.models.find((x) => x.id === model);
    const effort = engine === choice?.engine && m?.efforts.includes(choice.effort ?? '') ? choice.effort : m?.default_effort ?? null;
    setOpen(false);
    anchor.current?.focus({ preventScroll: true });
    onChoose({ engine, model, effort });
  };

  return (
    <>
      <button ref={anchor} type="button" className="kb-picker" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Agent and model: ${choice ? ENGINE_NAME[choice.engine] : 'none'}, ${modelLabel}`}
        onClick={() => setOpen((v) => !v)} data-testid="agent-picker">
        {choice && <EngineBadge engine={choice.engine} size={16} />}
        <span className="kb-picker__label">{modelLabel}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="top-end" label="Agent and model"
        role="menu" className="kb-menu kb-agentmenu" onKeyDown={moveFocus} width={300}>
        {!agents && <p className="kb-agentmenu__note">Agents couldn’t be read. Try again in a moment.</p>}
        {agents && ENGINE_ORDER.map((engine) => {
          const agent = agents.agents.find((a) => a.id === engine);
          if (!agent) return null;
          const ready = agent.state === 'ready';
          const note = STATE_LABEL[agent.state];
          return (
            <div key={engine} className="kb-agentmenu__group" role="group" aria-label={agent.name}>
              <div className="kb-agentmenu__head">
                <EngineBadge engine={engine} />
                <b>{agent.name}</b>
                {note && <span className="kb-agentmenu__state">{note}</span>}
              </div>
              {agent.models.length === 0 ? (
                <button type="button" role="menuitemradio" tabIndex={-1} className="kb-menu__item kb-agentmenu__item"
                  aria-checked={choice?.engine === engine} aria-disabled={!ready || undefined}
                  onClick={() => { if (ready) pick(engine, null); }}>
                  <span className="kb-menu__label">As set in {agent.name.replace(' Agent', '')}</span>
                  {choice?.engine === engine && <Icon name="check" size={14} />}
                </button>
              ) : agent.models.map((m) => {
                const checked = choice?.engine === engine && choice.model === m.id;
                return (
                  <button key={m.id} type="button" role="menuitemradio" tabIndex={-1} className="kb-menu__item kb-agentmenu__item"
                    aria-checked={checked} aria-disabled={!ready || undefined} onClick={() => { if (ready) pick(engine, m.id); }}>
                    <span className="kb-menu__label">{m.label}</span>
                    {checked && <Icon name="check" size={14} />}
                  </button>
                );
              })}
            </div>
          );
        })}
        <div className="kb-agentmenu__foot">
          {existingChat && <p className="kb-agentmenu__note">A new agent gets this whole chat as context.</p>}
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
