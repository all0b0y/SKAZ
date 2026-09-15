const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('playbackSmoke', {
  getManifest: () => ipcRenderer.invoke('playback-smoke:manifest'),
  fetchAudio: async (sequence) => {
    const bytes = await ipcRenderer.invoke('playback-smoke:audio', sequence);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
});
