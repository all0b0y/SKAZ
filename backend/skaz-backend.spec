# PyInstaller spec for the AudioHelper/SKAZ local backend.
#
# The shipped app cannot run `uv run` or a repo virtualenv, so the backend is
# frozen into a self-contained binary that main.ts launches from
# Contents/Resources/backend/skaz-backend.
#
# Build:  backend/.venv/bin/pyinstaller --noconfirm --clean backend/skaz-backend.spec
# Output: backend/dist/skaz-backend/

from PyInstaller.utils.hooks import collect_submodules

hiddenimports = [
    # Uvicorn/Starlette resolve their protocol implementations by string name,
    # so the static analyser never sees these imports.
    *collect_submodules("uvicorn"),
    "websockets",
    "websockets.legacy",
    "websockets.asyncio",
    # Fernet is imported lazily inside the secret store.
    "cryptography.fernet",
    "cryptography.hazmat.backends.openssl",
]

# Local Whisper is an optional extra (faster-whisper + ctranslate2 + onnxruntime
# ≈ hundreds of MB). Exclude it from the shipped bundle: the product's live path
# is Soniox, and the local models feature degrades gracefully when the module is
# absent (local_models.gigachat_runtime_available / capabilities probes).
excludes = [
    "faster_whisper",
    "ctranslate2",
    "onnxruntime",
    "av",
    "tokenizers",
    "gigachat_audio_mlx",
    "torch",
    "pytest",
    "mypy",
    "ruff",
    "tkinter",
    "matplotlib",
]

a = Analysis(
    ["scripts/frozen_entry.py"],
    pathex=["src"],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="skaz-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="skaz-backend",
)
