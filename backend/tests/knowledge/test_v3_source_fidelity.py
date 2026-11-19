"""Fidelity at the V3 source seam, using synthetic pages and permitted fixture frames."""
import hashlib
import shutil
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.markdown.source import Origin
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources.pdf import extract_pdf
from skaz.knowledge.sources.service import SourceService
from skaz.knowledge.sources.visual import (
    LinkedFramePolicy,
    RetrievedFrame,
    VisualSourcePreparer,
    VisualSourceUnsupported,
)
from skaz.media_source import VideoSource
from tests.knowledge.pdf_fixtures import make_pdf
from tests.knowledge.test_source_visual import make_png, material_dir


@pytest.mark.skipif(shutil.which("sips") is None, reason="Requires the local macOS PDF rasterizer")
@pytest.mark.parametrize("hidden", [
    b"(ten spaces) Tj", b"[(ten) -180 (spaces)] TJ", b'22 TL 3 2 (label) "',
])
def test_mixed_text_geometry(ready: KnowledgeService, tmp_path: Path, hidden: bytes) -> None:
    # Font, spacing, glyph advances and line origin all affect the next visible text.
    pdf = make_pdf([b"BT /F1 12 Tf 72 690 Td 3 Tr " + hidden
                    + b" 0 Tr (Visible) Tj T* (Next line) Tj ET"])
    source = tmp_path / "mixed.pdf"
    source.write_bytes(pdf)
    sources = SourceService(ready)
    added = sources.add_file(source, INBOX_ID)
    extracted = extract_pdf(pdf)
    assert extracted.findings and "Visible" in " ".join(p.text for p in extracted.paragraphs)
    assert not any("spaces" in p.text or "label" in p.text for p in extracted.paragraphs)
    (page,) = sources.prepare_pdf_pages(added.material_id, pages=[1])
    assert page.locator.page == 1 and page.locator.source_sha256 == hashlib.sha256(pdf).hexdigest()
    prepared = tmp_path / "page.png"
    prepared.write_bytes(page.data)

    def bitmap(path: Path) -> bytes:
        dest = path.with_suffix(".bmp")
        subprocess.run(["/usr/bin/sips", "-s", "format", "bmp", str(path), "--out", str(dest)],
                       check=True, capture_output=True, timeout=15)
        return dest.read_bytes()

    original, result = bitmap(source), bitmap(prepared)
    assert len(result) == len(original)
    delta = sum(a != b for a, b in zip(original, result, strict=True))
    assert delta == 0, f"{delta} differing bitmap bytes"
    assert not list(material_dir(ready, added.material_id).rglob("*.png"))


@pytest.mark.parametrize("action", ["cite", "pin", "ambiguous", "foreign", "duplicate_hash"])
async def test_frame_identity(ready: KnowledgeService, action: str) -> None:
    url = "https://vimeo.com/11111111"
    material = ready.create_material(INBOX_ID, "Video", "video_link", [], status="ready",
                                     origin=Origin(type="url", url=url))
    mid = material.manifest.id

    def retrieve(source: VideoSource, requested: tuple[int, ...]) -> list[RetrievedFrame]:
        assert source.url == url and requested == (10_000, 11_000)
        return [
            RetrievedFrame(data=make_png(), requested_timestamp_ms=10_000, actual_timestamp_ms=11_000),
            RetrievedFrame(data=make_png() if action == "duplicate_hash" else make_png(5, 4),
                           requested_timestamp_ms=11_000,
                           actual_timestamp_ms=11_000 if action == "ambiguous" else 11_120),
        ]

    prep = VisualSourcePreparer(ready, frame_retriever=retrieve, frame_policy=LinkedFramePolicy(True, True))
    frames = await prep.prepare_video_frames(mid, timestamps_ms=[10_000, 11_000])
    folder = material_dir(ready, mid) / ".skaz" / "frames"
    if action == "ambiguous":
        with pytest.raises(VisualSourceUnsupported, match="ambiguous"):
            prep.retain_video_frames(mid, frames, cited_timestamps_ms=[11_000])
    elif action == "duplicate_hash":
        with pytest.raises(VisualSourceUnsupported, match="ambiguous"):
            prep.retain_video_frames(mid, frames, pinned_sha256s=[frames[0].sha256])
    elif action == "foreign":
        foreign = replace(frames[0], locator=frames[0].locator.model_copy(update={"material_id": "other"}))
        with pytest.raises(VisualSourceUnsupported):
            prep.pin_video_frame(mid, foreign)
    elif action == "pin":
        records = prep.retain_video_frames(mid, frames, pinned_timestamps_ms=[11_000])
        assert [r.locator.timestamp_ms for r in records] == [11_000]
        assert records[0].retained_because == ("pinned",)
    else:
        records = prep.retain_video_frames(mid, frames, cited_timestamps_ms=[11_000],
                                          pinned_timestamps_ms=[11_120], citation_refs={11_000: ["reply-1"]})
        assert [(r.retained_because, r.citation_refs) for r in records] == [
            (("cited",), ("reply-1",)), (("pinned",), ()),
        ]
    assert len(list(folder.glob("*.png"))) == {"cite": 2, "pin": 1}.get(action, 0)


@pytest.mark.skipif(shutil.which("sips") is None, reason="Requires the local macOS PDF rasterizer")
@pytest.mark.parametrize(("alpha", "expected_success"), [(0.0, True), (0.045, False)])
def test_filtered_ink_requires_pixel_agreement(
    ready: KnowledgeService, tmp_path: Path, alpha: float, expected_success: bool,
) -> None:
    # Guard-classified ink can be transparent or faintly visible in the original.
    pdf = make_pdf([b"BT /F1 14 Tf 40 200 Td (Visible caption) Tj ET\n"
                    b"q /Dim gs BT /F1 24 Tf 72 100 Td (Reference label) Tj ET Q"],
                   alphas={"Dim": alpha})
    source = tmp_path / "chart.pdf"
    source.write_bytes(pdf)
    sources = SourceService(ready)
    added = sources.add_file(source, INBOX_ID)
    render = sources.visual.page_renderer
    calls: list[int] = []

    def counted(page_pdf: bytes, number: int) -> bytes:
        calls.append(number)
        return render(page_pdf, number)

    sources.visual.page_renderer = counted
    seam = sources.prepare_visual_seam(material_id=added.material_id, pages=[1])
    assert calls == [1, 1]
    assert seam.ok is expected_success and seam.has_source_text
    if expected_success:
        assert [(item.width, item.height) for item in seam.items] == [(612, 792)]
    else:
        assert not seam.items and seam.reason == "pdf_render_unavailable"
        assert seam.locator and seam.locator.page == 1
