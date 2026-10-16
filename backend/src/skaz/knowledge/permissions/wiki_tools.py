"""The four wiki tools of chat agents (decisions P1, P2, P4; contract of phase P).

``skaz_wiki_create_page``, ``skaz_wiki_edit_page``, ``skaz_wiki_rename_page`` and
``skaz_wiki_delete_page`` take page ids and block ids — never paths — so nothing
outside ``Wiki/`` can be named (``Materials/`` and ``.skaz/`` are out of reach by
construction). Each call:

1. is checked before the user is asked: the page exists and is not ``index``/``log``;
   the user's own notes (``user``, ``user_edited``, unmarked paragraphs, blocks edited
   outside SKAZ) are never changed or removed; every citation is checked mechanically
   like ingest's layer 4 (the fragment exists, is not excluded, and holds the quote
   verbatim, at least ``MIN_QUOTE_CHARS`` long) — a block with an unchecked citation is
   refused with the reason; text that reads like instructions to an AI is refused
   (layer 5); model text is made inert for the page format (no wikilinks, no ``%%``);
2. waits for the user through :class:`~.broker.PermissionBroker` (no timeout);
3. is applied by SKAZ's own writer under the library write lock (markers, ``owner=agent``,
   block hashes, B3), re-checked against the file as it is then; the files it touches
   are kept as they were before, so Undo can put them back while nobody changed them.

The agent gets ``{"status": "applied" | "denied" | "cancelled", "reason"?, "page_id"?}``.
"""
from __future__ import annotations

import base64
import hashlib
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, model_validator

from ...native_io import disk_call
from ..agents.tools import SkazTool, ToolContext, ToolInputError, _Args
from ..chats.resolve import MaterialReader
from ..errors import KnowledgeError, NotFound
from ..ids import new_id
from ..ingest.checks import MIN_QUOTE_CHARS, clean_text, clean_title
from ..ingest.pages import SourceRef, insert_into_section, spaced
from ..ingest.protocols import IdentityTextLayer, TextLayer
from ..library.fsio import write_atomic
from ..library.names import validate_name
from ..markdown.page import Block, BlockKind, Cite, PageDocument, PageMeta, Part, parse_page
from ..markdown.text import name_key
from ..service import KnowledgeService
from ..sources.guard.detector import detect_instruction
from ..wiki.edit import readable_text
from ..wiki.graph import NAV_IDS
from ..wiki.page_ops import _linking_pages
from ..wiki.pages_io import PageChanging, forget_page, is_user_part, page_path, reindex, rewrite, user_parts
from ..wiki.service import WikiService
from .broker import PermissionBroker, PermissionConflict, Verdict
from .store import PermissionKind, PermissionRecord, RunRef

log = logging.getLogger(__name__)

AgentBlockKind = Literal["from_source", "connection", "explanation"]
NewPageKind = Literal["concept", "note", "analysis"]
WIKI_TOOL_NAMES = (
    "skaz_wiki_create_page", "skaz_wiki_edit_page", "skaz_wiki_rename_page", "skaz_wiki_delete_page",
)
SERVICE_FILES = frozenset({"Wiki/index.md", "Wiki/log.md"})
MAX_BLOCK_CHARS = 4_000
MAX_CHANGES = 50
LABELS = {"add": "Added", "replace": "Changed", "remove": "Removed"}

NOT_IN_CHAT = "Wiki changes are only possible in a chat with the user."
INDEX_LOG = "Wiki/index.md and Wiki/log.md are written by SKAZ; agents can't change them."
USER_NOTE = "Block {block} is the user's own note: it stays untouched. Add a new block instead."
NAVIGATION = "Block {block} is navigation SKAZ writes itself; leave it."
INSTRUCTIONS = "{label}: the text reads like instructions to an AI, so SKAZ won't put it in the wiki."
CHANGED = ("“{title}” changed before the change could be applied, so nothing was changed. "
           "Read the page again.")
UNDO_CHANGED = "“{title}” changed after the agent's change, so SKAZ can't undo it any more."
NOT_UNDOABLE = "Only an applied change can be undone."
DENIED = "The user declined this change."
CANCELLED = "The request was cancelled."


# -- arguments ------------------------------------------------------------------------------------


