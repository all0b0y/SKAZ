// IPC channel names shared between main and preload. Kept minimal on purpose:
// the renderer can only invoke these narrow request-scoped channels plus the
// backend-status event.

export const CHANNELS = {
  nativeOpen: 'backend:native-open',
  nativeAudio: 'backend:native-audio',
  nativeEnd: 'backend:native-end',
  nativeFailure: 'backend:native-failure',
  request: 'backend:request',
  status: 'backend:status',
  restartBackend: 'backend:restart',
  statusEvent: 'backend:status-event',
  openLogsFolder: 'app:open-logs-folder',
  openSystemAudioSettings: 'app:open-system-audio-settings',
  chooseStorageRoot: 'app:choose-storage-root',
  chooseAudioFile: 'app:choose-audio-file',
  captureState: 'app:capture-state',
  prepareQuit: 'app:prepare-quit',
  quitPrepared: 'app:quit-prepared',
  // Knowledge interface bridge (API-B2 §5).
  dictate: 'kb:dictate',
  saveTextFile: 'app:save-text-file',
  chooseMaterialFiles: 'app:choose-material-files',
} as const;
