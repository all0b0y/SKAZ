import { create } from 'zustand';

/**
 * The one critical problem with the transcript on screen, if any
 * (.dev/docs/UI-CLEANUP-IMPORT-TRANSCRIPT-SPEC.md §1): recognition failed, or the
 * transcript could not be loaded. The transcript view reports it; the recorder
 * capsule shows it as one line with its action, instead of a strip across the
 * top of the text.
 */
export interface TranscriptIssue {
  sessionId: string;
  message: string;
  action: { label: string; run: () => void } | null;
}

interface TranscriptIssueState {
  issue: TranscriptIssue | null;
  report: (issue: TranscriptIssue | null) => void;
}

export const useTranscriptIssue = create<TranscriptIssueState>((set) => ({
  issue: null,
  report: (issue) => set((now) => (sameIssue(now.issue, issue) ? now : { issue })),
}));

function sameIssue(a: TranscriptIssue | null, b: TranscriptIssue | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.sessionId === b.sessionId && a.message === b.message && a.action?.label === b.action?.label;
}
