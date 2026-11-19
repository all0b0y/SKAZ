"""Production-path tests for V1 wiring: SourceService & /kb/materials/* with DOCX and images (incl. HEIC)."""

from __future__ import annotations

import hashlib
import struct
import zipfile
import zlib
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources.intake import SourceRejected
from skaz.knowledge.sources.native_intake041 import (
    FILE_CHANGED_MESSAGE,
    TrustedFileSelection,
    decode_image,
    prepare_docx_selection,
    validate_trusted_selection,
)
from skaz.knowledge.sources.service import SourceEvent, SourceService

FIXTURES_DIR = Path(__file__).resolve().parents[3] / "electron" / "nativeIntake041" / "fixtures"


@pytest.fixture
def sources(ready: KnowledgeService) -> SourceService:
    return SourceService(ready)


def test_source_service_imports_docx_and_images_into_real_library(
    sources: SourceService, tmp_path: Path
) -> None:
    events: list[SourceEvent] = []
    sources.subscribe(events.append)

    docx_path = FIXTURES_DIR / "sample-note.docx"
    docx_res = sources.add_file(docx_path, INBOX_ID, to_wiki=False, selection_source="picker")
    assert docx_res.status == "ready"
    assert docx_res.title == "Lecture Notes - KV Cache"
    assert docx_res.existing is False

    docx_detail = sources.kb.material(docx_res.material_id)
    assert docx_detail.kind == "docx"
    assert docx_detail.origin is not None
    assert docx_detail.origin["file_name"] == "sample-note.docx"
    assert docx_detail.origin["sha256"] == hashlib.sha256(docx_path.read_bytes()).hexdigest()
    assert docx_detail.origin["selection_source"] == "picker"
    assert any("Key and value tensors" in f.text for f in docx_detail.fragments)
    assert all("Ignore previous instructions" not in f.text for f in docx_detail.fragments)

    # Duplicate DOCX returns existing material without creating a second one
    docx_dup = sources.add_file(docx_path, INBOX_ID, to_wiki=False, selection_source="drop")
    assert docx_dup.existing is True
    assert docx_dup.material_id == docx_res.material_id

    # Real disk-backed JPEG, PNG, WebP, HEIC enter library with preserved identity & dimensions, no OCR
    for name, fmt, mime in (
        ("sample-chart.jpg", "jpeg", "image/jpeg"),
        ("sample-chart.png", "png", "image/png"),
        ("sample-chart.webp", "webp", "image/webp"),
        ("sample-chart.heic", "heic", "image/heic"),
    ):
        img_path = FIXTURES_DIR / name
        res = sources.add_file(img_path, INBOX_ID, selection_source="drop")
        assert res.status == "ready"
        detail = sources.kb.material(res.material_id)
        assert detail.kind == "image"
        assert detail.fragments == ()
        assert detail.origin is not None
        assert detail.origin["file_name"] == name
        assert detail.origin["sha256"] == hashlib.sha256(img_path.read_bytes()).hexdigest()
        assert detail.origin["mime_type"] == mime
        assert detail.origin["format"] == fmt
        assert detail.origin["width"] == 64
        assert detail.origin["height"] == 48
        assert detail.origin["ocr_performed"] is False
        assert detail.origin["selection_source"] == "drop"

        # Original file preserved in .skaz/original.<ext>
        record = sources.kb.material_repo.get(res.material_id)
        assert record is not None
        ext = img_path.suffix.lower()
        orig_path = sources.kb.library_root / record.rel_dir / ".skaz" / f"original{ext}"
        assert orig_path.read_bytes() == img_path.read_bytes()

        # HEIC & image preview decode locally to PNG
        preview_png = sources.preview_material_image(res.material_id)
        assert preview_png.startswith(b"\x89PNG\r\n\x1a\n")
        decoded = decode_image(preview_png, expected_format="png", mime_type="image/png")
        assert (decoded.width, decoded.height) == (64, 48)

    # Corrupt/spoofed HEIC is rejected before entering the library
    spoof = tmp_path / "fake.heic"
    spoof.write_bytes(b"not a heic image")
    with pytest.raises(SourceRejected, match="HEIC"):
        sources.add_file(spoof, INBOX_ID)


