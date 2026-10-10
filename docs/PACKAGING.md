# Packaging: SKAZ.app and the DMG installer

How the repository turns into a double-clickable macOS installer, and what is
verified vs. still open. Written for a developer on this machine; the end user
only ever sees the `.dmg`.

## One command

```bash
npm run dist:mac
```

Result:

- `release/SKAZ-<version>-arm64.dmg` — the familiar installer window where the app
  is dragged onto `Applications`.
- `release/SKAZ-<version>-arm64.pkg` — a classic macOS Installer package that
  installs `SKAZ.app` into `/Applications`. It is unsigned (no Developer ID
  Installer certificate here), so Gatekeeper warns on other Macs.

`dist:mac` chains five steps, each runnable on its own:

| Step | Command | Produces |
|---|---|---|
| 1. Icon | `npm run icon` | `build/icon.icon`, `build/icon.icns`, `icon/icon.png` |
| 2. Media tools | `npm run build:media` | `backend/.runtime/media-tools/` |
| 3. Backend | `npm run build:backend` | `backend/dist/skaz-backend/` |
| 4. Renderer/main/preload | `npm run build` | `dist/` |
| 5. Bundle + DMG + PKG | `electron-builder --mac --config electron-builder.yml` | `release/*.dmg`, `release/*.pkg` |

Prerequisites: `npm install`, a populated `backend/.venv` with the Local Whisper
runtime (`uv sync --project backend --extra local-asr`) and `pyinstaller` installed
into it (`uv pip install --python backend/.venv/bin/python pyinstaller`), and
Xcode 26 or newer for the icon step (Icon Composer's `ictool`, and `actool`, which
electron-builder runs to compile the icon).

## Why the backend is frozen

An installed `.app` has no repository and no `uv`. `BackendManager.resolveSpawn`
(electron/backend.ts) therefore has two paths:

- **Packaged** — runs `Contents/Resources/backend/skaz-backend`, a PyInstaller
  bundle built from `backend/skaz-backend.spec`.
- **Unpackaged** — unchanged: `backend/.venv/bin/python -m skaz`, or
  `uv run --project backend` as a fallback.

`backend/scripts/frozen_entry.py` exists because PyInstaller executes the analysed
script as `__main__`, which breaks the relative imports inside
`skaz/__main__.py`. The entry point imports the package properly instead.

