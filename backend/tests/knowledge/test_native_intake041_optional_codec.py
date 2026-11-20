"""Regression tests for keeping SKAZ backend usable when the optional PyAV codec is absent."""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.library.layout import SERVICE_DIR
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.sources.intake import SourceRejected
from skaz.knowledge.sources.native_intake041 import (
    ImageCodecUnavailable,
    decode_image,
    image_codec_available,
)
from skaz.knowledge.sources.service import SourceService

REPO_ROOT = Path(__file__).resolve().parents[3]
BACKEND_SRC = REPO_ROOT / "backend" / "src"
FIXTURES_DIR = REPO_ROOT / "electron" / "nativeIntake041" / "fixtures"

_SUBPROCESS_SCRIPT = """
import importlib.abc
import importlib.util
import json
import sys
from pathlib import Path

block_av = sys.argv[1] == "block"
tmp_root = Path(sys.argv[2])
fixtures_dir = Path(sys.argv[3])

if block_av:
    class _BlockAv(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname == "av" or fullname.startswith("av."):
                raise ModuleNotFoundError("No module named 'av'")
            return None

    sys.meta_path.insert(0, _BlockAv())
    sys.modules.pop("av", None)
    try:
        assert importlib.util.find_spec("av") is None
    except ModuleNotFoundError:
        pass
else:
    assert importlib.util.find_spec("av") is None, "av must be unimportable in lean child"

import skaz
assert Path(skaz.__file__).resolve().is_relative_to(Path(sys.argv[4]).resolve())

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.sources.native_intake041 import image_codec_available
from skaz.secrets import MemorySecretStore
import asyncio
import httpx

assert image_codec_available() is False
assert "av" not in sys.modules

docs_dir = tmp_root / "Documents"
docs_dir.mkdir()
cfg = AppConfig(
    token="child-token",
    data_dir=tmp_root / "data",
    request_timeout_s=5.0,
    documents_dir=docs_dir,
    documents_sandbox=docs_dir,
)
app = create_app(
    cfg,
    secret_store=MemorySecretStore(),
    http_client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _r: httpx.Response(599))),
)
assert "av" not in sys.modules

async def _exercise():
    headers = {"Authorization": "Bearer child-token"}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1:8765",
        headers=headers,
    ) as client:
        health = await client.get("/health")
        assert health.status_code == 200

        lib = await client.post("/kb/library", json={})
        assert lib.status_code == 200

        docx = await client.post(
            "/kb/materials/file",
            json={"path": str(fixtures_dir / "sample-note.docx"), "folder_id": INBOX_ID, "to_wiki": False},
        )
        assert docx.status_code == 201, docx.text
        assert docx.json()["material"]["kind"] == "docx"

        png = await client.post(
            "/kb/materials/file",
            json={"path": str(fixtures_dir / "sample-chart.png"), "folder_id": INBOX_ID, "to_wiki": False},
        )
        assert png.status_code == 201, png.text
        assert png.json()["material"]["kind"] == "image"

        heic = await client.post(
            "/kb/materials/file",
            json={"path": str(fixtures_dir / "sample-chart.heic"), "folder_id": INBOX_ID, "to_wiki": False},
        )
        assert heic.status_code == 201, heic.text
        assert heic.json()["material"]["kind"] == "image"

        clip = await client.post(
            "/kb/materials/clipboard-image",
            params={"folder_id": INBOX_ID, "file_name": "Clip"},
            headers={"content-type": "image/png"},
            content=(fixtures_dir / "sample-chart.png").read_bytes(),
        )
        assert clip.status_code == 200, clip.text
        assert clip.json()["material"]["id"] == png.json()["material"]["id"]

        prev = await client.post(
            "/kb/materials/image-preview",
            json={"path": str(fixtures_dir / "sample-chart.heic")},
        )
        assert prev.status_code == 200, prev.text
        assert prev.content.startswith(bytes.fromhex("89504e470d0a1a0a"))

        mats = await client.get("/kb/materials")
        assert mats.status_code == 200
        assert sorted(m["kind"] for m in mats.json()) == ["docx", "image", "image"]

        return {
            "skaz_file": skaz.__file__,
            "png_status": png.status_code,
            "clip_status": clip.status_code,
            "prev_status": prev.status_code,
            "materials": len(mats.json()),
        }

try:
    result = asyncio.run(_exercise())
finally:
    app.state.runtime.close()

print(json.dumps(result))
"""


def test_subprocess_startup_and_routes_without_av(tmp_path: Path) -> None:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(tmp_path),
        "PYTHONNOUSERSITE": "1",
        "PYTHONPATH": str(BACKEND_SRC),
        "SKAZ_UPDATE_CHECK": "0",
    }
    mode = "block" if image_codec_available() else "natural"
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            _SUBPROCESS_SCRIPT,
            mode,
            str(tmp_path),
            str(FIXTURES_DIR),
            str(BACKEND_SRC),
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"stderr:\n{proc.stderr}\nstdout:\n{proc.stdout}"
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    assert payload["png_status"] == 201
    assert payload["clip_status"] == 200
    assert payload["prev_status"] == 200
    assert payload["materials"] == 3


