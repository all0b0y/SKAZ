"""Offline linked-speech imports. The inventory runner counts selected synthetic bytes."""
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz import media_tools
from skaz.import_service import ImportRequest
from tests.sessions_support import runtime_of
from tests.test_imports_api import Provider, settle, speech
from tests.test_imports_api import provider as provider
from tests.test_imports_api import ready as ready

URL = "https://vimeo.com/11111111"


@pytest.mark.parametrize("inventory", ["audio", "combined", "interrupted"])
async def test_linked_audio_inventory_and_retry(
    ready: httpx.AsyncClient, provider: Provider, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    inventory: str,
) -> None:
    monkeypatch.setattr("skaz.import_service.POLL_SCHEDULE", (0.0,))
    monkeypatch.setattr(media_tools, "tool_path", lambda name: name)
    selected: list[str] = []

    async def run(argv: list[str], **kwargs: Any) -> str:
        if "--dump-single-json" in argv:
            assert "--skip-download" in argv
            return '{"duration": 10, "availability": "public"}'
        assert argv[0] == "yt-dlp"
        selector = argv[argv.index("-f") + 1]
        target = argv[argv.index("--output") + 1]
        for choice in selector.split("/"):
            if choice == "bestaudio" and inventory != "combined":
                selected.append("audio")
                if inventory == "interrupted":
                    Path(target.replace("%(ext)s", "m4a.part")).write_bytes(b"partial")
                    raise media_tools.MediaError("Interrupted.")
                Path(target.replace("%(ext)s", "m4a")).write_bytes(b"audio")
                return ""
            if choice == "best" and inventory == "combined":
                selected.append("combined")
                Path(target.replace("%(ext)s", "mp4")).write_bytes(b"combined")
                return ""
        reason = kwargs["explain"]("ERROR: Requested format is not available")
        raise media_tools.MediaError(reason or media_tools.GENERIC_FAILURE)

    extracts: list[bytes] = []

    async def extract(source: Path, directory: Path) -> Path:
        extracts.append(source.read_bytes())
        output = directory / "audio.m4a"
        output.write_bytes(b"prepared audio")
        return output

    monkeypatch.setattr(media_tools, "run_tool", run)
    monkeypatch.setattr(media_tools, "extract_audio", extract)
    bridge = speech(ready)
    sid = bridge.create_import_session("Offline inventory")
    imports = runtime_of(ready).imports
    directory = imports.temp.directory(sid)
    original = tmp_path / "untouched.mp4"
    original.write_bytes(b"local original")
    if inventory == "audio":
        provider.queue(provider.failed("audio_error", "fixture failure"))
    await bridge.start_import(ImportRequest(sid, Path(""), False, None, url=URL, prepare_media=True))
    if inventory == "combined":
        # Wait for the real job even when the baseline wrongly completes it.
        await imports._tasks[sid]
        assert selected == []
        record = imports.store.get(sid)
        assert record and record.status == "failed" and "audio-only" in (record.error or "")
        assert not extracts and provider.upload_calls == 0
    else:
        await settle(ready, sid, expect="failed")
        assert selected == ["audio"]
        if inventory == "interrupted":
            assert not extracts and provider.upload_calls == 0
        else:
            assert extracts == [b"audio"]
            assert (directory / "ready.m4a").read_bytes() == b"prepared audio"
            assert list(directory.glob("download.*")) == []
            # Older versions could leave a muxed input or a partial in this job's scratch.
            (directory / "download.mp4").write_bytes(b"legacy combined")
            (directory / "download.webm.part").write_bytes(b"legacy partial")
            imports.sweep_temp()
            assert list(directory.glob("download.*")) == []
            assert (directory / "ready.m4a").read_bytes() == b"prepared audio"
            provider.queue(provider.failed("audio_error", "fixture failure"))
            await bridge.retry_import(sid)
            await settle(ready, sid, expect="completed")
            assert selected == ["audio"] and extracts == [b"audio"]
    assert list(directory.glob("download.*")) == []
    assert original.read_bytes() == b"local original"


async def test_local_original_and_retry_survive_link_cleanup(
    ready: httpx.AsyncClient, provider: Provider, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = tmp_path / "download.mp4"
    original.write_bytes(b"synthetic local original")
    reads: list[Path] = []

    async def extract(source: Path, directory: Path) -> Path:
        reads.append(source)
        assert source.read_bytes() == b"synthetic local original"
        path = directory / "audio.m4a"
        path.write_bytes(b"prepared local audio")
        return path

    monkeypatch.setattr(media_tools, "extract_audio", extract)
    monkeypatch.setattr("skaz.import_service.POLL_SCHEDULE", (0.0,))
    provider.queue(provider.failed("audio_error", "fixture failure"))
    bridge = speech(ready)
    sid = bridge.create_import_session("Local fixture")
    await bridge.start_import(ImportRequest(sid, original, False, None, prepare_media=True,
                                            metadata={"duration_ms": 2500}))
    await settle(ready, sid, expect="failed")
    imports = runtime_of(ready).imports
    directory = imports.temp.directory(sid)
    local_scratch = directory / "download.m4a"
    local_scratch.write_bytes(b"local scratch")
    imports.sweep_temp()
    assert local_scratch.read_bytes() == b"local scratch"
    assert (directory / "ready.m4a").read_bytes() == b"prepared local audio"
    provider.queue(provider.failed("audio_error", "fixture failure"))
    await bridge.retry_import(sid)
    await settle(ready, sid, expect="completed")
    assert reads == [original] and original.read_bytes() == b"synthetic local original"