The spec **includes** the Local Whisper runtime (`faster-whisper`, `ctranslate2`,
`onnxruntime`, `av`, `tokenizers`, `huggingface-hub`) when the backend venv has the
`local-asr` extra; see [Local ASR runtime](#local-asr-runtime) below.

## The icon

The tree is drawn in code: `frontend/src/brand/treeGeometry.ts` holds the crown,
trunk and pixel roots, and the app reuses the same geometry. `scripts/make-icon.mts`
writes it as an Icon Composer document, `build/icon.icon`, with a teal Default
appearance and a graphite Dark one; macOS 26 also derives Clear and Tinted from its
layers and picks the variant from System Settings → Appearance → Icon & widget
style. electron-builder compiles the document into `Assets.car`.

The script also renders the Default appearance with Icon Composer's `ictool` on
Apple's grid (an 824pt plate in a 1024pt canvas): every size goes into
`build/icon.icns` for the DMG volume icon, and the 1024px image into `icon/icon.png`
for the README and the Dock during development. Pass `--previews <dir>` to render
all appearances for review.

Re-run `npm run icon` after changing the geometry or colours; `build/icon.icon` and
`build/icon.icns` are generated, not hand-maintained.

## One app, one icon

The backend and media tools are plain executables inside `SKAZ.app`, not app
bundles, so macOS never lists them as separate applications. The Electron helper
bundles under `Contents/Frameworks` are marked `LSUIElement` and stay hidden.

A second SKAZ icon in Launchpad comes from a second **copy** of `SKAZ.app`, most
often one launched straight from the mounted DMG. `electron/installLocation.ts`
handles that: a packaged app started outside `/Applications` offers once to move
itself there (`app.moveToApplicationsFolder`), and `requestSingleInstanceLock`
makes a second launch focus the existing window instead of starting another app
and backend. The offer is skipped when launched with `--user-data-dir`, so release
checks and smoke tests never see it.

## Product identity and persistent storage

The product is **SKAZ**, the Python package is `skaz`, and application environment
variables use `SKAZ_`. Historical names exist only in migration compatibility code.

| Launch | Private state | Default document library |
|---|---|---|
| Installed DMG/PKG | `~/.skaz/default/` | `~/Documents/SKAZ/` |
| `npm run dev` | `~/.skaz/dev/` | `~/Documents/SKAZ-dev/SKAZ/` |
| `npm run dev -- --profile=test` | `~/.skaz/test/` | `~/Documents/SKAZ-test/SKAZ/` |

`SKAZ_PROFILE=test npm run dev` is equivalent. Both development profiles persist
between launches and start without seed/demo content. Development libraries must
stay within their respective Documents parent; they cannot connect the installed
library. Packaged builds ignore development profile flags/environment settings.

Each private profile holds `data/skaz.sqlite3`, SKAZ-owned authentication/settings,
Electron caches and logs. Transcripts, Notes and group/session folders remain in
the document library (or the user's explicitly selected production location).
Standalone Codex/Hermes homes and externally imported source media are not moved.

Reinstalling the app does **not** clear data. On first use of the new installed
profile, the current product's old Application Support directory is adopted as a
whole, including SQLite sidecars and Electron preferences. An existing target is
never overwritten or merged. Older backend-only layouts are staged and copied,
retaining their source for safety. A running old installation or a pending migration
lock blocks migration rather than risking concurrent writes. Development/test
profiles never adopt old production data.

The DMG/PKG contains code/resources only, never a personal database, credentials,
or sample sessions. A genuinely empty local acceptance run requires a separate,
explicit cleanup of **both** private state and the selected SKAZ library. This is
not an installer feature. Do not remove the entire Documents directory.

For isolated release QA, an explicit absolute `--user-data-dir` keeps all private
state and the offered Documents location under that directory and skips migration.
It does not enable test/demo content. Eject the installer volume after installation;
old app copies in Trash or mounted volumes can leave extra macOS registrations.

## Working directory of the frozen backend

In a packaged app `REPO_ROOT` resolves inside `app.asar`, which is a virtual
archive, not a real directory — spawning a child with it as `cwd` fails before the
process ever runs, and the backend never reaches `ready`. `BackendManager.start`
therefore uses the user's home as cwd when `app.isPackaged`; the frozen backend
takes its token, data dir and documents dir from the environment and needs nothing
from the working directory.

## Signing

The DMG is built with `hardenedRuntime: true` and
`build/entitlements.mac.plist` (JIT + unsigned executable memory for Electron,
audio-input for capture, network-client for providers).

The only identity on this machine is an **Apple Development** certificate, which is
not a Developer ID and cannot be used for distribution. Consequences:

- On this Mac the app runs.
- On another Mac Gatekeeper may block the first launch. Check the origin and the
  release signing notes before using macOS's app-specific Open Anyway option, if
  available. Do not disable system-wide protection or blindly remove quarantine.

Proper distribution needs a **Developer ID Application** certificate plus
notarization (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` in the
environment; electron-builder notarizes when `mac.notarize` is enabled).

## Provider API keys

Keys are **not** in the macOS Keychain. A keychain item's ACL binds to the binary
that created it, and an app signed with a development certificate cannot own a
stable item — the packaged backend logged `KeyringLocked` and keys silently failed
to persist across restarts.

`FileSecretStore` (backend/src/skaz/secrets.py) stores them as a
Fernet-encrypted `secrets.json.enc` inside the app's data
directory, with the key beside it in `secrets.key` (file `0600`, directory `0700`).
The whole provider map is one encrypted blob, so provider names are not readable
either, and writes go through a temp file + `os.replace` so a crash cannot leave a
half-written vault.

This works identically in the repo and inside the signed bundle, and keys survive
restarts with no certificate involved. The trade-off, stated plainly: the key sits
next to the ciphertext, so the real boundary is file permissions. It does **not**
protect against another process running as your user, or a backup or synced copy
containing both files. Protect the data directory and its backups accordingly.

## Local ASR runtime

Settings → Transcription offers Local Whisper, so the frozen backend carries its
runtime: `faster_whisper` (with the bundled Silero VAD ONNX file), `ctranslate2`,
`onnxruntime` (VAD and the optional speaker-separation model), `av`, `tokenizers`
and `huggingface_hub`. The spec collects their submodules, data files and dynamic
libraries only when they are importable in `backend/.venv`; build from a venv made
with `uv sync --project backend --extra local-asr`. A venv without the extra still
produces a working backend where Local Whisper reports "dependency missing".

Model **weights are never bundled**: Whisper checkpoints (75 MB–3.1 GB) and the
speaker model (~27 MB) are downloaded on demand after the user confirms the size in
Settings, into the Hugging Face cache, and are then loaded with the network closed.
The runtime is large: in a Linux x86_64 test build of this spec it added about
350 MB to the backend (PyAV ~100 MB, CTranslate2 ~130 MB, ONNX Runtime ~57 MB,
NumPy ~42 MB, tokenizers ~11 MB; 414 MB total). The macOS arm64 wheels differ and
have not been measured yet — measure `Contents/Resources/backend` after building
and record it in the release notes. GigaChat Audio MLX remains excluded.

## Architecture

`--mac dmg --arch arm64` only. An Intel or universal build has never been run here,
so it is not claimed to work.
