#!/usr/bin/env node
// Starts the whole app for development: electron-vite runs the Vite renderer
// dev server, builds main/preload, and launches Electron. The Electron main
// process then spawns and health-checks the managed Python backend, so a single
// `npm run dev` brings up renderer + desktop shell + backend together.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite';
const electronVite = path.join(root, 'node_modules', '.bin', bin);

const child = spawn(electronVite, ['dev'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

const forward = (signal) => () => {
  if (!child.killed) child.kill(signal);
};
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));

child.on('exit', (code) => process.exit(code ?? 0));
