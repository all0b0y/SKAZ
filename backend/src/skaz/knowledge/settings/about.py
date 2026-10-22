"""Settings → About: version, build and the licenses of what SKAZ ships or downloads on request."""
from __future__ import annotations

import os
from dataclasses import dataclass

from ...version import app_version
from ..decisions.local import LLAMA_SERVER, LOCAL_MODEL


@dataclass(frozen=True)
class License:
    name: str
    license: str
    url: str


@dataclass(frozen=True)
class About:
    version: str
    build: str
    licenses: tuple[License, ...]


#: Bundled media tools (``scripts/prepare-media-tools.py`` pins them and ships their license files),
#: the interface's fonts and libraries, and the backend's own dependencies.
LICENSES: tuple[License, ...] = (
    License("SKAZ", "MIT", "https://github.com/4IPE/SKAZ"),
    License("yt-dlp", "Unlicense", "https://github.com/yt-dlp/yt-dlp"),
    License("FFmpeg", "LGPL-2.1-or-later", "https://ffmpeg.org/legal.html"),
    License("Deno", "MIT", "https://github.com/denoland/deno"),
    License("faster-whisper", "MIT", "https://github.com/SYSTRAN/faster-whisper"),
    License("Inter", "OFL-1.1", "https://github.com/rsms/inter"),
    License("Unbounded", "OFL-1.1", "https://github.com/googlefonts/unbounded"),
    License("Lucide", "ISC", "https://lucide.dev/license"),
    License("AnimateIcons", "MIT", "https://github.com/Avijit07x/animateicons"),
    License("Hugeicons", "MIT", "https://github.com/hugeicons/hugeicons-react"),
    License("Motion", "MIT", "https://github.com/motiondivision/motion"),
    License("React", "MIT", "https://github.com/facebook/react"),
    License("Electron", "MIT", "https://github.com/electron/electron"),
    License("FastAPI", "MIT", "https://github.com/fastapi/fastapi"),
    License("pypdf", "BSD-3-Clause", "https://github.com/py-pdf/pypdf"),
    License("readability-lxml", "Apache-2.0", "https://github.com/buriy/python-readability"),
    # Downloaded only when the user chooses the decision layer on this Mac (D1).
    License(f"llama.cpp {LLAMA_SERVER.build}", LLAMA_SERVER.license, "https://github.com/ggml-org/llama.cpp"),
    License(LOCAL_MODEL.title, LOCAL_MODEL.license, LOCAL_MODEL.homepage),
)


def about() -> About:
    build = os.environ.get("SKAZ_BUILD", "").strip()[:80] or "development"
    return About(app_version(), build, LICENSES)
