import { create } from 'zustand';

interface ProcessingState {
  sessions: Record<string, { processing: boolean; incomplete: boolean }>;
  pending: (sessionId: string) => void;
  started: (sessionId: string) => void;
  refresh: (sessionId: string) => Promise<void>;
}
interface Status { processing?: boolean; incomplete?: boolean; background_sessions?: string[] }

let requestSequence = 0;
const latestRequest = new Map<string, number>();

/** Session-scoped background work is independent of the single capture owner. */
export const useNativeProcessing = create<ProcessingState>((set) => ({
  sessions: {},
  pending: (sessionId) => {
    latestRequest.set(sessionId, ++requestSequence);
    set(s => ({ sessions: { ...s.sessions, [sessionId]: { processing: true, incomplete: false } } }));
  },
  started: (sessionId) => {
    latestRequest.set(sessionId, ++requestSequence);
    set(s => ({ sessions: { ...s.sessions, [sessionId]: { processing: false, incomplete: false } } }));
  },
  refresh: async (sessionId) => {
    const request = ++requestSequence;
    latestRequest.set(sessionId, request);
    const response = await window.skaz.request<Status>({ method: 'GET',
      path: `/sessions/${encodeURIComponent(sessionId)}/live/status` });
    if (latestRequest.get(sessionId) !== request) return; // a newer read or capture ACK won
    if (!response.ok) {
      if (response.status === 404) set(s => {
        const sessions = { ...s.sessions }; delete sessions[sessionId]; return { sessions };
      });
      else throw new Error('Could not verify background transcription status.');
      return;
    }
    set(s => {
      const sessions = { ...s.sessions, [sessionId]: {
        processing: response.data.processing === true, incomplete: response.data.incomplete === true,
      } };
      for (const id of response.data.background_sessions ?? []) {
        if (!sessions[id]) sessions[id] = { processing: true, incomplete: false };
      }
      return { sessions };
    });
  },
}));

export const hasBackgroundTranscription = () =>
  Object.values(useNativeProcessing.getState().sessions).some(s => s.processing);
