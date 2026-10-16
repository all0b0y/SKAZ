"""Export (decision B20): plain Markdown wiki with footnotes + the materials' .md, on a tmp library.

The pages are written by the real ingest pipeline on ``FakeEngine`` answers (``ScriptedWiki``),
then exported; the round-trip checks every citation became a footnote with its verbatim quote and
every wikilink of the export resolves to an exported file.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.markdown.page import parse_page
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.export import ExportRefused, check_target, export_library

from .ingest_support import ScriptedWiki, add_material
from .test_corrections import CONCEPTS, NOTES, SPEECH
from .wiki_support import ingest_done, settle_wiki, wired

_LINK = re.compile(r"\[\[([^\]|#\n]*)(#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]")
_REF = re.compile(r"\[\^(\d+)\](?!:)")
_DEF = re.compile(r"^\[\^(\d+)\]: (.*)$", re.MULTILINE)


async def built_library(kb: KnowledgeService, runtime: Any = None) -> str:
    material_id = add_material(kb, "Физика", "Лекция 8", SPEECH)
    add_material(kb, "Физика", "Статья", SPEECH, kind="text")
    wiki = ScriptedWiki(notes=[NOTES], concepts=[CONCEPTS])
    ingest, service = wired(kb, wiki, None, runtime)
    await ingest_done(ingest, material_id)
    await settle_wiki(service, ingest)
    return material_id


def exported_files(dest: Path) -> dict[str, str]:
    return {str(path.relative_to(dest)): path.read_text("utf-8") for path in dest.rglob("*.md")}


async def test_round_trip_every_citation_is_a_footnote_and_every_link_resolves(
    ready: KnowledgeService, documents: Path
) -> None:
    await built_library(ready)
    dest = documents / "Export"
    seen: list[tuple[int, int]] = []
    result = export_library(
        ready, str(dest), overwrite=False, progress=lambda done, total: seen.append((done, total))
    )
    files = exported_files(dest)
    assert seen and seen[-1][0] == seen[-1][1]

    # No SKAZ service files or markup anywhere.
    assert not [path for path in dest.rglob("*") if ".skaz" in path.parts or path.name.endswith(".json")]
    for name, text in files.items():
        assert "%% skaz:" not in text and "skaz_id" not in text, name
        assert not re.search(r"\^c-[A-Za-z0-9-]+", text), name

    # Every citation of every library page is one footnote with the material link and the verbatim quote.
    footnotes = 0
    for page in ready.pages():
        document = parse_page((ready.library_root / page.rel_path).read_text("utf-8"))
        text = files[page.rel_path]
        defs = dict(_DEF.findall(text))
        refs = set(_REF.findall(text))
        cites = {(c.material_id, c.seg, c.quote) for block in document.blocks() for c in block.cites}
        assert len(defs) == len(cites), (page.rel_path, defs, cites)
        assert refs == set(defs), page.rel_path
        for _material, seg, quote in cites:
            wanted = f"“{quote}”" if quote else ""
            match = [line for line in defs.values() if f"#^seg-{seg}|" in line and wanted in line]
            assert match, (page.rel_path, seg, quote, defs)
        footnotes += len(defs)
        assert text.startswith("---\ntitle: ")
    assert footnotes == result.footnotes > 0

    # Every wikilink resolves to an exported file (and a block anchor to its paragraph there).
    stems = {Path(name).stem for name in files}
    for name, text in files.items():
        for target, anchor in _LINK.findall(text):
            if "/" in target:
                assert f"{target}.md" in files, (name, target)
                if anchor.startswith("#^"):
                    assert anchor[1:] in files[f"{target}.md"], (name, target, anchor)
            else:
                assert target in stems, (name, target)

    # Materials: their .md with only a title in the frontmatter, ^seg ids kept for the footnotes.
    lecture = files["Materials/Физика/Лекция 8/Лекция 8.md"]
    assert lecture.startswith('---\ntitle: "Лекция 8"\n---\n') and "^seg-1" in lecture
    assert "Materials/Физика/Статья/Статья.md" in files
    assert "Wiki/index.md" in files and result.materials == 2


def test_target_rules(ready: KnowledgeService, documents: Path, tmp_path: Path) -> None:
    inside = ready.library_root / "Wiki"
    assert "outside the SKAZ library" in (check_target(ready, str(inside)).reason or "")
    assert "outside the SKAZ library" in (check_target(ready, str(ready.library_root)).reason or "")
    assert check_target(ready, "relative/path").reason
    assert "Documents" in (check_target(ready, str(tmp_path / "elsewhere")).reason or "")  # sandboxed run
    file = documents / "note.txt"
    file.write_text("x")
    assert "not a folder" in (check_target(ready, str(file)).reason or "")
    fresh = check_target(ready, str(documents / "New export"))
    assert fresh.reason is None and not fresh.non_empty
    busy = documents / "Busy"
    busy.mkdir()
    (busy / "keep.txt").write_text("mine")
    target = check_target(ready, str(busy))
    assert target.reason is None and target.non_empty and target.entries == 1
    with pytest.raises(ExportRefused, match="isn't empty"):
        export_library(ready, str(busy), overwrite=False)
    export_library(ready, str(busy), overwrite=True)
    assert (busy / "keep.txt").read_text() == "mine"  # other files stay


async def test_export_over_http_with_progress_and_notification(
    kb_app: Any, kb_client: httpx.AsyncClient, documents: Path
) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    await built_library(runtime.kb, runtime)
    dest = documents / "Out"
    checked = (await kb_client.get("/kb/export/target", params={"path": str(dest)})).json()
    assert checked == {"path": str(dest.resolve()), "reason": None, "non_empty": False, "entries": 0}
    inside = await kb_client.post("/kb/export", json={"path": str(runtime.kb.library_root / "Wiki")})
    assert inside.status_code == 409 and "outside the SKAZ library" in inside.json()["detail"]
    started = await kb_client.post("/kb/export", json={"path": str(dest)})
    assert started.status_code == 202, started.text
    job = started.json()
    assert job["kind"] == "export" and job["material_id"] is None
    await runtime.kb_wiki.jobs.wait(job["id"])
    done = (await kb_client.get(f"/kb/jobs/{job['id']}")).json()
    assert done["state"] == "done", done
    assert done["progress"]["parts_done"] == done["progress"]["parts_total"] > 0
    [notice] = [n for n in runtime.kb.notifications() if n.kind == "export_done"]
    assert notice.payload["path"] == str(dest.resolve())
    again = await kb_client.post("/kb/export", json={"path": str(dest)})
    assert again.status_code == 409 and "isn't empty" in again.json()["detail"]
