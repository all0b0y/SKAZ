# Frontend / Desktop fix report (Opus 4.8 worker)

Scope owned and touched: `frontend/`, `electron/`, `scripts/dev.mjs`,
`scripts/smoke.spec.ts`, and this report. Parent-owned `backend/` and
`scripts/*.py` were not modified. No commit, no push. `.env` never opened.

Model actually running: `claude-opus-4-8` (assigned; not delegated or swapped).

## Review round 3 — quit-reentry race + rejected-shutdown handling

Coordinator confirmed round 2 (98 tests / typecheck / build / 3 smoke) and
flagged one remaining data-loss race in `QuitController`.

- **Bug:** `onBeforeQuit` returned `false` (allow quit) the moment a shutdown
  *started* (`shuttingDown = true`), but that flag was set before `stopBackend()`
  resolved. A repeated Cmd+Q during the drain therefore let the app quit
  **prematurely**, before the backend actually stopped/flushed. Separately, a
  rejected `stopBackend` left an unhandled rejection and a stuck state where
  `quit()` never fired.
- **Fix:** replaced the single `shuttingDown` boolean with an explicit
  `idle → draining → settled` phase machine. During `draining`, `onBeforeQuit`
  returns `true` (keeps blocking) so quit reentry cannot slip through until the
  shutdown has actually **settled**; only then does `onBeforeQuit` return `false`
  and let the real quit proceed. `beginShutdown` starts the drain synchronously
  (so the stop truly begins now), converts a synchronous throw into a rejection,
  and chains a rejection handler that reports via `onShutdownError` and still
  quits — no unhandled rejection, never stuck. Cancellation still preserves the
  backend (no `stopBackend`, no `quit`). `main.ts` passes an `onShutdownError`
  that logs the failure.
- **Tests** (`quitController.test.ts`, now 9): a new regression asserts three
  repeated `onBeforeQuit()` calls all return `true` and `quit` is **not** called
  while the stop promise is pending, then `quit` fires exactly once after
  `resolveStop()`, and a post-settle `onBeforeQuit()` returns `false`; another
  asserts a rejected `stopBackend` yields no escaping rejection
  (`settled()` resolves), calls `onShutdownError` once, still quits once, and is
  not stuck. `stopBackend` is invoked synchronously so the strict
  `confirm → stop → quit` ordering assertion still holds.

### Round 3 verification (actual runs)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit/component | `npx vitest run` | **99 passed**, 14 files, **0 act warnings** |
| Build | `npm run build` | exit 0 |
| Desktop smoke | `npx playwright test` | **3 passed** |
| Live renderer IPC under strict guards | launched packaged app, real backend | pill `"Backend ready"`; `getBackendStatus` → `ready`; `GET /settings` → `ok:true`; `reportCaptureState` did not throw |

### Round 3 honest limits
- The premature-quit and rejected-shutdown paths are verified by deterministic
  unit tests exercising the real event orchestration (blocked reentry, settle
  ordering, rejection handling) — not by driving an actual Cmd+Q against a live
  recording, which needs a human at the keyboard with an open session.
- No real-hardware microphone acceptance was performed; the smoke uses a fake
  device (`--use-fake-ui-for-media-stream`), which auto-grants and bypasses the
  strict audio-only permission grant path. That path is covered by unit tests +
  code review + the live boot/IPC check, not a physical mic grant.
- No backend changes, no secrets/`.env`/private-audio access, no automatic
  physical-mic recording, no model change, no commit or push.

## Review round 2 — data-loss lifecycle / security hardening

The coordinator rejected round 1 for remaining data-loss lifecycle/security
gaps. All four findings are now fixed with RED→GREEN tests that exercise real
event orchestration (not just predicates), and wired into `main.ts`/`ipc.ts`.

### 1. Cmd+Q cancellation / backend-shutdown race → `electron/quitController.ts`
- **Bug:** `before-quit` ran `manager.stop()` *before* the close-confirmation
  dialog, so cancelling Cmd+Q left the recording UI alive talking to a dead
  backend; close and before-quit also had two independent dialog paths.
- **Fix:** a single pure `QuitController` is the sole authority for both
  `window.on('close')` and `app.on('before-quit')`. Authorization (the warning
  dialog) always runs **before** any shutdown; a cancel preserves the running
  backend (no `stopBackend`, no `quit`); re-entrant events during an in-flight
  shutdown neither open a second dialog nor start a second shutdown. The old
  `shuttingDown`/`allowUnsafeClose`/inline-dialog code is gone.
- **Tests** (`quitController.test.ts`, 8): assert the exact call order
  `confirm → stopBackend → quit` on confirm; assert `stopBackend`/`quit` are
  **not** called on cancel and the next quit re-prompts; assert single shutdown
  + single dialog under re-entrancy; window-close cancel preserves the backend.

### 2. Permission trust → `electron/permissionPolicy.ts`
- **Bug:** `isTrustedRendererUrl` trusted a *missing* URL, *any* `file://`, and
  dev-prefix lookalikes (`startsWith`), and the check handler ignored frame/subtype.
