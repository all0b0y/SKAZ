// IPC channel names shared between main and preload. Kept minimal on purpose:
// the renderer can only invoke these narrow request-scoped channels plus the
// backend-status event.

export const CHANNELS = {
  nativeOpen: 'backend:native-open',
  nativeAudio: 'backend:native-audio',
  nativeEnd: 'backend:native-end',
  nativeFailure: 'backend:native-failure',
  request: 'backend:request',
  uploadAudio: 'backend:uploadAudio',
  storeAudio: 'backend:storeAudio',
  fetchAudio: 'backend:fetchAudio',
  status: 'backend:status',
  statusEvent: 'backend:status-event',
  captureState: 'app:capture-state',
  prepareQuit: 'app:prepare-quit',
  quitPrepared: 'app:quit-prepared',
  cancelQuit: 'app:cancel-quit',
} as const;
