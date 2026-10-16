"""Export (decision B20): the wiki as plain Markdown plus the materials' ``.md`` into a chosen folder.

* Wiki pages keep their layout (``Wiki/Concepts/<Title>.md`` …) and their ``[[wikilinks]]``,
  so links between pages and to materials resolve inside the export as they do in the library.
* SKAZ's own markup goes: block markers (``%% skaz:block … %%``), block ids (``^c-…``) and
  the SKAZ frontmatter keys; a page keeps ``title`` and ``aliases``.
* Every citation becomes a Markdown footnote at its sentence: ``[^n]`` in the text and
  ``[^n]: [[Materials/<Folder>/<Title>/<File>#^seg-12|<Title> · 08:12]] — “<verbatim quote>”``
  at the end of the page. The marker is the truth (a citation whose link was edited away still
  gets its footnote); a source deleted since says so instead of a link.
* Materials: each material's Markdown files (``^seg-N`` paragraph ids stay — they are plain
  Obsidian block ids the footnotes point at), with only ``title`` left in the frontmatter.
* Never written: ``.skaz`` folders, ``material.json``, the database, original media.

The target is refused inside the library (or SKAZ's data folder), and a non-empty folder only
with the user's confirmation; files with the same names are then replaced, others stay.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from ..errors import KnowledgeError
from ..library.fsio import IGNORABLE_ENTRIES, visible_entries, write_atomic
from ..library.layout import SERVICE_DIR
from ..markdown.frontmatter import FrontmatterError, render_frontmatter, split_frontmatter
from ..markdown.page import Block, Cite, Heading, PageDocument, PageFormatError, RawText, parse_page
from ..markdown.text import format_timestamp
from ..service import KnowledgeService

_CITATION_LINK = re.compile(r"[ \t]?\[\[(Materials/[^\]|#\n]*)#\^seg-(\d+)\|[^\]\n]*\]\]")
_SKAZ_COMMENT = re.compile(r"^[ \t]*%% skaz:[^\n]*%%[ \t]*\r?\n?", re.MULTILINE)
_FENCE_LINE = re.compile(r" {0,3}(`{3,}|~{3,})\s*")
_SKAZ_KEYS = frozenset({"skaz_id", "kind", "folders", "sources", "language", "original"})


class ExportRefused(KnowledgeError):
    status_code = 409


@dataclass(frozen=True)
class ExportTarget:
    path: str
    #: ``None``: the folder may be used (after a confirmation when ``non_empty``).
    reason: str | None
    non_empty: bool
    entries: int


@dataclass(frozen=True)
class ExportResult:
    path: str
    pages: int
    materials: int
    footnotes: int


@dataclass(frozen=True)
class SourceInfo:
    #: ``Materials/<Folder>/<Title>/<File>`` (no ``.md``): where the material's text is in the export.
    target: str
    title: str
    start_ms: dict[int, int | None]
    page: dict[int, int | None]


def check_target(kb: KnowledgeService, raw: str) -> ExportTarget:
    """Whether ``raw`` may receive an export; never creates or changes anything."""
    if not raw or not os.path.isabs(raw) or "\x00" in raw:
        return ExportTarget(raw, "Choose a folder on this Mac.", False, 0)
    path = Path(raw).resolve()
    shown = str(path)
    library = kb.require()
    root = library.root.resolve()
    if path == root or root in path.parents:
        reason = "Choose a folder outside the SKAZ library: the export is a separate copy."
        return ExportTarget(shown, reason, False, 0)
    data = kb.data_dir.resolve()
    if path == data or data in path.parents:
        return ExportTarget(shown, "Choose a folder outside SKAZ's own data folder.", False, 0)
    if not kb._inside_sandbox(path):  # development and smoke runs keep to their own Documents
        return ExportTarget(shown, "Choose a folder inside this profile's Documents folder.", False, 0)
    if not path.exists():
        if not path.parent.is_dir():
            return ExportTarget(shown, "That folder doesn't exist.", False, 0)
        return ExportTarget(shown, None, False, 0)
    if not path.is_dir():
        return ExportTarget(shown, "That is a file, not a folder.", False, 0)
    try:
        entries = len(visible_entries(path))
    except OSError:
        return ExportTarget(shown, "SKAZ can't read that folder. Choose another one.", False, 0)
    return ExportTarget(shown, None, entries > 0, entries)


def _strip_skaz(text: str) -> str:
    return _SKAZ_COMMENT.sub("", text)


def _plain_frontmatter(text: str, title: str, aliases: tuple[str, ...] = ()) -> str:
    """``text`` with SKAZ's frontmatter replaced by ``title`` (and ``aliases``) only."""
    body = text
    try:
        _raw, fields, body = split_frontmatter(text)
    except FrontmatterError:
        fields = {}
    keep = {key: value for key, value in fields.items() if key not in _SKAZ_KEYS and key != "title"}
    head: dict[str, object] = {"title": title}
    if aliases:
        head["aliases"] = list(aliases)
    head.update(keep)
    return render_frontmatter(head) + "\n" + body.lstrip("\n")