class CitationIn(_Args):
    material_id: str = Field(min_length=1, max_length=120, description="Material id (mat-…).")
    seg: int = Field(ge=1, le=10_000_000, description="Fragment number (the N in seg-N).")
    quote: str = Field(min_length=1, max_length=2_000,
                       description="The exact words of that fragment the block relies on, copied verbatim.")


class BlockIn(_Args):
    text: str = Field(min_length=1, max_length=MAX_BLOCK_CHARS,
                      description="One paragraph of plain Markdown; citations go in `citations`.")
    kind: AgentBlockKind | None = Field(
        default=None, description="from_source = stated in a cited source (default when cited); connection = "
                                  "your inference between two cited fragments; explanation = your own words, "
                                  "no citations (default when nothing is cited).")
    citations: list[CitationIn] = Field(default_factory=list, max_length=8)


class CreatePageArgs(_Args):
    title: str = Field(min_length=1, max_length=120, description="Human page title (also the file name).")
    kind: NewPageKind = Field(description="concept (a term), note (notes on a material) or analysis.")
    blocks: list[BlockIn] = Field(min_length=1, max_length=MAX_CHANGES)


class ChangeIn(_Args):
    op: Literal["add", "replace", "remove"]
    block_id: str | None = Field(default=None, min_length=1, max_length=120,
                                 description="The block to replace or remove (c-… from skaz_read_page).")
    after_block_id: str | None = Field(default=None, min_length=1, max_length=120,
                                       description="add: put the new block right after this one "
                                                   "(else at the end of its section).")
    text: str | None = Field(default=None, min_length=1, max_length=MAX_BLOCK_CHARS)
    kind: AgentBlockKind | None = None
    citations: list[CitationIn] | None = Field(default=None, max_length=8)

    @model_validator(mode="after")
    def _shape(self) -> ChangeIn:
        if self.op in ("replace", "remove") and self.block_id is None:
            raise ValueError(f"{self.op} needs block_id.")
        if self.op in ("add", "replace") and self.text is None:
            raise ValueError(f"{self.op} needs text.")
        if self.op == "remove" and (self.text is not None or self.citations):
            raise ValueError("remove takes only block_id.")
        if self.op != "add" and self.after_block_id is not None:
            raise ValueError("after_block_id is only for add.")
        return self


class EditPageArgs(_Args):
    page_id: str = Field(min_length=1, max_length=120)
    changes: list[ChangeIn] = Field(min_length=1, max_length=MAX_CHANGES)


class RenamePageArgs(_Args):
    page_id: str = Field(min_length=1, max_length=120)
    title: str = Field(min_length=1, max_length=120)


class DeletePageArgs(_Args):
    page_id: str = Field(min_length=1, max_length=120)


# -- plans ------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class FileState:
    """One file an applied change touched: its bytes before (``None`` = absent) and its hash after."""

    rel: str
    before: bytes | None
    after_sha: str | None

    def to_json(self) -> dict[str, Any]:
        return {"rel": self.rel, "after_sha": self.after_sha,
                "before": base64.b64encode(self.before).decode("ascii") if self.before is not None else None}

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> FileState:
        raw = data.get("before")
        return cls(str(data["rel"]), base64.b64decode(raw) if isinstance(raw, str) else None,
                   data.get("after_sha") if isinstance(data.get("after_sha"), str) else None)


@dataclass
class Plan:
    kind: PermissionKind
    page_id: str | None
    title: str
    preview: dict[str, Any]
    #: Applies the change (worker thread, under the write lock); returns the page id.
    apply: Callable[[], str]
    #: Files the change may touch (absolute), snapshotted right before ``apply``.
    touched: Callable[[], list[Path]] = field(default=lambda: [])


