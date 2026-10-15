"""The material as the library shows it: folder, wiki state, translation and excluded count (API-B2 §1.3).

* Wiki state comes from the ingest jobs of the material (W1) and the pages
  that name it as a source: a running job → ``processing``; a note or concept
  page from it → ``in_wiki``; the last job failed and no page exists →
  ``failed``; otherwise ``not_in_wiki``.
* The translation is the provider's own text in ``.skaz/translation.md``
  (speech area S2). Soniox translations carry no segment ids
  (SONIOX-TRANSLATION-STORAGE), so every paragraph has ``seg = None`` and
  they follow the original's order.
"""
from __future__ import annotations

import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from ..library.fsio import read_json
from ..library.layout import MATERIAL_MANIFEST, SERVICE_DIR
from ..markdown.frontmatter import FrontmatterError, split_frontmatter
from ..store.database import KnowledgeDatabase
from .guard.visibility import ExclusionsUnreadable, read_excluded

log = logging.getLogger(__name__)

WikiState = Literal["not_in_wiki", "processing", "in_wiki", "failed"]
TRANSLATION_FILE = "translation.md"
#: Jobs that (re)build a material's pages (W1 ingest; W2 refresh).
_WIKI_JOB_KINDS = ("ingest", "refresh")
_FAILED = ("failed", "interrupted")
_SPEAKER = re.compile(r"^\*\*Speaker ([^*\n]{1,40})\*\*\s*\n")
#: Translations larger than this are not inlined into the material view.
MAX_TRANSLATION_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class MaterialWiki:
    state: WikiState
    note_page_id: str | None
    concept_count: int
    job_id: str | None
    error: str | None
    #: ``AGENT_UNAVAILABLE``: the latest job failed because the agent can't work (signed out,
    #: outdated, none connected) — fixed in Settings, not by a retry. ``None`` otherwise.
    error_code: str | None = None


NOT_IN_WIKI = MaterialWiki("not_in_wiki", None, 0, None, None)


@dataclass(frozen=True)
class TranslationParagraph:
    seg: int | None
    speaker: str | None
    text: str


@dataclass(frozen=True)
class Translation:
    language: str | None
    fragments: tuple[TranslationParagraph, ...]


def _chunks(ids: list[str], size: int = 400) -> Iterable[list[str]]:
    for start in range(0, len(ids), size):
        yield ids[start:start + size]


def wiki_states(db: KnowledgeDatabase, material_ids: Iterable[str]) -> dict[str, MaterialWiki]:
    """The wiki state of each material (one read of jobs and page sources for all of them)."""
    ids = list(dict.fromkeys(material_ids))
    latest: dict[str, tuple[str, str, str | None, str | None]] = {}
    notes: dict[str, str] = {}
    concepts: dict[str, int] = {}
    with db.read() as connection:
        for chunk in _chunks(ids):
            marks = ",".join("?" * len(chunk))
            kinds = ",".join("?" * len(_WIKI_JOB_KINDS))
            for row in connection.execute(
                f"SELECT j.id AS id, j.target_id AS target_id, j.state AS state, j.error AS error, "
                f"d.error_code AS error_code FROM jobs j LEFT JOIN ingest_jobs d ON d.job_id = j.id "
                f"WHERE j.kind IN ({kinds}) AND j.target_id IN ({marks}) "
                f"ORDER BY j.created_at DESC, j.rowid DESC",
                (*_WIKI_JOB_KINDS, *chunk),
            ):
                latest.setdefault(row["target_id"],
                                  (row["id"], row["state"], row["error"], row["error_code"]))
            for row in connection.execute(
                "SELECT s.material_id AS material_id, p.id AS page_id, p.kind AS kind "
                f"FROM page_sources s JOIN pages p ON p.id = s.page_id WHERE s.material_id IN ({marks}) "
                "ORDER BY p.title",
                chunk,
            ):
                if row["kind"] == "note":
                    notes.setdefault(row["material_id"], row["page_id"])
                elif row["kind"] == "concept":
                    concepts[row["material_id"]] = concepts.get(row["material_id"], 0) + 1
    result: dict[str, MaterialWiki] = {}
    for material_id in ids:
        job = latest.get(material_id)
        note = notes.get(material_id)
        count = concepts.get(material_id, 0)
        job_id, job_state, job_error, job_code = job if job else (None, None, None, None)
        error = job_error if job_state in _FAILED else None
        code = job_code if job_state in _FAILED else None
        if job_state == "running":
            state: WikiState = "processing"
        elif note is not None or count:
            state = "in_wiki"
        elif job_state in _FAILED:
            state = "failed"
        else:
            state = "not_in_wiki"
        result[material_id] = MaterialWiki(state, note, count, job_id, error, code)
    return result


def read_translation(material_dir: Path) -> Translation | None:
    """``.skaz/translation.md`` as paragraphs, or ``None`` when the material has no translation."""
    path = material_dir / SERVICE_DIR / TRANSLATION_FILE
    try:
        if path.stat().st_size > MAX_TRANSLATION_BYTES:
            log.warning("Translation of %s is too large to show inline", _material_id(material_dir))
            return None
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError):
        log.warning("Translation of %s can't be read", _material_id(material_dir))
        return None
    try:
        _raw, fields, body = split_frontmatter(text)
    except FrontmatterError:
        fields, body = {}, text
    language = fields.get("language")
    paragraphs = []
    for block in re.split(r"\n\s*\n", body.strip()):
        if not block.strip():
            continue
        speaker = None
        match = _SPEAKER.match(block)
        if match is not None:
            speaker = match.group(1).strip()
            block = block[match.end():]
        content = " ".join(block.split())
        if content:
            paragraphs.append(TranslationParagraph(None, speaker, content))
    if not paragraphs:
        return None
    return Translation(str(language) if language else None, tuple(paragraphs))


def excluded_count(material_dir: Path) -> int:
    """How many fragments are excluded from processing ("excluded fragments: N", decision 41)."""
    try:
        return len(read_excluded(material_dir))
    except ExclusionsUnreadable:
        log.warning("Exclusions of %s can't be read", _material_id(material_dir))
        return 0


def _material_id(material_dir: Path) -> str:
    """The material's id for a log line (its folder is named after its title, which is never logged)."""
    try:
        value = read_json(material_dir / MATERIAL_MANIFEST).get("id")
    except (OSError, ValueError, UnicodeDecodeError, AttributeError):
        return "a material with an unreadable manifest"
    return value if isinstance(value, str) else "a material without an id"
