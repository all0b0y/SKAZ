# Frontend / Desktop report

Scope owned: `frontend/`, `electron/`, `package.json`, `package-lock.json`,
`tsconfig*.json`, `electron.vite.config.ts`, `vitest.config.ts`,
`playwright.config.ts`, `frontend/index.html`, `scripts/dev.mjs`,
`scripts/smoke.spec.ts`, this report. Parent-owned `backend/` and
`scripts/*.py` were not modified.

## What ships

A working Electron + React/TypeScript desktop app built against the fixed
`docs/API.md` contract. It is not a placeholder: it launches, spawns and
health-checks the real Python backend, and talks to it over a secure bridge.

### Desktop shell (`electron/`)
- `main.ts` — secure `BrowserWindow` (`contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`), CSP set both
  in `index.html` and via `onHeadersReceived`, external-navigation/new-window
  blocked, microphone-only permission handler, backend teardown on quit.
- `backend.ts` — picks a free loopback port, mints a per-run 256-bit bearer
  token, spawns `backend/.venv/bin/python -m audiohelper --port N` (falls back to
  `uv run --project backend …`), passes `AUDIOHELPER_TOKEN` /
  `AUDIOHELPER_DATA_DIR`, polls `GET /health` until `{status:"ok"}`, and only then
  reports `ready`. No fake readiness. SIGTERM→SIGKILL teardown with grace.
- `preload.ts` — the entire renderer-facing surface: `request`, `uploadAudio`,
  `fetchAudio`, `getBackendStatus`, `onBackendStatus`, `platform`. The token and
  port live only in main; the renderer can reach nothing but the loopback
  backend.
- `ipc.ts` — proxies each call with the auth header attached in main; method
  allowlist and `/`-path validation.

### Audio capture (`frontend/src/audio/`)
- `pcm-worklet.js` (served from `public/`, loads under `script-src 'self'`) →
  `recorder.ts`: AudioWorklet capture, RMS level, device picker + disconnect
  handling, standalone **5s PCM16 mono WAV** windows at device sample rate.
- `chunker.ts` — accumulates worklet frames into exact windows and flushes the
  sub-window tail on pause/stop; proven to never lose or reorder samples.
- `clock.ts` — recording timeline that **excludes paused wall time**.
- `wav.ts` — clamped PCM16 mono WAV encoder.
- `uploadQueue.ts` — sequential, ordered, bounded queue: retries in place with
  backoff (order preserved), retains exhausted chunks in `failed` (never silently
  dropped, user-retryable), rejects past the bound with a visible
  `overflow`/`droppedCount`, and `drain()` for stop/pause tail flush.

### UI (`frontend/src/components/`, `state/store.ts`)
Pinned Hermes/pi composition: **sessions left, transcript with times center,
assistant right, notes tab**, quiet warm-editorial theme that **follows the OS**
(manual light/dark override available). Real states everywhere (empty / loading /
error / live). Recorder controls + level + elapsed + pending/backlog/failed
surfacing. Transcript with timecodes and citation flash-to-jump. Assistant with
scope (auto/recent/beginning/search/all) and 2/5/10-minute window, citations that
jump the transcript. Notes generated after recording with sources. Settings drawer
with three independent profiles (ASR/agent/notes), dynamic model catalog + custom
model ID, unverified-ASR honesty flag, write-only API keys, languages, and
explicit cloud consent.

## Verification (actual runs)

| Check | Command | Result |
|---|---|---|
| Typecheck (frontend + electron) | `npm run typecheck` | pass (exit 0) |
| Unit/component tests | `npx vitest run` | **55 passed**, 8 files |
| Production build | `npm run build` | pass — main.js, preload.js (CJS), renderer + `pcm-worklet.js` emitted |
| Desktop smoke (Playwright + Electron, fake device) | `npx playwright test` | **3 passed** |
| Live integration vs real backend | manual Electron launch | **"Backend ready"**, real `GET /settings` round-trip returned real data, no keys leaked |

Test breakdown: `wav` (9), `uploadQueue` (11), `clock` (7), `chunker` (6),
`time` (5), `api/client` (7), `AssistantPanel` (5), `RecorderBar` (5).

The integration check spawned the parent's real backend through `main.ts`, reached
`ready` via a genuine `/health` poll, and fetched settings
(`asr: local-whisper/small`, `agent: openrouter` empty, `has_api_key:false`) — the
docs/API.md defaults, proving the full renderer→preload→IPC→backend path with no
mock. Deterministic tests use fake gateways only; the shipped app has no mocks.

## Honest limitations / not yet verified by me
- **Live human-speech acceptance** (WER/CER on RU/EN/mixed, latency, cost) still
  requires a real person granting OS mic permission — the fake-device smoke and
  file fixtures do not substitute for it (per docs/QUALITY.md).
- **Local Whisper weights** download on first real local run (backend reports
  this honestly via `verification_note`); I did not trigger a weight download.
- Cloud ASR/LLM answers depend on a configured provider + key + cloud consent;
  with none configured the app shows configure-provider states rather than fake
  answers.
- No secrets were read; `.env` was never opened. Nothing was committed.

## Run it
- Dev (renderer + shell + backend): `npm run dev`
- Build: `npm run build`  · Smoke: `npm run smoke`  · Tests: `npm test`
