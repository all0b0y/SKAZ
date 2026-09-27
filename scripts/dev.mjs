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

const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => !['--profile=dev', '--profile=test'].includes(arg))) {
  throw new Error('Usage: npm run dev -- [--profile=dev|--profile=test]');
}
const profile = args[0]?.split('=')[1] ?? process.env.SKAZ_PROFILE ?? 'dev';
if (!['dev', 'test'].includes(profile)) throw new Error('SKAZ_PROFILE must be dev or test.');

const child = spawn(electronVite, ['dev'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, SKAZ_PROFILE: profile },
});

const forward = (signal) => () => {
  if (!child.killed) child.kill(signal);
};
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));

child.on('exit', (code) => process.exit(code ?? 0));
