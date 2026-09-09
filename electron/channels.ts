// IPC channel names shared between main and preload. Kept minimal on purpose:
// the renderer can only invoke these four request-scoped channels plus the
// backend-status event.

export const CHANNELS = {
  request: 'backend:request',
  uploadAudio: 'backend:uploadAudio',
  fetchAudio: 'backend:fetchAudio',
  status: 'backend:status',
  statusEvent: 'backend:status-event',
  captureState: 'app:capture-state',
} as const;
