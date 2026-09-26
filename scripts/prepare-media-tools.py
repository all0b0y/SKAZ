"""Build pinned macOS arm64 media tools; no runtime downloads or Homebrew dependency.

FFmpeg is built from source with no external libraries (LGPL); corresponding source
and license are shipped with the bundle. Build tools are needed only by developers.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import platform
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "backend" / ".runtime" / "media-tools"
CACHE = ROOT / ".runtime" / "media-build"
ASSETS = {
    "yt-dlp": ("https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_macos",
               "0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202"),
    "deno.zip": ("https://github.com/denoland/deno/releases/download/v2.9.7/deno-aarch64-apple-darwin.zip",
                 "5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c"),
    "ffmpeg-source.tar.xz": ("https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz",
                             "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"),
}


def fetch(name: str, url: str, digest: str) -> bytes:
    path = CACHE / name
    if not path.exists():
        print(f"Downloading {name}", flush=True)
        with urllib.request.urlopen(url, timeout=120) as response:
            payload = response.read()
        if hashlib.sha256(payload).hexdigest() != digest:
            raise RuntimeError(f"Checksum mismatch: {name}")
        path.write_bytes(payload)
    payload = path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != digest:
        raise RuntimeError(f"Checksum mismatch: {name}")
    return payload


def main() -> None:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("This distribution currently targets macOS arm64 only.")
    DEST.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    payloads = {name: fetch(name, *asset) for name, asset in ASSETS.items()}
    (DEST / "yt-dlp").write_bytes(payloads["yt-dlp"])
    with zipfile.ZipFile(io.BytesIO(payloads["deno.zip"])) as archive:
        (DEST / "deno").write_bytes(archive.read("deno"))
    source = CACHE / "ffmpeg-9.0.2"
    if not source.exists():
        with tarfile.open(fileobj=io.BytesIO(payloads["ffmpeg-source.tar.xz"]), mode="r:xz") as archive:
            archive.extractall(CACHE, filter="data")
    if not (source / "ffprobe").is_file():
        subprocess.run(["./configure", "--disable-autodetect", "--disable-doc", "--disable-debug",
                        "--disable-ffplay", "--disable-network", "--disable-videotoolbox",
                        "--disable-audiotoolbox", "--enable-small"], cwd=source, check=True)
        subprocess.run(["make", f"-j{min(os.cpu_count() or 2, 8)}", "ffmpeg", "ffprobe"],
                       cwd=source, check=True)
    for name in ("ffmpeg", "ffprobe"):
        shutil.copy2(source / name, DEST / name)
    for name in ("yt-dlp", "deno", "ffmpeg", "ffprobe"):
        (DEST / name).chmod(0o755)
    (DEST / "ffmpeg-source.tar.xz").write_bytes(payloads["ffmpeg-source.tar.xz"])
    shutil.copy2(source / "COPYING.LGPLv2.1", DEST / "FFMPEG-LICENSE.txt")
    # Source archives are the authoritative full third-party notices, not a hand-written license claim.
    for name, url in {
        "YTDLP-LICENSE.txt": "https://raw.githubusercontent.com/yt-dlp/yt-dlp/2026.08.19/LICENSE",
        "DENO-LICENSE.txt": "https://raw.githubusercontent.com/denoland/deno/v2.9.7/LICENSE.md",
    }.items():
        with urllib.request.urlopen(url, timeout=30) as response:
            (DEST / name).write_bytes(response.read())
    (DEST / "manifest.json").write_text(json.dumps({
        "sources": ASSETS,
        "binaries": {name: hashlib.sha256((DEST / name).read_bytes()).hexdigest()
                     for name in ("yt-dlp", "deno", "ffmpeg", "ffprobe")},
        "ffmpeg_config": "LGPL build, no autodetected external libraries, no networking",
    }, indent=2) + "\n")
    print(f"Media tools ready: {DEST}", flush=True)


if __name__ == "__main__":
    main()
