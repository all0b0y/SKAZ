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
  mediaAccess: 'app:media-access',
  chooseStorageRoot: 'app:choose-storage-root',
  chooseAudioFile: 'app:choose-audio-file',
  captureState: 'app:capture-state',
  prepareQuit: 'app:prepare-quit',
  quitPrepared: 'app:quit-prepared',
  // Knowledge interface bridge (API-B2 §5).
  dictate: 'kb:dictate',
  saveTextFile: 'app:save-text-file',
  share: 'app:share',
  chooseMaterialFiles: 'app:choose-material-files',
  chooseMaterialBatch: 'app:choose-material-batch',
  droppedMaterialFiles: 'app:dropped-material-files',
  validateClipboardImage: 'app:validate-clipboard-image',
  importMaterialSelection: 'app:import-material-selection',
  materialImagePreview: 'app:material-image-preview',
  // Library file actions (B20).
  chooseExportFolder: 'app:choose-export-folder',
  showInFinder: 'app:show-in-finder',
  openInObsidian: 'app:open-in-obsidian',
  // Updates (B20).
  updateGet: 'app:update-get',
  updateCheck: 'app:update-check',
  updatePrepare: 'app:update-prepare',
  updateCancel: 'app:update-cancel',
  updateInstall: 'app:update-install',
  updateState: 'app:update-state',
  // macOS full screen hides the traffic lights: the title bar drops the room it keeps for them.
  fullScreen: 'app:full-screen',
  // Settings → "Closing the window quits SKAZ" (decision 3f′).
  closeQuitsGet: 'app:close-quits-get',
  closeQuitsSet: 'app:close-quits-set',
  // EX3: Explore's paper reader, a sandboxed view of its own over the page's reader slot.
  paperShow: 'paper:show',
  paperBounds: 'paper:bounds',
  paperHide: 'paper:hide',
  paperNavigate: 'paper:navigate',
  paperState: 'paper:state',
} as const;
