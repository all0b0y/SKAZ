"""Media process boundary: errors and cancellation, no external services."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

from skaz.media_tools import MediaError, run_tool, tool_path


async def test_process_returns_bounded_output() -> None:
    assert await run_tool([sys.executable, "-c", "print('metadata')"]) == "metadata\n"


async def test_failed_tool_does_not_leak_stderr_secrets() -> None:
    with pytest.raises(MediaError, match="Media tool failed") as error:
        await run_tool([sys.executable, "-c", "import sys; sys.stderr.write('secret'); sys.exit(1)"])
    assert "secret" not in str(error.value)


async def test_tool_cannot_flood_memory() -> None:
    with pytest.raises(MediaError, match="too much output"):
        await run_tool([sys.executable, "-c", "print('x'*100000)"], max_output=1024)


async def test_tool_timeout_is_bounded() -> None:
    with pytest.raises(MediaError, match="timed out"):
        await run_tool([sys.executable, "-c", "import time; time.sleep(60)"], timeout=0.05)


def test_a_missing_tool_in_development_says_how_to_fetch_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # User bug 1016-6: `npm run dev` without backend/.runtime/media-tools told the developer to install
    # an updated SKAZ build.
    monkeypatch.delenv("SKAZ_MEDIA_TOOLS_DIR", raising=False)
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.setattr("skaz.media_tools.shutil.which", lambda _name: None)
    with pytest.raises(MediaError) as error:
        tool_path("skaz-no-such-tool")
    assert str(error.value) == (
        "Media tool skaz-no-such-tool is unavailable. "
        "Run `npm run build:media` to fetch the media tools for development."
    )
    monkeypatch.setenv("SKAZ_MEDIA_TOOLS_DIR", str(tmp_path))
    with pytest.raises(MediaError, match="npm run build:media"):
        tool_path("yt-dlp")


def test_a_missing_tool_in_the_packaged_app_asks_for_an_updated_build(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("SKAZ_MEDIA_TOOLS_DIR", str(tmp_path))
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    with pytest.raises(MediaError) as error:
        tool_path("yt-dlp")
    assert str(error.value) == "Media tool yt-dlp is unavailable. Install an updated SKAZ build."
