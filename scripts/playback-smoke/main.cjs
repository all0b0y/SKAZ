const { app, BrowserWindow, ipcMain } = require('electron');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const dataDir = process.env.AUDIOHELPER_PLAYBACK_SMOKE_DATA_DIR;
const rendererDir = process.env.AUDIOHELPER_PLAYBACK_SMOKE_RENDERER_DIR;
if (!dataDir || !rendererDir) throw new Error('playback smoke temp paths are required');
app.setPath('userData', path.join(dataDir, 'electron-user-data'));

let backend;
let backendUrl;
let token;
const sessionId = 'playback-smoke-session';

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});

const request = async (route, options = {}) => {
  const response = await fetch(`${backendUrl}${route}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}: ${await response.text()}`);
  return response;
};

const makeWav = (frequency, seconds = 0.4, sampleRate = 16_000) => {
  const samples = Math.round(seconds * sampleRate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 3_000);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  return buffer;
};

async function startBackend() {
  const port = await freePort();
  token = randomBytes(32).toString('hex');
  backendUrl = `http://127.0.0.1:${port}`;
  const python = path.join(root, 'backend', '.venv', 'bin', 'python');
  if (!fs.existsSync(python)) throw new Error(`backend virtualenv python is missing: ${python}`);
  backend = spawn(python, ['-m', 'audiohelper', '--port', String(port), '--log-level', 'warning'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      AUDIOHELPER_TOKEN: token,
      AUDIOHELPER_DATA_DIR: path.join(dataDir, 'backend-data'),
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stderr.on('data', (chunk) => process.stderr.write(`[playback-smoke-backend] ${chunk}`));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (backend.exitCode !== null) throw new Error(`backend exited with ${backend.exitCode}`);
    try {
      const response = await request('/health');
      if ((await response.json()).status === 'ok') return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('playback smoke backend health timeout');
}

async function seedAudio() {
  await request('/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Synthetic playback smoke' }),
  }).then(async (response) => {
    const created = await response.json();
    if (created.id !== sessionId) {
      // Session IDs are backend-generated. Keep the actual ID local to main.
      sessionIdActual = created.id;
    }
  });
  for (const [index, sequence] of [10, 20, 30].entries()) {
    await request(`/sessions/${encodeURIComponent(sessionIdActual)}/audio/store?sequence=${sequence}&start_ms=${index * 400}&end_ms=${(index + 1) * 400}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: makeWav(440 + index * 110),
    });
  }
}

let sessionIdActual = sessionId;

app.whenReady().then(async () => {
  await startBackend();
  await seedAudio();
  ipcMain.handle('playback-smoke:manifest', async () =>
    request(`/sessions/${encodeURIComponent(sessionIdActual)}/audio`).then((response) => response.json()));
  ipcMain.handle('playback-smoke:audio', async (_event, sequence) => {
    const response = await request(`/sessions/${encodeURIComponent(sessionIdActual)}/audio/${encodeURIComponent(String(sequence))}`);
    return Buffer.from(await response.arrayBuffer());
  });
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(path.join(rendererDir, 'index.html'));
  window.show();
}).catch((error) => {
  console.error('[playback-smoke-main]', error);
  app.exit(1);
});

app.on('before-quit', () => {
  if (backend && backend.exitCode === null) backend.kill('SIGTERM');
});
