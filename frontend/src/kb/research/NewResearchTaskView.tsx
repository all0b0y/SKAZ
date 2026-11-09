import { useRef, type KeyboardEvent } from 'react';
import { Button } from '../ui';
import { useServices } from '../state/context';
import { getResearchStore, useResearch, type ResearchStarterKey } from './store';

export interface StarterOption {
  key: ResearchStarterKey;
  label: string;
  prompt: string;
}

export const RESEARCH_STARTERS: readonly StarterOption[] = [
  { key: 'new_for_wiki', label: 'Something new for my wiki', prompt: 'Find something new for my wiki.' },
  { key: 'materials_about', label: 'Materials about …', prompt: 'Find materials about ' },
  { key: 'recent_research', label: 'Recent research on …', prompt: 'Find recent research on ' },
];

export interface NewResearchTaskViewProps {
  onStarted?: (taskId: string) => void;
}

/**
 * Mockup v4 state `02 · New research task`: template with editable prompt, candidate budget note,
 * "Start research" primary action, and 3 starter buttons.
 */
export function NewResearchTaskView({ onStarted }: NewResearchTaskViewProps = {}) {
  const { client } = useServices();
  const store = getResearchStore(client);
  const draftPrompt = useResearch((s) => s.draftPrompt);
  const busy = useResearch((s) => s.busy);
  const error = useResearch((s) => s.error);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleStart = async () => {
    if (!draftPrompt.trim() || busy) return;
    const created = await store.getState().startTask();
    if (created) {
      onStarted?.(created.id);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void handleStart();
    }
  };

  const handlePickStarter = (starter: StarterOption) => {
    store.getState().setDraft(starter.prompt, starter.key);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      const len = starter.prompt.length;
      el.setSelectionRange(len, len);
    }
  };

  return (
    <>
      <header className="kb-head kb-head--chat">
        <h1 className="kb-head__title">New research task</h1>
        <div className="kb-head__spacer" />
      </header>
      <div className="kb-research-scroll">
        <div className="kb-research-content kb-research-content--new">
          <div className="kb-research-eyebrow">Research</div>
          <h2 className="kb-research-title">What would you like to explore?</h2>
          <p className="kb-research-desc">Find useful additions to your wiki, or investigate a topic.</p>
          <div className="kb-research-composer">
            <textarea
              ref={textareaRef}
              className="kb-research-composer__input"
              aria-label="Describe what you want to find or learn"
              placeholder="Describe what you want to find or learn"
              value={draftPrompt}
              onChange={(e) => store.getState().setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <div className="kb-research-composer__actions">
              <span className="kb-research-composer__meta">
                Up to 30 candidates checked against your wiki
              </span>
              <Button
                variant="fill"
                disabled={!draftPrompt.trim() || busy}
                busy={busy}
                onClick={() => void handleStart()}
              >
                Start research
              </Button>
            </div>
          </div>
          {error && (
            <p role="alert" className="kb-inline-error">
              {error}
            </p>
          )}
          <div className="kb-research-starters" role="group" aria-label="Starter prompts">
            {RESEARCH_STARTERS.map((starter) => (
              <button
                key={starter.key}
                type="button"
                className="kb-research-starter"
                data-starter={starter.prompt}
                onClick={() => handlePickStarter(starter)}
              >
                {starter.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