def _label(source: SourceInfo, seg: int) -> str:
    start = source.start_ms.get(seg)
    if start is not None:
        return f"{source.title} · {format_timestamp(start)}"
    page = source.page.get(seg)
    return f"{source.title} · p. {page}" if page is not None else source.title


class _Footnotes:
    """One number per distinct (material, fragment, quote) of a page, in reading order."""

    def __init__(self, source_of: Callable[[str], SourceInfo | None]) -> None:
        self._source_of = source_of
        self._numbers: dict[tuple[str, int, str | None], int] = {}
        self.lines: list[str] = []

    def ref(self, cite: Cite) -> str:
        key = (cite.material_id, cite.seg, cite.quote)
        number = self._numbers.get(key)
        if number is None:
            number = len(self._numbers) + 1
            self._numbers[key] = number
            source = self._source_of(cite.material_id)
            where = (
                f"[[{source.target}#^seg-{cite.seg}|{_label(source, cite.seg)}]]"
                if source is not None else "A source that is no longer in the library"
            )
            quote = " ".join(cite.quote.split()) if cite.quote else ""
            self.lines.append(f"[^{number}]: {where}" + (f" — “{quote}”" if quote else ""))
        return f"[^{number}]"


def _block_text(block: Block, notes: _Footnotes, source_of: Callable[[str], SourceInfo | None]) -> str:
    """The block's Markdown with each citation link turned into a footnote at its place."""
    used: set[Cite] = set()

    def cite_for(target: str, seg: int) -> Cite | None:
        candidates = [cite for cite in block.cites if cite.seg == seg and cite not in used]
        for cite in candidates:
            source = source_of(cite.material_id)
            if source is not None and target.rsplit("/", 1)[0] == source.target.rsplit("/", 1)[0]:
                return cite
        return candidates[0] if len(candidates) == 1 else None

    def replace(match: re.Match[str]) -> str:
        cite = cite_for(match.group(1), int(match.group(2)))
        if cite is None:
            return match.group(0)  # a hand-made link without a citation: an ordinary link
        used.add(cite)
        return notes.ref(cite)

    body = _CITATION_LINK.sub(replace, block.body)
    rest = "".join(notes.ref(cite) for cite in block.cites if cite not in used)
    if rest:
        last = body.rstrip().rsplit("\n", 1)[-1]
        # A table row or a code fence can't carry a footnote mark: it goes on its own line.
        own_line = last.lstrip().startswith("|") or bool(_FENCE_LINE.fullmatch(last))
        body = body.rstrip() + ("\n\n" if own_line else "") + rest
    return body + "\n"