async def test_api_imports_docx_heic_clipboard_and_previews_without_auto_wiki(
    kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path
) -> None:
    await kb_client.post("/kb/library", json={})

    # Track SourceEvents to verify images emit to_wiki=False (no automatic wiki ingest)
    events: list[SourceEvent] = []
    kb_app.state.runtime.kb_sources.subscribe(events.append)

    docx_path = FIXTURES_DIR / "sample-note.docx"
    docx_resp = await kb_client.post(
        "/kb/materials/file",
        json={
            "path": str(docx_path),
            "folder_id": INBOX_ID,
            "to_wiki": False,
            "selection_source": "picker",
            "expected_size": docx_path.stat().st_size,
        },
    )
    assert docx_resp.status_code == 201, docx_resp.text
    docx_mat = docx_resp.json()["material"]
    assert docx_mat["kind"] == "docx"
    assert docx_mat["status"] == "ready"
    assert events[-1] == SourceEvent("material_ready", docx_mat["id"], to_wiki=False)

    heic_path = FIXTURES_DIR / "sample-chart.heic"
    heic_resp = await kb_client.post(
        "/kb/materials/file",
        json={
            "path": str(heic_path),
            "folder_id": INBOX_ID,
            "to_wiki": True,  # images must never auto-ingest into wiki
            "selection_source": "drop",
            "expected_size": heic_path.stat().st_size,
        },
    )
    assert heic_resp.status_code == 201, heic_resp.text
    heic_mat = heic_resp.json()["material"]
    assert heic_mat["kind"] == "image"
    assert heic_mat["fragment_count"] == 0
    assert events[-1] == SourceEvent("material_ready", heic_mat["id"], to_wiki=False)

    # Trusted preview route decodes HEIC to PNG
    prev_resp = await kb_client.post("/kb/materials/image-preview", json={"path": str(heic_path)})
    assert prev_resp.status_code == 200
    assert prev_resp.headers["content-type"] == "image/png"
    assert prev_resp.content.startswith(b"\x89PNG\r\n\x1a\n")

    # Clipboard image route accepts bounded PNG bytes
    png_bytes = (FIXTURES_DIR / "sample-chart.png").read_bytes()
    clip_resp = await kb_client.post(
        "/kb/materials/clipboard-image",
        params={"folder_id": INBOX_ID, "file_name": "Pasted chart"},
        headers={"content-type": "image/png"},
        content=png_bytes,
    )
    assert clip_resp.status_code == 201, clip_resp.text
    clip_mat = clip_resp.json()["material"]
    assert clip_mat["kind"] == "image"
    assert clip_mat["title"] == "Pasted chart"

    # Spoofed/corrupt file rejected with 422
    bad_docx = tmp_path / "corrupt.docx"
    bad_docx.write_bytes(b"not a docx")
    bad_resp = await kb_client.post(
        "/kb/materials/file", json={"path": str(bad_docx), "folder_id": INBOX_ID}
    )
    assert bad_resp.status_code == 422

    # Hidden/data_dir paths still refused
    hidden_dir = tmp_path / ".secret"
    hidden_dir.mkdir()
    hidden_img = hidden_dir / "secret.png"
    hidden_img.write_bytes(png_bytes)
    hidden_resp = await kb_client.post(
        "/kb/materials/file", json={"path": str(hidden_img), "folder_id": INBOX_ID}
    )
    assert hidden_resp.status_code == 422


def _write_same_length_docx(path: Path, word: str) -> None:
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    doc_xml = (
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body><w:p><w:r><w:t>{word}</w:t></w:r></w:p></w:body></w:document>"
    )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("word/document.xml", doc_xml)


def _png_with_comment(base_png: bytes, comment: bytes) -> bytes:
    # Insert a valid PNG tEXt chunk immediately before the 12-byte IEND chunk.
    assert base_png.endswith(b"\x00\x00\x00\x00IEND\xaeB`\x82")
    body = b"Comment\x00" + comment
    crc = zlib.crc32(b"tEXt" + body) & 0xFFFFFFFF
    chunk = struct.pack(">I", len(body)) + b"tEXt" + body + struct.pack(">I", crc)
    return base_png[:-12] + chunk + base_png[-12:]


