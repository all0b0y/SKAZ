# PyInstaller spec for the SKAZ/SKAZ local backend.
#
# The shipped app cannot run `uv run` or a repo virtualenv, so the backend is
# frozen into a self-contained binary that main.ts launches from
# Contents/Resources/backend/skaz-backend.
#
# Build:  backend/.venv/bin/pyinstaller --noconfirm --clean backend/skaz-backend.spec
# Output: backend/dist/skaz-backend/

from importlib.util import find_spec

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

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

# Local Whisper (Settings → Transcription) ships its *runtime* when the backend
# venv has the 'local-asr' extra: faster-whisper, CTranslate2, ONNX Runtime (Silero
# VAD and the speaker model), PyAV, tokenizers, huggingface-hub. Model *weights*
# are never bundled; the user downloads them on demand. A venv without the extra
# still builds a working Soniox/OpenAI-only backend: Local Whisper then reports
# "dependency missing" instead of failing.
datas = []
binaries = []
for module in ("faster_whisper", "ctranslate2", "onnxruntime", "av", "tokenizers", "huggingface_hub"):
    if find_spec(module) is None:
        continue
    hiddenimports += collect_submodules(module)
    datas += collect_data_files(module)  # faster_whisper/assets/silero_vad_v6.onnx
    binaries += collect_dynamic_libs(module)

excludes = [
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
    binaries=binaries,
    datas=datas,
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
