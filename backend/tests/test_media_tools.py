"""Media process boundary: errors and cancellation, no external services."""
from __future__ import annotations

import sys

import pytest

from skaz.media_tools import MediaError, run_tool


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
