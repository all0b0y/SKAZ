import { useEffect } from 'react';
import { useServices } from '../state/context';
import { NewResearchTaskView } from './NewResearchTaskView';
import { ResearchTaskView } from './ResearchTaskView';
import { getResearchStore, useResearch, type ResearchCenterMode } from './store';

export interface ResearchCenterViewProps {
  initialMode?: ResearchCenterMode;
  initialTaskId?: string | null;
  onOpenFindings?: (taskId: string) => void;
}

/**
 * Centre pane router for Research tasks: switches between `NewResearchTaskView` (state 02)
 * and `ResearchTaskView` (states 03–05).
 */
export function ResearchCenterView({
  initialMode,
  initialTaskId,
  onOpenFindings,
}: ResearchCenterViewProps = {}) {
  const { client } = useServices();
  const store = getResearchStore(client);
  const mode = useResearch((s) => s.mode);
  const activeTaskId = useResearch((s) => s.activeTaskId);

  useEffect(() => {
    if (initialMode === 'new') {
      store.getState().openNewTask();
    } else if (initialMode === 'task' && initialTaskId) {
      store.getState().openTask(initialTaskId);
    }
  }, [initialMode, initialTaskId, store]);

  const effectiveMode = mode === 'closed' && initialMode ? initialMode : mode;

  if (effectiveMode === 'new') {
    return <NewResearchTaskView />;
  }
  if (effectiveMode === 'task') {
    return <ResearchTaskView taskId={activeTaskId ?? initialTaskId} onOpenFindings={onOpenFindings} />;
  }
  return null;
}