async def test_image_and_document_intake_with_broken_pyav_loader(
    kb_app: Any,
    kb_client: httpx.AsyncClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await kb_client.post("/kb/library", json={})

    # Non-image intake (DOCX and Markdown) stays functional regardless of codec availability.
    docx_resp = await kb_client.post(
        "/kb/materials/file",
        json={
            "path": str(FIXTURES_DIR / "sample-note.docx"),
            "folder_id": INBOX_ID,
            "to_wiki": False,
        },
    )
    assert docx_resp.status_code == 201, docx_resp.text
    assert docx_resp.json()["material"]["kind"] == "docx"

    md_path = tmp_path / "notes.md"
    md_path.write_text("# Lean Mode\n\nStill works without PyAV.\n", encoding="utf-8")
    md_resp = await kb_client.post(
        "/kb/materials/file",
        json={"path": str(md_path), "folder_id": INBOX_ID, "to_wiki": False},
    )
    assert md_resp.status_code == 201, md_resp.text
    assert md_resp.json()["material"]["kind"] == "text"

    # Spoofed/corrupt headers are still rejected on format grounds before codec loading.
    spoofed = tmp_path / "fake.heic"
    spoofed.write_bytes(b"not a heic image")
    spoof_resp = await kb_client.post(
        "/kb/materials/file",
        json={"path": str(spoofed), "folder_id": INBOX_ID, "to_wiki": False},
    )
    assert spoof_resp.status_code == 422
    assert "HEIC" in spoof_resp.json()["detail"]

    # Seed an existing healthy image material on disk to ensure lean preview/re-add never breaks it.
    png_bytes = (FIXTURES_DIR / "sample-chart.png").read_bytes()
    png_sha = hashlib.sha256(png_bytes).hexdigest()
    kb = kb_app.state.runtime.kb
    existing_img = kb.create_material(
        INBOX_ID,
        "Existing Chart",
        "image",
        [],
        status="ready",
        origin={
            "type": "file",
            "file_name": "sample-chart.png",
            "sha256": png_sha,
            "mime_type": "image/png",
            "format": "png",
            "size_bytes": len(png_bytes),
        },
    )
    service_dir = existing_img.directory / SERVICE_DIR
    (service_dir / "original.png").write_bytes(png_bytes)
    (service_dir / "intake.json").write_text(
        json.dumps(
            {
                "format": 1,
                "extractor": "image",
                "failure": None,
                "hidden": [],
                "original": "original.png",
                "created_at": "2026-11-19T00:00:00Z",
            }
        ),
        encoding="utf-8",
    )

    if image_codec_available():
        real_import = importlib.import_module

        def _fail_av(name: str, package: str | None = None) -> Any:
            if name == "av" or name.startswith("av."):
                raise OSError("dlopen(libavcodec.dylib): image not found")
            return real_import(name, package)

        monkeypatch.setattr(importlib, "import_module", _fail_av)

    # Native intake uses the bundled image decoder even if PyAV cannot load.
    new_png = tmp_path / "new-chart.png"
    new_png.write_bytes(png_bytes + b"\x00")
    img_resp = await kb_client.post(
        "/kb/materials/file",
        json={"path": str(new_png), "folder_id": INBOX_ID, "to_wiki": False},
    )
    assert img_resp.status_code == 201, img_resp.text
    assert img_resp.json()["material"]["kind"] == "image"

    # Clipboard import reuses the previously saved image.
    clip_resp = await kb_client.post(
        "/kb/materials/clipboard-image",
        params={"folder_id": INBOX_ID, "file_name": "Clipboard"},
        headers={"content-type": "image/png"},
        content=png_bytes,
    )
    assert clip_resp.status_code == 200, clip_resp.text
    assert clip_resp.json()["material"]["id"] == existing_img.manifest.id

    # Disk and legacy material previews use the same bundled image decoder.
    disk_prev = await kb_client.post(
        "/kb/materials/image-preview",
        json={"path": str(FIXTURES_DIR / "sample-chart.heic")},
    )
    assert disk_prev.status_code == 200, disk_prev.text
    assert disk_prev.content.startswith(b"\x89PNG\r\n\x1a\n")

    mat_prev = await kb_client.post(
        "/kb/materials/image-preview",
        json={"material_id": existing_img.manifest.id},
    )
    assert mat_prev.status_code == 200, mat_prev.text
    assert mat_prev.content.startswith(b"\x89PNG\r\n\x1a\n")

    # Existing healthy image material remains intact and readable; no extra broken materials were created.
    existing_get = await kb_client.get(f"/kb/materials/{existing_img.manifest.id}")
    assert existing_get.status_code == 200
    assert existing_get.json()["status"] == "ready"
    assert (service_dir / "original.png").read_bytes() == png_bytes

    all_mats = await kb_client.get("/kb/materials")
    assert all_mats.status_code == 200
    assert len(all_mats.json()) == 4

    # Re-adding the exact already-stored image returns existing=True safely.
    sources: SourceService = kb_app.state.runtime.kb_sources
    dup = sources.add_file(FIXTURES_DIR / "sample-chart.png", INBOX_ID)
    assert dup.existing is True
    assert dup.material_id == existing_img.manifest.id


def test_decode_image_loader_failure_is_capability_error_not_damaged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    png_bytes = (FIXTURES_DIR / "sample-chart.png").read_bytes()
    real_import = importlib.import_module

    def _broken_loader(name: str, package: str | None = None) -> Any:
        if name == "av" or name.startswith("av."):
            raise ImportError("cannot load shared library")
        return real_import(name, package)

    monkeypatch.setattr(importlib, "import_module", _broken_loader)

    with pytest.raises(ImageCodecUnavailable) as exc_info:
        decode_image(png_bytes, expected_format="png", mime_type="image/png", generate_preview=True)

    err = exc_info.value
    assert isinstance(err, SourceRejected)
    assert err.status_code == 503
    assert "damaged" not in err.message.lower()
    assert "PNG" in err.message