def export_page(document: PageDocument, source_of: Callable[[str], SourceInfo | None]) -> tuple[str, int]:
    """A wiki page as plain Markdown with footnotes; returns ``(text, footnote count)``."""
    notes = _Footnotes(source_of)
    out: list[str] = []
    for part in document.parts:
        if isinstance(part, Block):
            out.append(_block_text(part, notes, source_of))
        elif isinstance(part, Heading):
            out.append(part.render())
        elif isinstance(part, RawText):
            out.append(_strip_skaz(part.text))
    text = "".join(out).rstrip("\n") + "\n"
    if notes.lines:
        text += "\n" + "\n".join(notes.lines) + "\n"
    head: dict[str, object] = {"title": document.meta.title}
    if document.meta.aliases:
        head["aliases"] = list(document.meta.aliases)
    return render_frontmatter(head) + "\n" + text.lstrip("\n"), len(notes.lines)


def _sources(kb: KnowledgeService) -> Callable[[str], SourceInfo | None]:
    cache: dict[str, SourceInfo | None] = {}

    def source_of(material_id: str) -> SourceInfo | None:
        if material_id not in cache:
            record = kb.material_repo.get(material_id)
            if record is None:
                cache[material_id] = None
            else:
                fragments = kb.material_repo.fragments(material_id)
                cache[material_id] = SourceInfo(
                    target=record.source_file.removesuffix(".md"), title=record.title,
                    start_ms={f.seg: f.start_ms for f in fragments}, page={f.seg: f.page for f in fragments},
                )
        return cache[material_id]

    return source_of


def _write(dest: Path, rel: str, text: str) -> None:
    target = (dest / rel).resolve()
    if dest != target and dest not in target.parents:  # a crafted name never leaves the export folder
        raise ExportRefused("A file name points outside the export folder; nothing more was written.")
    target.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(target, text.encode("utf-8"))


def _material_files(directory: Path) -> list[Path]:
    """The material's Markdown files; nothing from ``.skaz``, no media."""
    return sorted(
        path for path in directory.iterdir()
        if path.is_file() and path.suffix.lower() == ".md" and path.name not in IGNORABLE_ENTRIES
        and not path.name.startswith(".")
    )


def export_library(
    kb: KnowledgeService, raw: str, *, overwrite: bool, progress: Callable[[int, int], None] | None = None
) -> ExportResult:
    target = check_target(kb, raw)
    if target.reason is not None:
        raise ExportRefused(target.reason)
    if target.non_empty and not overwrite:
        raise ExportRefused("The folder isn't empty. Confirm to replace files with the same names.")
    dest = Path(target.path)
    dest.mkdir(parents=True, exist_ok=True)
    library = kb.require()
    pages = kb.pages()
    materials = kb.material_repo.list_all()
    total = len(pages) + len(materials) + 2
    done = 0
    source_of = _sources(kb)
    footnotes = 0

    def step() -> None:
        nonlocal done
        done += 1
        if progress is not None:
            progress(done, total)

    for page in pages:
        path = library.root / page.rel_path
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            step()
            continue
        try:
            plain, count = export_page(parse_page(text), source_of)
        except PageFormatError:
            plain, count = _plain_frontmatter(_strip_skaz(text), page.title), 0
        footnotes += count
        _write(dest, page.rel_path, plain)
        step()
    for name in ("index.md", "log.md"):
        path = library.wiki_dir / name
        if path.is_file():
            _write(dest, f"{library.relative(path)}", _strip_skaz(path.read_text(encoding="utf-8")))
        step()
    exported = 0
    for material in materials:
        directory = library.root / material.rel_dir
        if directory.is_dir() and SERVICE_DIR not in Path(material.rel_dir).parts:
            for path in _material_files(directory):
                text = _plain_frontmatter(path.read_text(encoding="utf-8"), material.title)
                _write(dest, library.relative(path), text)
            exported += 1
        step()
    return ExportResult(str(dest), len(pages), exported, footnotes)