- **Fix:** strict, parsed equality. `isTrustedMediaRequest` (authoritative grant)
  requires the sender to be the main window's webContents **and** main frame, an
  exact parsed URL match, and audio-only media (unknown/empty media types denied
  by default). `isTrustedMediaCheck` (sync pre-check) requires trusted wc + main
  frame + exact origin, denies explicit `video`/`unknown` subtypes, and allows an
  absent subtype so the real mic still works. Both handlers now compare the
  requesting webContents to `mainWindow.webContents`.
- **Tests** (`permissionPolicy.test.ts`, 12): cover lookalike hosts, foreign
  origins, missing URL, video/unknown/empty media types, subframes, and the
  mic-preserving absent-subtype pre-check.

### 3. captureState IPC + all IPC handlers → `electron/ipcSender.ts`
- **Bug:** the `app:capture-state` listener trusted any sender and any payload;
  the four proxy handlers did no sender check at all.
- **Fix:** `isTrustedFrame` (main frame of the expected main window) now guards
  **every** `ipcMain` handler (`status`, `request`, `uploadAudio`, `fetchAudio`,
  and `capture-state`); untrusted senders get a rejected response and never reach
  the backend. `validateCaptureState` shape- and bound-checks the payload
  (known recorder-state enum, integer counts in `[0, 1e6]`) and drops unknown
  fields before it can influence the close/quit guard.
- **Tests** (`ipcSender.test.ts`, 9): id/main-frame/null-window matrix for
  `isTrustedFrame`; malformed/out-of-bound/extra-field rejection for
  `validateCaptureState`.

### 4. React `act(...)` warnings in RecorderBar tests
- **Bug:** the mount `enumerateDevices()` effect and a mid-test `setState` into a
  mounted component fired React updates outside `act()`.
- **Fix:** stub `enumerateDevices` in `beforeEach` (isolates an unrelated async
  side effect) and wrap the post-render `useStore.setState` in `act()`. No
  assertion was weakened. The full suite now emits **0** act warnings.

### Round 2 verification (actual runs)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit/component | `npx vitest run` | **98 passed**, 14 files, **0 act warnings** |
| Build | `npm run build` | exit 0 |
| Desktop smoke | `npx playwright test` | **3 passed** |
| Live renderer IPC under new guards | launched packaged app, real backend | pill `"Backend ready"`; `getBackendStatus` → `{phase:"ready"}`; `GET /settings` → `ok:true` |

The live check proves the stricter sender/frame trust does **not** break the
legitimate renderer: the main window's main frame passes `isTrustedFrame`, the
real managed backend reached `ready`, and a settings round-trip succeeded. New
security tests went from RED (modules absent) to GREEN after implementation.

### Round 2 honest limits
- No real-hardware microphone test was performed; the smoke uses a fake device
  with `--use-fake-ui-for-media-stream`, so the audio-only permission *grant* path
  and the capture-state close dialog were verified by unit tests + code review and
  the live IPC/boot check, not by a human granting OS mic permission.
- The `confirmDiscard` dialog and `showMessageBoxSync` blocking behavior are not
  exercised in automation (capture is idle in the smoke, so no dialog fires).
- `event.senderFrame?.parent === null` is the main-frame signal; if a future
  Electron disposes `senderFrame` mid-call it is treated as untrusted (fail-safe).
- No backend changes, no secrets/`.env`/private-audio access, no model change, no
  commit or push.

## Starting state (restored session, prior workers stopped at usage limit)

Re-read the actual files and ran a baseline instead of trusting historical
counts. Baseline (before my changes):

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **FAIL** — 5 errors |
| Unit/component | `npx vitest run` | 64 passed, **1 failed**, 3 test files erroring |

The prior worker had committed failing RED specs whose implementation was
missing, plus a self-contradictory assertion:

1. `frontend/src/security/ipcPolicy.test.ts` imported `../../../electron/ipcPolicy` — **module did not exist** (transform error, typecheck error).
2. `frontend/src/security/captureProtection.test.ts` imported `../../../electron/captureProtection` — **module did not exist**.
3. `frontend/src/state/store.lifecycle.test.ts` — 3 TS errors: the `bridge`
   cast kept `BridgeApi`'s generic `request` signature in an intersection, so the
   `vi.fn` mock was unassignable.
4. `frontend/src/audio/uploadQueue.test.ts:150` — assertion `uploaded[0]` equal to
   the protected overflow chunk. The same suite enforces strict enqueue-order
   delivery (`seen=[0,1,2]`), so `uploaded` is `[c0,c1,c2]` and `uploaded[0]` is
   always `c0`, never the protected `c2`. No ordering-preserving implementation
   can satisfy it — a broken assertion, not an implementation bug.