def _sha(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


def _read(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def _change(op: str, block: Block | None, before: str | None, after: str | None) -> dict[str, Any]:
    return {"op": op, "block_id": block.id if block is not None else None, "label": LABELS[op],
            "before": before, "after": after, "block_kind": block.kind if block is not None else None}


def _summary(changes: Sequence[dict[str, Any]]) -> dict[str, Any]:
    count = {op: sum(1 for change in changes if change["op"] == op) for op in LABELS}
    return {"added": count["add"], "changed": count["replace"], "removed": count["remove"],
            "user_notes_untouched": True}


class WikiEditor:
    """The wiki tools' work: checks, the user's decision, the change by SKAZ's writer, Undo."""

    def __init__(self, kb: KnowledgeService, wiki: WikiService, broker: PermissionBroker, *,
                 language: Callable[[], str], text_layer: Callable[[], TextLayer] | None = None) -> None:
        self.kb = kb
        self.wiki = wiki
        self.broker = broker
        self._language = language
        self._text_layer = text_layer or (lambda: IdentityTextLayer())
        #: The chat answer behind a run id; set by the chat service (``ChatService.run_ref``).
        self.runs: Callable[[str], RunRef | None] = lambda _run_id: None

    # -- tools ------------------------------------------------------------------------------------

    def tools(self) -> tuple[SkazTool, ...]:
        waits = (" The user is asked first (Allow / Allow in this chat / Deny) and you wait for the "
                 "answer; the result says applied, denied (with the user's reason) or cancelled.")
        return (
            SkazTool("skaz_wiki_create_page",
                     "Propose a new wiki page (concept, note or analysis) with its blocks." + waits,
                     CreatePageArgs, run=self._tool(self.plan_create), timeout_s=None),
            SkazTool("skaz_wiki_edit_page",
                     "Propose changes to blocks of a wiki page by block id: add, replace or remove the "
                     "agent's "
                     "blocks. The user's own notes can't be changed or removed." + waits,
                     EditPageArgs, run=self._tool(self.plan_edit), timeout_s=None),
            SkazTool("skaz_wiki_rename_page",
                     "Propose a new title for a wiki page; links to it follow." + waits,
                     RenamePageArgs, run=self._tool(self.plan_rename), timeout_s=None),
            SkazTool("skaz_wiki_delete_page",
                     "Propose deleting a wiki page (links to it are unlinked, sources stay); always asks."
                     + waits,
                     DeletePageArgs, run=self._tool(self.plan_delete), timeout_s=None),
        )

    def _tool(self, planner: Callable[[RunRef, Any], Plan]) -> Callable[[ToolContext | None, Any], Any]:
        async def run(context: ToolContext | None, args: Any) -> dict[str, Any]:
            ref = self.runs(context.run_id) if context is not None else None
            if ref is None:
                raise ToolInputError(NOT_IN_CHAT)
            plan = await disk_call(planner, ref, args)
            return await self.ask_and_apply(ref, plan)

        return run

    async def ask_and_apply(self, ref: RunRef, plan: Plan) -> dict[str, Any]:
        verdict: Verdict = await self.broker.request(ref, plan.kind, page_id=plan.page_id, title=plan.title,
                                                     preview=plan.preview)
        record = verdict.permission
        if verdict.status == "denied":
            return {"status": "denied", "reason": record.reason or DENIED}
        if verdict.status != "allowed":
            return {"status": "cancelled", "reason": record.reason or CANCELLED}
        try:
            page_id, states = await disk_call(self._apply, plan)
        except (KnowledgeError, ToolInputError, OSError, ValueError) as error:
            reason = CHANGED.format(title=plan.title)
            await self.broker.settle(record.id, status="cancelled", reason=reason)
            log.info("Permission %s could not be applied (%s)", record.id, type(error).__name__)
            return {"status": "cancelled", "reason": reason}
        await self.broker.settle(record.id, applied=True, page_id=page_id,
                                 undo={"files": [state.to_json() for state in states]})
        log.info("Permission %s applied (%s)", record.id, plan.kind)
        return {"status": "applied", "page_id": page_id}

    def _apply(self, plan: Plan) -> tuple[str, list[FileState]]:
        library = self.kb.require()
        with self.wiki.write_lock:
            touched = list(dict.fromkeys(plan.touched()))
            before = {path: _read(path) for path in touched}
            page_id = plan.apply()
            touched += [path for path in self._paths_of(page_id) if path not in before]
            states = [FileState(library.relative(path), before.get(path), _sha(path)) for path in touched]
        self.wiki.after_change()
        return page_id, states

    def _paths_of(self, page_id: str) -> list[Path]:
        record = self.kb.page_repo.get(page_id)
        return [self.kb.require().root / record.rel_path] if record is not None else []

    # -- checks -----------------------------------------------------------------------------------

    def _page(self, page_id: str) -> tuple[Path, PageDocument, str]:
        record = self.kb.page_repo.get(page_id)
        if record is None:
            raise ToolInputError("Page not found. Use skaz_wiki_index or skaz_search to find its id.")
        if record.rel_path in SERVICE_FILES or not record.rel_path.startswith("Wiki/"):
            raise ToolInputError(INDEX_LOG)
        try:
            _library, path = page_path(self.kb, page_id)
            document = parse_page(path.read_bytes().decode("utf-8"))
        except (NotFound, OSError, UnicodeDecodeError, ValueError) as error:
            raise ToolInputError("This page can't be read right now.") from error
        return path, document, record.rel_path

    def _block(self, spec: BlockIn | ChangeIn, label: str, reader: MaterialReader, block_id: str,
               cited: dict[str, None]) -> Block:
        text = clean_text(spec.text or "")
        if not text:
            raise ToolInputError(f"{label}: the text is empty.")
        if detect_instruction(text) is not None:
            raise ToolInputError(INSTRUCTIONS.format(label=label))
        citations = list(spec.citations or [])
        kind: BlockKind = spec.kind or ("from_source" if citations else "explanation")
        if kind == "explanation" and citations:
            raise ToolInputError(f"{label}: an explanation carries no citations; use kind from_source.")
        cites: list[Cite] = []
        links: list[str] = []
        for citation in citations:
            ref = f"{citation.material_id}:seg-{citation.seg}"
            source = reader.source(citation.material_id)
            if source is None or reader.fragment(citation.material_id, citation.seg) is None:
                raise ToolInputError(f"{label}: {ref} is not a fragment SKAZ can cite (unknown or excluded).")
            checked = reader.checked_quote(citation.material_id, citation.seg, citation.quote)
            if checked is None:
                raise ToolInputError(
                    f"{label}: the quote for {ref} is not verbatim in that fragment (or is shorter than "
                    f"{MIN_QUOTE_CHARS} characters). Copy the exact words, or drop the citation.")
            cite = Cite(citation.material_id, citation.seg, checked)
            if cite in cites:
                continue
            cites.append(cite)
            cited.setdefault(citation.material_id, None)
            link = SourceRef(material_id=citation.material_id, folder_name=source.folder_name,
                             title=source.title, file_stem=source.files.source_path.stem,
                             start_ms={f.seg: f.start_ms for f in source.fragments},
                             page={f.seg: f.page for f in source.fragments}).link(citation.seg)
            if link not in links:
                links.append(link)
        if kind == "from_source" and not cites:
            raise ToolInputError(f"{label}: a from_source block needs at least one citation.")
        if kind == "connection" and len({(cite.material_id, cite.seg) for cite in cites}) < 2:
            raise ToolInputError(f"{label}: a connection needs two cited fragments (its two sides).")
        body = " ".join([text, *links])
        return Block.create(block_id, kind, body, cites=tuple(cites))

    def _reader(self) -> MaterialReader:
        return MaterialReader(self.kb, self._text_layer())

    # -- create -----------------------------------------------------------------------------------

    def plan_create(self, ref: RunRef, args: CreatePageArgs) -> Plan:
        title = clean_title(args.title)
        try:
            title = validate_name(title)
        except KnowledgeError as error:
            raise ToolInputError(f"This title can't be a page name: {error.message}") from error
        if detect_instruction(title) is not None:
            raise ToolInputError(INSTRUCTIONS.format(label="The title"))
        library = self.kb.require()
        directory = library.page_directory(args.kind)
        taken = next((page for page in self.kb.page_repo.list_all()
                      if Path(page.rel_path).parent == Path(library.relative(directory))
                      and name_key(Path(page.rel_path).stem) == name_key(title)), None)
        if taken is not None or (directory / f"{title}.md").exists():
            hint = f" (page_id {taken.id}); change it with skaz_wiki_edit_page" if taken else ""
            raise ToolInputError(f"A page named “{title}” already exists{hint}.")
        reader = self._reader()
        cited: dict[str, None] = {}
        blocks = [self._block(spec, f"Block {number}", reader, new_id("c"), cited)
                  for number, spec in enumerate(args.blocks, start=1)]
        language = self._language()
        parts: list[Part] = []
        for block in blocks:
            insert_into_section(parts, block.kind, language, [block])
        folders: dict[str, None] = {}
        for material_id in cited:
            material = self.kb.material_repo.get(material_id)
            if material is not None:
                folders.setdefault(material.folder_id, None)
        meta = PageMeta(skaz_id=new_id("pg"), kind=args.kind, title=title, language=language,
                        folders=tuple(folders), sources=tuple(cited), extra={"skaz_chat": ref.chat_id})
        document = PageDocument(meta=meta, parts=spaced(parts))
        changes = [_change("add", block, None, readable_text(block.body)) for block in blocks]
        preview = {"summary": _summary(changes), "changes": changes,
                   "path": f"{library.relative(directory)}/{title}.md"}

        def apply() -> str:
            self.kb.create_page(document)
            return meta.skaz_id

        return Plan("create", None, title, preview, apply,
                    touched=lambda: [library.page_directory(args.kind) / f"{title}.md"])

    # -- edit -------------------------------------------------------------------------------------

    def plan_edit(self, ref: RunRef, args: EditPageArgs) -> Plan:
        path, document, rel = self._page(args.page_id)
        reader = self._reader()
        language = document.meta.language or self._language()
        built: list[tuple[ChangeIn, Block | None]] = []
        for number, change in enumerate(args.changes, start=1):
            label = f"Change {number}"
            if change.op == "remove":
                built.append((change, None))
                continue
            block_id = change.block_id if change.op == "replace" and change.block_id else new_id("c")
            built.append((change, self._block(change, label, reader, block_id, {})))
        # The same changes on the page as it is now: refused here, re-checked when applied.
        _updated, changes = _apply_changes(document, built, language)
        preview = {"summary": _summary(changes), "changes": changes, "path": rel}
        title = document.meta.title or path.stem
        page_id = args.page_id

        def apply() -> str:
            library, current = page_path(self.kb, page_id)

            def build(doc: PageDocument) -> PageDocument:
                try:
                    return _apply_changes(doc, built, language)[0]
                except ToolInputError as error:
                    raise PageChanging(CHANGED.format(title=title)) from error

            rewrite(library, current, build)
            reindex(self.kb, library, current)
            return page_id

        return Plan("edit", page_id, title, preview, apply, touched=lambda: self._paths_of(page_id))

    # -- rename -------------------------------------------------------------------------------------

    def plan_rename(self, ref: RunRef, args: RenamePageArgs) -> Plan:
        path, document, rel = self._page(args.page_id)
        try:
            title = validate_name(clean_title(args.title))
        except KnowledgeError as error:
            raise ToolInputError(f"This title can't be a page name: {error.message}") from error
        if detect_instruction(title) is not None:
            raise ToolInputError(INSTRUCTIONS.format(label="The title"))
        if title == path.stem:
            raise ToolInputError("The page already has this title.")
        target = path.with_name(f"{title}.md")
        if name_key(target.name) != name_key(path.name) and target.exists():
            raise ToolInputError(f"A page named “{title}” already exists here.")
        linking = _linking_pages(self.kb, self.wiki.graph, args.page_id)
        old = document.meta.title or path.stem
        preview = {"summary": {"added": 0, "changed": 0, "removed": 0, "user_notes_untouched": True},
                   "changes": [], "path": rel, "new_title": title, "linking_pages": len(linking)}
        page_id = args.page_id

        def touched() -> list[Path]:
            root = self.kb.require().root
            linking = _linking_pages(self.kb, self.wiki.graph, page_id)
            others = [root / record.rel_path for record in (self.kb.page_repo.get(other) for other in linking)
                      if record is not None]
            return [*self._paths_of(page_id), target, *others]

        def apply() -> str:
            self.wiki.rename_page(page_id, title)
            return page_id

        return Plan("rename", page_id, old, preview, apply, touched=touched)

    # -- delete -------------------------------------------------------------------------------------

    def plan_delete(self, ref: RunRef, args: DeletePageArgs) -> Plan:
        path, document, rel = self._page(args.page_id)
        if user_parts(document):
            raise ToolInputError("This page holds the user's own notes, so an agent can't delete it. "
                                 "Ask the user to delete it themselves.")
        plan = self.wiki.page_delete_preview(args.page_id)
        changes = [_change("remove", block, readable_text(block.body), None) for block in document.blocks()]
        preview = {"summary": _summary(changes), "changes": changes, "path": rel,
                   "linking_pages": len(plan.linking), "links_unlinked": plan.links_unlinked}
        page_id = args.page_id
        title = document.meta.title or path.stem

        def touched() -> list[Path]:
            root = self.kb.require().root
            linking = _linking_pages(self.kb, self.wiki.graph, page_id)
            others = [root / record.rel_path for record in (self.kb.page_repo.get(other) for other in linking)
                      if record is not None]
            return [*self._paths_of(page_id), *others]

        def apply() -> str:
            _current, current_document, _rel = self._page(page_id)
            if user_parts(current_document):
                raise PageChanging(CHANGED.format(title=title))
            self.wiki.delete_page(page_id)
            return page_id

        return Plan("delete", page_id, title, preview, apply, touched=touched)

    # -- undo ---------------------------------------------------------------------------------------

    async def undo(self, permission_id: str) -> PermissionRecord:
        record = await disk_call(self.broker.get, permission_id)
        if record.status != "allowed" or not record.applied or not record.undo:
            raise PermissionConflict(NOT_UNDOABLE, "NOT_APPLIED")
        states = [FileState.from_json(item) for item in record.undo.get("files", [])
                  if isinstance(item, dict)]
        await disk_call(self._restore, record, states)
        updated = await self.broker.settle(record.id, expect=("allowed",), status="undone")
        if updated is None:
            raise PermissionConflict(NOT_UNDOABLE, "NOT_APPLIED")
        log.info("Permission %s undone (%s)", record.id, record.kind)
        return updated

    def _restore(self, record: PermissionRecord, states: Sequence[FileState]) -> None:
        library = self.kb.require()
        root = library.root.resolve()
        paths = []
        for state in states:
            path = (library.root / state.rel)
            if root not in path.resolve().parents or not state.rel.startswith("Wiki/"):
                raise PermissionConflict(UNDO_CHANGED.format(title=record.title), "CHANGED")
            paths.append((state, path))
        with self.wiki.write_lock:
            for state, path in paths:
                if _sha(path) != state.after_sha:
                    raise PermissionConflict(UNDO_CHANGED.format(title=record.title), "CHANGED")
            for state, path in paths:
                if state.before is None:
                    path.unlink(missing_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    write_atomic(path, state.before)
            for state, path in paths:
                if state.before is not None:
                    reindex(self.kb, library, path)
            page = self.kb.page_repo.get(record.page_id) if record.page_id else None
            if page is not None and not (library.root / page.rel_path).exists():
                forget_page(self.kb.db, page.id)  # an undone new page (or rename target) is gone again
        self.wiki.after_change()


def _locate(parts: Sequence[Part], block_id: str) -> int | None:
    return next((index for index, part in enumerate(parts)
                 if isinstance(part, Block) and part.id == block_id), None)


def _agent_block(parts: Sequence[Part], block_id: str) -> tuple[int, Block]:
    index = _locate(parts, block_id)
    if index is None:
        if block_id.startswith("u-"):
            raise ToolInputError(USER_NOTE.format(block=block_id))
        raise ToolInputError(f"Block {block_id} is not on this page. Read the page again.")
    block = parts[index]
    assert isinstance(block, Block)
    if is_user_part(block):
        raise ToolInputError(USER_NOTE.format(block=block_id))
    if block.id in NAV_IDS:
        raise ToolInputError(NAVIGATION.format(block=block_id))
    return index, block


def _apply_changes(document: PageDocument, built: Sequence[tuple[ChangeIn, Block | None]],
                   language: str) -> tuple[PageDocument, list[dict[str, Any]]]:
    """The page with the agent's changes, and the card's list of them; refuses touching the user's notes."""
    parts: list[Part] = list(document.parts)
    changes: list[dict[str, Any]] = []
    for change, block in built:
        if change.op == "remove":
            assert change.block_id is not None
            index, old = _agent_block(parts, change.block_id)
            del parts[index]
            changes.append(_change("remove", old, readable_text(old.body), None))
        elif change.op == "replace":
            assert change.block_id is not None and block is not None
            index, old = _agent_block(parts, change.block_id)
            parts[index] = block
            changes.append(_change("replace", block, readable_text(old.body), readable_text(block.body)))
        else:
            assert block is not None
            if change.after_block_id is not None:
                after = _locate(parts, change.after_block_id)
                if after is None:
                    raise ToolInputError(f"Block {change.after_block_id} is not on this page. "
                                         "Read the page again.")
                parts.insert(after + 1, block)
            else:
                insert_into_section(parts, block.kind, language, [block])
            changes.append(_change("add", block, None, readable_text(block.body)))
    return replace(document, parts=spaced(parts)), changes