# -- chosen items (0.3.1 F5) ----------------------------------------------------------------

ItemType = Literal["chat", "page", "material"]


@dataclass(frozen=True)
class ItemsResult:
    #: ``(type, id, file)``: the file is relative to the chosen folder (a material's main ``.md``).
    written: list[tuple[ItemType, str, str]]
    #: ``(type, id, reason)`` in plain English.
    skipped: list[tuple[ItemType, str, str]]


@dataclass(frozen=True)
class ChatFile:
    file_name: str
    markdown: str


def export_items(
    kb: KnowledgeService,
    raw: str,
    items: Sequence[tuple[ItemType, str]],
    *,
    overwrite: bool,
    chats: Mapping[str, ChatFile | str],
) -> ItemsResult:
    """Chosen pages, materials and chats as ``.md`` into ``raw``, same refusals as :func:`export_library`.

    Pages and materials are written exactly as the whole-library export writes them (same paths,
    footnotes, frontmatter), so a later full export into the same folder agrees with them; chats go
    to ``Chats/<title>.md`` (``chats`` holds each chat's rendered Markdown, or why it can't be).
    The same item twice is written once; an unknown id is skipped with its reason.
    """
    target = check_target(kb, raw)
    if target.reason is not None:
        raise ExportRefused(target.reason)
    if target.non_empty and not overwrite:
        raise ExportRefused("The folder isn't empty. Confirm to replace files with the same names.")
    dest = Path(target.path)
    dest.mkdir(parents=True, exist_ok=True)
    library = kb.require()
    source_of = _sources(kb)
    written: list[tuple[ItemType, str, str]] = []
    skipped: list[tuple[ItemType, str, str]] = []
    seen: set[tuple[str, str]] = set()
    chat_names: set[str] = set()
    for kind, item_id in items:
        if (kind, item_id) in seen:
            continue
        seen.add((kind, item_id))
        if kind == "page":
            page = kb.page_repo.get(item_id)
            if page is None:
                skipped.append((kind, item_id, "Page not found."))
                continue
            try:
                text = (library.root / page.rel_path).read_text(encoding="utf-8")
            except FileNotFoundError:
                skipped.append((kind, item_id, "Its file isn't in the library any more."))
                continue
            try:
                plain, _count = export_page(parse_page(text), source_of)
            except PageFormatError:
                plain = _plain_frontmatter(_strip_skaz(text), page.title)
            _write(dest, page.rel_path, plain)
            written.append((kind, item_id, page.rel_path))
        elif kind == "material":
            material = kb.material_repo.get(item_id)
            if material is None:
                skipped.append((kind, item_id, "Material not found."))
                continue
            directory = library.root / material.rel_dir
            usable = directory.is_dir() and SERVICE_DIR not in Path(material.rel_dir).parts
            files = _material_files(directory) if usable else []
            if not files:
                skipped.append((kind, item_id, "Its text isn't in the library yet."))
                continue
            for path in files:
                plain = _plain_frontmatter(path.read_text(encoding="utf-8"), material.title)
                _write(dest, library.relative(path), plain)
            written.append((kind, item_id, material.source_file))
        else:
            chat = chats.get(item_id)
            if chat is None or isinstance(chat, str):
                skipped.append((kind, item_id, chat or "Chat not found."))
                continue
            name = _unique(chat.file_name, chat_names)
            _write(dest, f"Chats/{name}", chat.markdown)
            written.append((kind, item_id, f"Chats/{name}"))
    return ItemsResult(written, skipped)


def _unique(name: str, taken: set[str]) -> str:
    """Two chats with the same title in one export: ``Title.md``, ``Title (2).md`` …"""
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, "md"
    candidate, n = name, 1
    while candidate.lower() in taken:
        n += 1
        candidate = f"{stem} ({n}).{ext}"
    taken.add(candidate.lower())
    return candidate