Most lifecycle/security requirements from the brief were **already implemented**
by prior workers and verified still-passing (I preserved them): distinct session
on record-over-stopped (`store.ts` `startRecording`), cloud-consent gate,
processing-state guards blocking duplicate start/new/select, async ask/notes
session-isolation guards, `SampleTimeline` sample-count audio clock (drift fix),
worklet barrier/ack on pause/stop with tail flush, device-disconnect stop+flush,
bounded upload queue that retains overflow chunks and pauses capture.

## Changes made

### New pure module `electron/ipcPolicy.ts` (+ wired into `electron/ipc.ts`, `electron/main.ts`)
- `isAllowedExternalUrl` — only `http:`/`https:`; rejects `file:`, `javascript:`,
  custom schemes. Wired into `main.ts` `setWindowOpenHandler` (previously handed
  **any** url to `shell.openExternal`).
- `validateBridgeRequest` — method+path allowlist mirroring `docs/API.md`, rejects
  absolute URLs and raw/`%2e`-encoded traversal in the `path` field, bounds JSON
  body size. Wired as a guard in the `ipc.ts` request handler.
- `validateAudioUpload` — session-id (no `/`, `\`, `..`), sequence ≥ 0, ordered
  non-negative times, ≤ 30s window, bounded WAV bytes. Wired into the upload handler.

### New pure module `electron/captureProtection.ts` (+ close guard in `main.ts`)
- `hasUnsentAudio(state)` — true when recording/processing, or chunks are pending
  or failed (retained for retry).
- Renderer now reports live capture state to main (new `app:capture-state` IPC,
  optional `reportCaptureState` on the bridge, one-way `ipcRenderer.send`, pushed
  from a deduped `store.subscribe`). `main.ts` `window.on('close')` consults
  `hasUnsentAudio` and shows a blocking warning dialog ("Keep recording" /
  "Discard and quit") before the renderer and its unsent PCM are destroyed. No
  silent mic continuation, no silent loss.

### Media permission tightened (`main.ts`)
- `setPermissionRequestHandler` now grants `media` only for **audio-only**
  requests (`mediaTypes` excludes `video`) from the **trusted renderer** URL;
  everything else denied. The synchronous check handler stays `media`-only on
  purpose — it only sees an origin (no media subtype), and matching a dev URL
  with a path against an origin would wrongly deny the real mic.

### Test corrections (files I own)
- `uploadQueue.test.ts:150` → `expect(uploaded).toContainEqual(protectedChunk)`
  with a comment: the protected chunk survives with exact bytes+metadata and is
  delivered on retry after the in-order backlog, which is the real intent of
  "protects the exact overflow chunk for retry" and is consistent with the
  ordering guarantee the rest of the suite enforces.
- `store.lifecycle.test.ts` bridge cast → `Omit<BridgeApi,'request'> & { request: Mock }`
  so the mock is assignable without dropping type safety elsewhere.

## Verification (actual runs, this session)

| Check | Command | Result |
|---|---|---|
| Typecheck (frontend + electron) | `npm run typecheck` | **pass** (exit 0) |
| Unit/component tests | `npx vitest run` | **69 passed**, 11 files, 0 failed |
| Production build | `npm run build` | **pass** — `dist/main/main.js` (17.25 kB), `dist/preload/preload.js`, renderer + `pcm-worklet.js` |
| Desktop smoke (Playwright + Electron, fake device) | `npx playwright test` | **3 passed** |

New/affected test files now green: `security/ipcPolicy.test.ts` (3),
`security/captureProtection.test.ts` (1), `audio/uploadQueue.test.ts` (12),
`state/store.lifecycle.test.ts` (6). Smoke still confirms the shell renders, the
preload bridge exposes only its methods with **no token leak** (the new
`reportCaptureState` method is a function and does not leak the token/port), and
the backend lifecycle surfaces honestly (ready or truthful error).

Deterministic tests mock only the external bridge/gateway; the shipped app has no
mocks. No live backend/microphone auto-run was performed (see below).

## Honest limitations / not verified by me
- **Live human-speech acceptance** (WER/CER on RU/EN/mixed, latency, cost) still
  needs a real person granting OS mic permission on hardware — the fake-device
  smoke does not substitute for it (per `docs/QUALITY.md`). The user's reported
  "imperfect transcription" is ASR quality, owned by the backend worker (dedicated
  OpenRouter ASR catalog / `output_modalities=transcription`), not a frontend bug.
- The private `test_audio/` lecture was **not** read or sent anywhere; coordinator
  handles it. Existing user recordings were not touched or deleted.
- **Close/quit guard**: the window-close button path is fully guarded by the
  warning dialog. On macOS `Cmd+Q`, `before-quit` begins backend shutdown before
  the window `close` guard fires, so the two race; the warning still appears, but
  a full flush-handshake on `Cmd+Q` is not implemented. Not exercised on hardware.
- The audio-only/trusted permission tightening could not be exercised against a
  real getUserMedia prompt here (the smoke uses `--use-fake-ui-for-media-stream`,
  which auto-grants); verified only by typecheck/build/smoke and code review.

## Run it
- Dev: `npm run dev` · Build: `npm run build` · Smoke: `npm run smoke` · Tests: `npm test`
