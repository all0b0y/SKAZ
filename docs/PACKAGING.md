# Packaging: SKAZ.app and the DMG installer

How the repository turns into a double-clickable macOS installer, and what is
verified vs. still open. Written for a developer on this machine; the end user
only ever sees the `.dmg`.

## One command

```bash
npm run dist:mac
```

Result: `release/SKAZ-<version>-arm64.dmg` — the familiar installer window where
the app is dragged onto `Applications`.

`dist:mac` chains four steps, each runnable on its own:

| Step | Command | Produces |
|---|---|---|
| 1. Icon | `npm run icon` | `build/icon.icns`, `build/icon.png` |
| 2. Backend | `npm run build:backend` | `backend/dist/skaz-backend/` |
| 3. Renderer/main/preload | `npm run build` | `dist/` |
| 4. Bundle + DMG | `electron-builder --mac dmg` | `release/*.dmg` |

Prerequisites: `npm install`, a populated `backend/.venv` (with `pyinstaller`
installed into it: `uv pip install --python backend/.venv/bin/python pyinstaller`),
and Python 3 with Pillow on the PATH for the icon step.

## Why the backend is frozen

An installed `.app` has no repository and no `uv`. `BackendManager.resolveSpawn`
(electron/backend.ts) therefore has two paths:

- **Packaged** — runs `Contents/Resources/backend/skaz-backend`, a PyInstaller
  bundle built from `backend/skaz-backend.spec`.
- **Unpackaged** — unchanged: `backend/.venv/bin/python -m audiohelper`, or
  `uv run --project backend` as a fallback.

`backend/scripts/frozen_entry.py` exists because PyInstaller executes the analysed
script as `__main__`, which breaks the relative imports inside
`audiohelper/__main__.py`. The entry point imports the package properly instead.

The spec **excludes** `faster-whisper`, `ctranslate2`, `onnxruntime`, `av` and
`tokenizers`. Local Whisper is an optional extra worth several hundred MB; the
product's live path is Soniox, and the local-models probes degrade gracefully when
the module is absent. Shipping local ASR means removing those excludes and
accepting the size.

## The icon

`scripts/make-icon.py` masks the square source artwork (`icon/icon.png`) into the
macOS plate: an 824pt superellipse inside a 1024pt canvas plus a soft contact
shadow, then `iconutil` emits every Retina size into `build/icon.icns`. A raw PNG
would render as a sharp-cornered square, visibly oversized next to every other
Dock icon.

Re-run `npm run icon` after changing the artwork; `build/icon.icns` is generated,
not hand-maintained.

## The rename and user data

`productName: SKAZ` renames the bundle, the Dock/menu title **and** the Electron
userData directory. The app creates `~/Library/Application Support/SKAZ/data` on
first launch and owns it exclusively: nothing is inherited or copied from any
earlier install. A pre-rename `audiohelper` folder, if present, is simply left
alone.

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
- On another Mac Gatekeeper will refuse the first launch; the user has to
  right-click → Open, or run `xattr -dr com.apple.quarantine /Applications/SKAZ.app`.

Proper distribution needs a **Developer ID Application** certificate plus
notarization (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` in the
environment; electron-builder notarizes when `mac.notarize` is enabled).

## Provider API keys

Keys are **not** in the macOS Keychain. A keychain item's ACL binds to the binary
that created it, and an app signed with a development certificate cannot own a
stable item — the packaged backend logged `KeyringLocked` and keys silently failed
to persist across restarts.

`FileSecretStore` (backend/src/audiohelper/secrets.py) stores them as a
Fernet-encrypted `secrets.json.enc` inside the app's data
directory, with the key beside it in `secrets.key` (file `0600`, directory `0700`).
The whole provider map is one encrypted blob, so provider names are not readable
either, and writes go through a temp file + `os.replace` so a crash cannot leave a
half-written vault.

This works identically in the repo and inside the signed bundle, and keys survive
restarts with no certificate involved. The trade-off, stated plainly: the key sits
next to the ciphertext, so the real boundary is file permissions. It protects keys
in backups, synced folders and stray copies — **not** against another process
already running as your user.

## Local ASR is deliberately not shipped

`skaz-backend.spec` excludes `faster_whisper`, `ctranslate2`, `onnxruntime`, `av`
and `tokenizers`. The live path is Soniox; local Whisper would add hundreds of MB
for a feature the product does not currently use, and the local-model probes
degrade gracefully when the modules are absent. Verified on the built bundle: none
of those libraries appear under `Contents/Resources/backend` (50 MB total).

Shipping local ASR later means removing those excludes and accepting the size.

## Architecture

`--mac dmg --arch arm64` only. An Intel or universal build has never been run here,
so it is not claimed to work.