async def test_api_version_binding_rejects_same_length_edits_for_preview_import_and_storage(
    kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path
) -> None:
    await kb_client.post("/kb/library", json={})

    temp_docx = tmp_path / "draft.docx"
    _write_same_length_docx(temp_docx, "Alpha")
    docx_v1 = temp_docx.read_bytes()
    docx_v1_sha = hashlib.sha256(docx_v1).hexdigest()

    temp_png = tmp_path / "diagram.png"
    base_png = (FIXTURES_DIR / "sample-chart.png").read_bytes()
    png_v1 = _png_with_comment(base_png, b"v1")
    temp_png.write_bytes(png_v1)
    png_v1_sha = hashlib.sha256(png_v1).hexdigest()

    # Edit both files with the exact same byte lengths
    _write_same_length_docx(temp_docx, "Bravo")
    docx_v2 = temp_docx.read_bytes()
    assert len(docx_v2) == len(docx_v1)
    docx_v2_sha = hashlib.sha256(docx_v2).hexdigest()
    assert docx_v2_sha != docx_v1_sha

    png_v2 = _png_with_comment(base_png, b"v2")
    assert len(png_v2) == len(png_v1)
    temp_png.write_bytes(png_v2)
    png_v2_sha = hashlib.sha256(png_v2).hexdigest()
    assert png_v2_sha != png_v1_sha

    # Preview and import under v1 version are both rejected with 422 asking for reselection
    prev_stale = await kb_client.post(
        "/kb/materials/image-preview",
        json={"path": str(temp_png), "expected_size": len(png_v1), "expected_sha256": png_v1_sha},
    )
    assert prev_stale.status_code == 422
    assert prev_stale.json()["detail"] == FILE_CHANGED_MESSAGE

    docx_stale = await kb_client.post(
        "/kb/materials/file",
        json={
            "path": str(temp_docx),
            "folder_id": INBOX_ID,
            "to_wiki": False,
            "expected_size": len(docx_v1),
            "expected_sha256": docx_v1_sha,
        },
    )
    assert docx_stale.status_code == 422
    assert docx_stale.json()["detail"] == FILE_CHANGED_MESSAGE

    png_stale = await kb_client.post(
        "/kb/materials/file",
        json={
            "path": str(temp_png),
            "folder_id": INBOX_ID,
            "to_wiki": False,
            "expected_size": len(png_v1),
            "expected_sha256": png_v1_sha,
        },
    )
    assert png_stale.status_code == 422
    assert png_stale.json()["detail"] == FILE_CHANGED_MESSAGE

    assert (await kb_client.get("/kb/materials")).json() == []

    # Fresh v2 selection versions succeed for preview and import
    prev_fresh = await kb_client.post(
        "/kb/materials/image-preview",
        json={"path": str(temp_png), "expected_size": len(png_v2), "expected_sha256": png_v2_sha},
    )
    assert prev_fresh.status_code == 200
    assert prev_fresh.content.startswith(b"\x89PNG\r\n\x1a\n")

    docx_fresh = await kb_client.post(
        "/kb/materials/file",
        json={
            "path": str(temp_docx),
            "folder_id": INBOX_ID,
            "to_wiki": False,
            "expected_size": len(docx_v2),
            "expected_sha256": docx_v2_sha,
        },
    )
    assert docx_fresh.status_code == 201, docx_fresh.text
    assert docx_fresh.json()["material"]["kind"] == "docx"

    # Storage copy check: editing after parsing fails _copy_into and rolls back cleanly
    sources: SourceService = kb_app.state.runtime.kb_sources
    race_docx = tmp_path / "race.docx"
    _write_same_length_docx(race_docx, "First")
    race_bytes = race_docx.read_bytes()
    validated = validate_trusted_selection(
        TrustedFileSelection.from_raw(
            race_docx,
            expected_size=len(race_bytes),
            expected_sha256=hashlib.sha256(race_bytes).hexdigest(),
        ),
        data_dir=sources.kb.data_dir,
    )
    prepared = sources._from_native(prepare_docx_selection(validated))
    _write_same_length_docx(race_docx, "Secnd")
    before_count = len(sources.kb.materials())
    with pytest.raises(SourceRejected) as copy_err:
        sources._publish(prepared, INBOX_ID, None, False)
    assert copy_err.value.message == FILE_CHANGED_MESSAGE
    assert len(sources.kb.materials()) == before_count
    assert not any(
        p.name.startswith("race") for p in sources.kb.require().folder(INBOX_ID).path.iterdir() if p.is_dir()
    )
