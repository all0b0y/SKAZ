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
  bufferAudio: 'backend:bufferAudio',
  status: 'backend:status',
  statusEvent: 'backend:status-event',
  readLogs: 'app:read-logs',
  openLogsFolder: 'app:open-logs-folder',
  openSystemAudioSettings: 'app:open-system-audio-settings',
  chooseStorageRoot: 'app:choose-storage-root',
  chooseAudioFile: 'app:choose-audio-file',
  shareNote: 'app:share-note',
  captureState: 'app:capture-state',
  codexActivity: 'app:codex-activity',
  prepareQuit: 'app:prepare-quit',
  quitPrepared: 'app:quit-prepared',
  cancelQuit: 'app:cancel-quit',
} as const;
