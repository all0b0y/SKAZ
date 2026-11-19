"""``runtime.kb_sources``: add documents, links and pasted text to the library (area S1).

Every path runs: extract → clean (layer 2) → fragments → instruction
detector (layer 3) → ``KnowledgeService.create_material`` (status
``processing``) → evidence and guard files in the material's ``.skaz/`` →
``ready`` (or ``failed`` with a reason). A derived title that is taken gets
`` (2)``…; a title the user typed is refused before anything is written.

Material ``.skaz/`` files written here:

* ``original.<ext>`` — the untouched input (PDF, HTML, pasted text, file);
* ``intake.json`` — extractor, failure reason, layer-2 findings;
* ``excluded.json`` — fragments kept out of processing and restore decisions.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import shutil
import stat
import threading
import weakref
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ...native_io import disk_call
from ..errors import KnowledgeError, NotFound
from ..ids import utc_now
from ..keyed_locks import KeyedLocks, KeyedThreadLocks
from ..library.fsio import dump_json, fsync_dir, read_json, write_atomic
from ..library.layout import SERVICE_DIR, STAGING_PATH
from ..library.library import MaterialFiles
from ..library.names import validate_name
from ..logsafe import error_note
from ..markdown.source import Fragment, MaterialKind, MaterialStatus, Origin
from ..markdown.text import block_hash, format_timestamp
from ..service import KnowledgeService
from . import web_page
from .duplicates import Duplicate, content_hash, find_duplicate, url_key
from .fetch import MAX_PAGE_BYTES, FetchFailed, LinkRejected, SafeFetcher, check_url
from .fragments import sanitize_title
from .guard import Detection, Finding, detect_instruction
from .guard.exclusions import (
    EXCLUDED_FILE,
    ExcludedFragment,
    ExclusionFile,
    FragmentLocation,
    RestoredFragment,
)
from .html import decode_html
from .intake import (
    Original,
    Prepared,
    SourceRejected,
    prepare_html,
    prepare_pdf,
    prepare_text,
    prepare_text_file,
)
from .links import LinkInfo, VideoProbe, classify_link, classify_offline, domain_of
from .material_info import INTAKE_FILE, wiki_states
from .native_intake041 import (
    FILE_CHANGED_MESSAGE,
    MAX_PREVIEW_EDGE,
    ImageFormat,
    NativeIntakePrepared,
    SelectionSource,
    TrustedFileSelection,
    classify_extension,
    decode_image,
    decode_verified_image,
    prepare_clipboard_image,
    prepare_docx_selection,
    prepare_image_selection,
    read_bounded_bytes,
    validate_trusted_selection,
)
from .paths import given_path
from .visual import (
    DEFAULT_FRAME_POLICY,
    DEFAULT_SEARCH_PDF_PAGES,
    FramePolicyConfig,
    FrameRetriever,
    PdfPageRenderer,
    PreparedVisual,
    RetainedFrameRecord,
    VisualFallbackSeam,
    VisualSourcePreparer,
)
from .web_page import WebPageUnavailable, page_key, prepare_web_page

log = logging.getLogger(__name__)

MAX_LINKED_PDF_BYTES = 100 * 1024 * 1024
EXCLUDED_NOTIFICATION = "excluded_instruction"
#: One lock for every ``excluded.json`` read-modify-write, shared by all ``SourceService``
#: instances (speech guards its materials through its own instance).
_GUARD_LOCK = threading.RLock()
RESTORE_LABEL = "This isn't an instruction — restore"
VIDEO_LINK = "This is a video link. Add it with the speech import (audio and video)."
MEDIA_FILE_LINK = (
    "This link points to an audio or video file. Add it with the speech import (audio and video)."
)


class IntakeRecord(BaseModel):
    """``.skaz/intake.json``."""

    model_config = ConfigDict(extra="allow")
    format: int = 1
    extractor: str
    failure: str | None = None
    hidden: list[Finding] = Field(default_factory=list)
    original: str | None = None
    created_at: str


@dataclass(frozen=True)
class GuardReport:
    material_id: str
    excluded: tuple[ExcludedFragment, ...]
    restored: tuple[RestoredFragment, ...]
    hidden: tuple[Finding, ...]
    failure: str | None


@dataclass(frozen=True)
class IntakeResult:
    material_id: str
    title: str
    status: str
    excluded_count: int
    hidden_count: int
    failure: str | None
    #: N2: the same DOI, address or file was already in the library — this is that material, nothing
    #: new was stored and no ingest was started.
    existing: bool = False


@dataclass(frozen=True)
class WebPageSaved:
    """W-3: the page's material; ``existing`` = this URL was already in the folder (nothing fetched)."""

    material_id: str
    existing: bool
    #: The new material's intake; ``None`` when ``existing``.
    result: IntakeResult | None


#: Wiki states after which "Add to wiki" on an already saved page starts ingest again.
_NOT_ADDED = frozenset({"not_in_wiki", "failed"})


@dataclass(frozen=True)
class SourceEvent:
    """``material_ready``: a new material can be processed into the wiki (W1).
    ``fragment_restored``: the user restored ``seg``; reprocess the material with it."""

    kind: Literal["material_ready", "fragment_restored"]
    material_id: str
    seg: int | None = None
    #: Decision 15: the user's "to wiki" choice for a new material; ``None`` = the wiki settings decide.
    to_wiki: bool | None = None


Listener = Callable[[SourceEvent], None]


def location_of(fragment: Fragment) -> FragmentLocation:
    return FragmentLocation(index=fragment.index, page=fragment.page, start_ms=fragment.start_ms)


def location_label(location: FragmentLocation) -> str:
    if location.start_ms is not None:
        return format_timestamp(location.start_ms)
    if location.page is not None:
        return f"page {location.page}"
    if location.index is not None:
        return f"paragraph {location.index + 1}"
    return "unknown place"


def _copy_into(directory: Path, original: Original) -> None:
    target = directory / original.name
    if original.data is not None:
        write_atomic(target, original.data)
        return
    assert original.path is not None
    temp = directory / f".skaz-tmp-{uuid4().hex}"
    try:
        digest = hashlib.sha256()
        total = 0
        try:
            with open(original.path, "rb") as src, open(temp, "wb") as dst:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    total += len(chunk)
                    if original.expected_size is not None and total > original.expected_size:
                        raise SourceRejected(FILE_CHANGED_MESSAGE)
                    digest.update(chunk)
                    dst.write(chunk)
                dst.flush()
                os.fsync(dst.fileno())
        except OSError as error:
            raise SourceRejected("This file doesn't exist any more or can't be opened.") from error
        if original.expected_size is not None and total != original.expected_size:
            raise SourceRejected(FILE_CHANGED_MESSAGE)
        if (
            original.expected_sha256 is not None
            and digest.hexdigest() != original.expected_sha256.lower()
        ):
            raise SourceRejected(FILE_CHANGED_MESSAGE)
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    fsync_dir(directory)


class SourceService:
    def __init__(
        self,
        kb: KnowledgeService,
        *,
        fetcher: SafeFetcher | None = None,
        video_probe: VideoProbe | None = None,
        page_renderer: PdfPageRenderer | None = None,
        frame_retriever: FrameRetriever | None = None,
        frame_policy: FramePolicyConfig = DEFAULT_FRAME_POLICY,
    ) -> None:
        self.kb = kb
        self.fetcher = fetcher or SafeFetcher()
        self.video_probe = video_probe
        self.visual = VisualSourcePreparer(
            kb,
            page_renderer=page_renderer,
            frame_retriever=frame_retriever,
            frame_policy=frame_policy,
        )
        self._listeners: list[Listener] = []
        self._lock = _GUARD_LOCK
        #: Q1 n2 L3: one add at a time per file content / per address (duplicate check, then store).
        self._same_file = KeyedThreadLocks()
        self._same_link = KeyedLocks()
        #: One save at a time per page: a double click makes one material, one request.
        self._web_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = (
            weakref.WeakValueDictionary()
        )

    # -- events ---------------------------------------------------------------

    def subscribe(self, listener: Listener) -> None:
        """W1 hooks processing here (new material ready, fragment restored)."""
        self._listeners.append(listener)

    def _emit(self, event: SourceEvent) -> None:
        for listener in list(self._listeners):
            try:
                listener(event)
            except Exception as error:
                log.error("Source event listener failed for %s of %s: %s", event.kind, event.material_id,
                          error_note(error))

    # -- adding ----------------------------------------------------------------

    def add_text(self, text: str, folder_id: str, title: str | None = None, *,
                 to_wiki: bool | None = None) -> IntakeResult:
        """Pasted text, any length; long paragraphs are split at sentences."""
        prepared = prepare_text(text, origin=Origin(type="paste"))
        if prepared.failure:
            raise SourceRejected(prepared.failure)
        return self._publish(prepared, folder_id, title, to_wiki)

    def add_file(
        self,
        path: str | Path,
        folder_id: str,
        title: str | None = None,
        *,
        to_wiki: bool | None = None,
        selection_source: SelectionSource = "picker",
        expected_size: int | None = None,
        expected_sha256: str | None = None,
    ) -> IntakeResult:
        """A PDF (or book), DOCX, Markdown/text, or image (JPEG, PNG, WebP, HEIC) picked by the user."""
        self._typed_name(title)  # a typed name that can't be one is refused first, duplicate or not
        checked = given_path(path, SourceRejected)
        classified = classify_extension(checked)
        if classified.category == "speech":
            raise SourceRejected(
                f"SKAZ can't read {classified.extension} files here. "
                "Add audio and video files with the speech import."
            )
        selection = TrustedFileSelection.from_raw(
            checked,
            source=selection_source,
            expected_size=expected_size,
            expected_sha256=expected_sha256,
        )
        validated = validate_trusted_selection(selection, data_dir=self.kb.data_dir)
        self.kb.require()
        # Q1 n2 L3: the check and the store under one lock per content — two adds at once make one.
        with self._same_file.hold(validated.sha256):
            category = validated.classification.category
            if category in ("pdf", "text"):
                data = read_bounded_bytes(
                    validated.resolved_path,
                    max_bytes=validated.classification.max_bytes,
                )
                if len(data) != validated.size_bytes or hashlib.sha256(data).hexdigest() != validated.sha256:
                    raise SourceRejected(FILE_CHANGED_MESSAGE)
                duplicate = find_duplicate(self.kb, content=data)
                if duplicate is not None:
                    return self._existing(duplicate)
                origin = Origin.model_validate(
                    {
                        "type": "file",
                        "file_name": validated.selection.display_name,
                        "sha256": validated.sha256,
                    }
                )
                if category == "pdf":
                    prepared = prepare_pdf(
                        data,
                        origin=origin,
                        fallback=sanitize_title(Path(validated.selection.display_name).stem) or "Document",
                        original=Original(
                            "original.pdf",
                            path=validated.resolved_path,
                            expected_size=validated.size_bytes,
                            expected_sha256=validated.sha256,
                        ),
                    )
                else:
                    prepared = prepare_text_file(data, validated.selection.display_name, origin=origin)
                    if prepared.failure:
                        raise SourceRejected("This file has no text.")
                return self._publish(prepared, folder_id, title, to_wiki)

            duplicate = find_duplicate(self.kb, digest=validated.sha256)
            if duplicate is not None:
                return self._existing(duplicate)
            if category == "docx":
                native = prepare_docx_selection(validated)
            else:
                native = prepare_image_selection(validated, generate_preview=False)
            prepared = self._from_native(native)
            effective_to_wiki = False if prepared.kind == "image" else to_wiki
            return self._publish(prepared, folder_id, title, effective_to_wiki)

    def add_clipboard_image(
        self,
        data: bytes,
        folder_id: str,
        *,
        mime_type: str,
        file_name: str = "Screenshot",
        title: str | None = None,
    ) -> IntakeResult:
        """Import bounded clipboard image bytes into the library without OCR or auto-wiki ingest."""
        self._typed_name(title)
        self.kb.require()
        native = prepare_clipboard_image(
            data,
            mime_type=mime_type,
            file_name=file_name,
            generate_preview=False,
        )
        with self._same_file.hold(native.sha256):
            duplicate = find_duplicate(self.kb, digest=native.sha256)
            if duplicate is not None:
                return self._existing(duplicate)
            return self._publish(self._from_native(native), folder_id, title, False)

    def preview_trusted_image(
        self,
        path: str | Path,
        *,
        expected_size: int | None = None,
        expected_sha256: str | None = None,
        max_edge: int = MAX_PREVIEW_EDGE,
    ) -> bytes:
        """Decode an authorized disk image (including HEIC) into bounded PNG preview bytes."""
        validated = validate_trusted_selection(
            TrustedFileSelection.from_raw(
                path,
                source="picker",
                expected_size=expected_size,
                expected_sha256=expected_sha256,
            ),
            data_dir=self.kb.data_dir,
        )
        if validated.classification.category != "image":
            raise SourceRejected("Image preview is only available for image files.")
        decoded = decode_verified_image(
            validated,
            generate_preview=True,
            max_preview_edge=max_edge,
        )
        assert decoded.preview_png is not None
        return decoded.preview_png

    def preview_material_image(
        self,
        material_id: str,
        *,
        max_edge: int = MAX_PREVIEW_EDGE,
    ) -> bytes:
        """Decode an imported image material's confined ``.skaz/original.*`` into bounded PNG bytes."""
        files = self._material_files(material_id)
        if files.manifest.kind != "image":
            raise SourceRejected("Image preview is only available for image materials.")
        intake = self._intake(files.directory)
        original_name = intake.original if intake and intake.original else None
        if not original_name:
            raise SourceRejected("This image material has no stored original file.")
        service_dir = (files.directory / SERVICE_DIR).resolve(strict=True)
        candidate = files.directory / SERVICE_DIR / original_name
        try:
            if candidate.is_symlink():
                raise SourceRejected("SKAZ refuses symbolic links inside a material's service folder.")
            resolved = candidate.resolve(strict=True)
            info = resolved.stat()
        except SourceRejected:
            raise
        except (OSError, RuntimeError) as error:
            raise SourceRejected("The material's original image is missing or can't be opened.") from error
        data_root = self.kb.data_dir.resolve()
        if resolved.parent != service_dir or resolved == data_root or data_root in resolved.parents:
            raise SourceRejected("The material's original image points outside its authorized folder.")
        if not stat.S_ISREG(info.st_mode) or not os.access(resolved, os.R_OK):
            raise SourceRejected("Choose a readable regular file.")
        classified = classify_extension(resolved)
        if classified.category != "image":
            raise SourceRejected("This material's original file isn't a supported image.")
        decoded = decode_image(
            resolved,
            expected_format=cast(ImageFormat, classified.format_id),
            mime_type=classified.mime_type,
            generate_preview=True,
            max_preview_edge=max_edge,
        )
        assert decoded.preview_png is not None
        return decoded.preview_png

    @staticmethod
    def _from_native(native: NativeIntakePrepared) -> Prepared:
        extra = dict(native.extra)
        if "format" in extra:
            # IntakeRecord reserves "format" for the intake.json schema version (int = 1).
            extra["file_format"] = extra.pop("format")
        return Prepared(
            kind=cast(MaterialKind, native.kind),
            title=native.title,
            fallback_title=native.fallback_title,
            fragments=list(native.fragments),
            findings=list(native.findings),
            origin=native.origin,
            extractor=native.extractor,
            original=native.original,
            failure=native.failure,
            extra=extra,
        )

    async def add_link(self, url: str, folder_id: str, title: str | None = None, *,
                       to_wiki: bool | None = None) -> IntakeResult:
        """An article, a PDF or a text file by URL. Video links are refused: the speech import adds them."""
        self.kb.require()  # refuse before any request when no library is connected
        offline = classify_offline(url)
        if offline is not None and offline.kind == "video":
            raise SourceRejected(VIDEO_LINK)
        if offline is not None and offline.kind in ("audio_file", "video_file"):
            raise SourceRejected(MEDIA_FILE_LINK)
        address = check_url(url)
        self._typed_name(title)
        # Q1 n2 L3: the checks and the store under one lock per address — two adds at once make one.
        async with self._same_link.hold(url_key(address) or address):
            return await self._add_link(address, offline, folder_id, title, to_wiki)

    async def _add_link(self, address: str, offline: LinkInfo | None, folder_id: str, title: str | None,
                        to_wiki: bool | None) -> IntakeResult:
        # N2: the same address or DOI already in the library is answered before any request.
        duplicate = await disk_call(find_duplicate, self.kb, urls=[address])
        if duplicate is not None:
            return self._existing(duplicate)
        limit = MAX_LINKED_PDF_BYTES if offline is not None and offline.kind == "pdf" else MAX_PAGE_BYTES
        # The user's click on this link: pinned to the checked address; a VPN fake-IP answer is accepted
        # for a public name on the default port (``fetch`` module note, security review S-02/S-05).
        fetched = await self.fetcher.fetch(address, max_bytes=limit, pin_address=True, allow_vpn_fake_ip=True)
        content_type = fetched.content_type
        domain = domain_of(address)
        # After redirects: the page it landed on, or the same bytes, may be in the library already.
        duplicate = await disk_call(find_duplicate, self.kb, urls=[fetched.url], content=fetched.body)
        if duplicate is not None:
            return self._existing(duplicate)
        origin = Origin.model_validate(
            {"type": "url", "url": address, "final_url": fetched.url, "content_type": content_type,
             "sha256": content_hash(fetched.body)}
        )
        if content_type == "application/pdf" or (
            content_type in ("", "application/octet-stream") and fetched.body.startswith(b"%PDF-")
        ):
            original = Original("original.pdf", data=fetched.body)
            prepared = prepare_pdf(fetched.body, origin=origin, fallback=domain, original=original)
        elif content_type in ("text/html", "application/xhtml+xml") or (
            content_type == "" and b"<html" in fetched.body[:2048].lower()
        ):
            html = decode_html(fetched.body, fetched.charset)
            prepared = prepare_html(
                html, origin=origin, fallback=domain, original=Original("original.html", data=fetched.body)
            )
            if prepared.failure:
                raise SourceRejected(prepared.failure)
        elif content_type == "text/plain":
            prepared = prepare_text(
                decode_html(fetched.body, fetched.charset), origin=origin, fallback=domain
            )
            if prepared.failure:
                raise SourceRejected("This page has no text.")
        elif content_type.startswith(("audio/", "video/")):
            raise SourceRejected(MEDIA_FILE_LINK)
        else:
            raise SourceRejected(f"SKAZ can't read this kind of page ({content_type or 'unknown type'}).")
        return await self._publish_async(prepared, folder_id, title, to_wiki)

    async def add_web_page(self, url: str, folder_id: str, *, to_wiki: bool = True) -> WebPageSaved:
        """W-3 "Add to wiki": one request to ``url`` (and its redirects), the whole page as text.

        The same page already in the library — in ``folder_id`` or, by the N2 address/DOI rule,
        anywhere else — is returned as it is, without a request; if it isn't in the wiki,
        ``to_wiki`` asks for ingest again.
        """
        self.kb.require()  # refuse before any request when no library is connected
        if self.kb.folder_repo.get(folder_id) is None:
            raise NotFound("Folder not found.")
        try:
            address = self.fetcher.check(url)
        except LinkRejected as error:
            raise WebPageUnavailable(error.message) from error
        key = page_key(address) or address
        # One lock per page, not per folder: the same page is one material in the whole library (N2).
        lock = self._web_locks.get(key)
        if lock is None:
            lock = self._web_locks[key] = asyncio.Lock()
        async with lock:
            existing = await disk_call(self._saved_page, folder_id, key)
            if existing is None:
                duplicate = await disk_call(find_duplicate, self.kb, urls=[address])
                existing = duplicate.material_id if duplicate is not None else None
            if existing is not None:
                if to_wiki and await disk_call(self._not_in_wiki, existing):
                    self._emit(SourceEvent("material_ready", existing, to_wiki=True))
                return WebPageSaved(existing, True, None)
            try:
                fetched = await self.fetcher.fetch(
                    address, max_bytes=web_page.MAX_PAGE_BYTES, accept=web_page.ACCEPT,
                    total_seconds=web_page.TOTAL_SECONDS, pin_address=True, allow_vpn_fake_ip=True,
                )
            except (FetchFailed, LinkRejected) as error:
                raise WebPageUnavailable(error.message) from error
            prepared = prepare_web_page(fetched, address, fetched_at=utc_now())
            result = await self._publish_async(prepared, folder_id, None, to_wiki)
        return WebPageSaved(result.material_id, False, result)

    def _existing(self, duplicate: Duplicate) -> IntakeResult:
        record = self.kb.material_repo.get(duplicate.material_id)
        status = record.status if record is not None else "ready"
        return IntakeResult(duplicate.material_id, duplicate.title, status, 0, 0, None, existing=True)

    def _saved_page(self, folder_id: str, key: str) -> str | None:
        for record in self.kb.materials(folder_id=folder_id, kind="web"):
            origin = record.origin or {}
            if key in (page_key(origin.get("url")), page_key(origin.get("final_url"))):
                return record.id
        return None

    def _not_in_wiki(self, material_id: str) -> bool:
        state = wiki_states(self.kb.db, [material_id]).get(material_id)
        return state is None or state.state in _NOT_ADDED

    async def add_prepared(self, prepared: Prepared, folder_id: str, *, to_wiki: bool) -> IntakeResult:
        """Publish text another part of SKAZ already prepared (0.4.0 B2 Add to wiki keeps its DOI origin)."""
        return await self._publish_async(prepared, folder_id, None, to_wiki)

    async def _publish_async(self, prepared: Prepared, folder_id: str, title: str | None,
                             to_wiki: bool | None = None) -> IntakeResult:
        return await disk_call(self._publish, prepared, folder_id, title, to_wiki)

    async def classify(self, url: str, *, probe: bool = True) -> LinkInfo:
        """The Add link dialog's check of a link the user put on the list (and the check ``add_link``'s
        route makes for that click): a user-click request, so a VPN fake-IP answer counts (S-02)."""
        return await classify_link(url, self.fetcher, video_probe=self.video_probe if probe else None,
                                   allow_vpn_fake_ip=True)

    @staticmethod
    def _typed_name(title: str | None) -> None:
        if title is not None and title.strip():
            validate_name(title)

    @staticmethod
    def _title(prepared: Prepared, title: str | None) -> tuple[str, bool]:
        """The name and whether the user typed it (a typed name is refused when taken, QA B1)."""
        if title is not None and title.strip():
            return validate_name(title), True
        return prepared.title or prepared.fallback_title, False

    def _publish(self, prepared: Prepared, folder_id: str, title: str | None,
                 to_wiki: bool | None = None) -> IntakeResult:
        name, typed = self._title(prepared, title)
        detections = [detect_instruction(fragment.text) for fragment in prepared.fragments]
        status: MaterialStatus = "failed" if prepared.failure else "processing"
        files = self.kb.create_material(
            folder_id, name, prepared.kind, prepared.fragments, status=status, origin=prepared.origin,
            unique=not typed,
        )
        material_id = files.manifest.id
        try:
            service_dir = files.directory / SERVICE_DIR
            if prepared.original is not None:
                _copy_into(service_dir, prepared.original)
            intake = IntakeRecord.model_validate(
                {
                    **prepared.extra,
                    "extractor": prepared.extractor,
                    "failure": prepared.failure,
                    "hidden": prepared.findings,
                    "original": prepared.original.name if prepared.original else None,
                    "created_at": utc_now(),
                }
            )
            write_atomic(service_dir / INTAKE_FILE, dump_json(intake.model_dump(mode="json")))
            excluded = self._exclusions(files.fragments, detections, ExclusionFile())
            exclusions = ExclusionFile(excluded=excluded)
            if excluded:
                exclusions.notification_id = self._notify(material_id, files.title, excluded)
            self._write_exclusions(files.directory, exclusions)
            if not prepared.failure:
                self.kb.set_material_status(material_id, "ready")
        except SourceRejected:
            self._rollback_material(material_id, files.directory)
            raise
        except (OSError, KnowledgeError, ValidationError) as error:
            log.error("Finishing material %s failed: %s", material_id, error_note(error))
            with contextlib.suppress(OSError, KnowledgeError):
                self.kb.set_material_status(material_id, "failed")
            raise KnowledgeError(
                "SKAZ added the material but couldn't finish it. "
                "It's marked as failed; delete it and try again."
            ) from error
        if not prepared.failure:
            self._emit(SourceEvent("material_ready", material_id, to_wiki=to_wiki))
        return IntakeResult(
            material_id,
            files.title,
            "failed" if prepared.failure else "ready",
            len(excluded),
            len(prepared.findings),
            prepared.failure,
        )

    def _rollback_material(self, material_id: str, directory: Path) -> None:
        with contextlib.suppress(OSError, KnowledgeError), self.kb.writing():
                library = self.kb.require()
                area = library.root / STAGING_PATH
                area.mkdir(parents=True, exist_ok=True)
                doomed = area / f"rollback-{uuid4().hex}"
                if directory.exists():
                    os.rename(directory, doomed)
                    shutil.rmtree(doomed, ignore_errors=True)
                with self.kb.db.write() as connection:
                    connection.execute("DELETE FROM materials WHERE id = ?", (material_id,))
                    connection.execute("DELETE FROM wiki_checkpoints WHERE material_id = ?", (material_id,))

    # -- layer 3 bookkeeping ---------------------------------------------------

    @staticmethod
    def _exclusions(
        fragments: Sequence[Fragment], detections: Sequence[Detection | None], current: ExclusionFile
    ) -> list[ExcludedFragment]:
        allowed = current.restored_hashes()
        found: list[ExcludedFragment] = []
        now = utc_now()
        for fragment, detection in zip(fragments, detections, strict=True):
            if detection is None:
                continue
            text_hash = block_hash(fragment.text)
            if text_hash in allowed:
                continue
            found.append(
                ExcludedFragment(
                    seg=fragment.seg,
                    text_hash=text_hash,
                    reason=detection.reason,
                    rules=list(detection.rules),
                    score=detection.score,
                    found=detection.found,
                    location=location_of(fragment),
                    detected_at=now,
                )
            )
        return found

    def _notify(self, material_id: str, title: str, excluded: Sequence[ExcludedFragment]) -> str:
        items = [
            {
                "seg": item.seg,
                "found": item.found,
                "reason": item.reason,
                "location": item.location.model_dump(),
                "location_label": location_label(item.location),
                "restore": {
                    "method": "POST",
                    "path": f"/kb/materials/{material_id}/excluded/{item.seg}/restore",
                    "label": RESTORE_LABEL,
                },
            }
            for item in excluded
        ]
        first = excluded[0]
        heading = (
            "Instruction for AI found in a source — excluded"
            if len(excluded) == 1
            else f"{len(excluded)} instructions for AI found in a source — excluded"
        )
        record = self.kb.notify(
            EXCLUDED_NOTIFICATION,
            heading,
            body=f"“{title}”, {location_label(first.location)}: {first.found}",
            payload={
                "material_id": material_id,
                "material_title": title,
                "count": len(excluded),
                "items": items,
            },
        )
        return record.id

    def _material_files(self, material_id: str) -> MaterialFiles:
        record = self.kb.material_repo.get(material_id)
        if record is None:
            raise NotFound("Material not found.")
        return self.kb.require().read_material(material_id, hint=record.rel_dir)

    @staticmethod
    def _read_exclusions(directory: Path) -> ExclusionFile:
        try:
            return ExclusionFile.model_validate(read_json(directory / SERVICE_DIR / EXCLUDED_FILE))
        except FileNotFoundError:
            return ExclusionFile()
        except (ValueError, UnicodeDecodeError, ValidationError) as error:
            raise KnowledgeError("The material's exclusion list is damaged.") from error

    @staticmethod
    def _write_exclusions(directory: Path, exclusions: ExclusionFile) -> None:
        write_atomic(directory / SERVICE_DIR / EXCLUDED_FILE, dump_json(exclusions.model_dump(mode="json")))

    def _intake(self, directory: Path) -> IntakeRecord | None:
        try:
            return IntakeRecord.model_validate(read_json(directory / SERVICE_DIR / INTAKE_FILE))
        except FileNotFoundError:
            return None
        except (ValueError, UnicodeDecodeError, ValidationError):
            return None

    def guard_report(self, material_id: str) -> GuardReport:
        files = self._material_files(material_id)
        exclusions = self._read_exclusions(files.directory)
        intake = self._intake(files.directory)
        return GuardReport(
            material_id,
            tuple(exclusions.excluded),
            tuple(exclusions.restored),
            tuple(intake.hidden) if intake else (),
            intake.failure if intake else None,
        )

    def excluded_segs(self, material_id: str) -> frozenset[int]:
        """Fragments processing must skip (W1 reads this before building the wiki)."""
        return self._read_exclusions(self._material_files(material_id).directory).excluded_segs()

    def restore(self, material_id: str, seg: int) -> GuardReport:
        """ "This isn't an instruction": include ``seg`` again and remember it by its text hash."""
        with self._lock:
            files = self._material_files(material_id)
            exclusions = self._read_exclusions(files.directory)
            entry = next((item for item in exclusions.excluded if item.seg == seg), None)
            if entry is None:
                raise NotFound("This fragment isn't excluded.")
            fragment = next((item for item in files.fragments if item.seg == seg), None)
            text_hash = block_hash(fragment.text) if fragment is not None else entry.text_hash
            exclusions.excluded = [item for item in exclusions.excluded if item.seg != seg]
            exclusions.restored = [item for item in exclusions.restored if item.seg != seg]
            exclusions.restored.append(RestoredFragment(seg=seg, text_hash=text_hash, restored_at=utc_now()))
            notification = exclusions.notification_id if not exclusions.excluded else None
            if notification is not None:
                exclusions.notification_id = None
            self._write_exclusions(files.directory, exclusions)
        if notification is not None:
            with contextlib.suppress(NotFound):
                self.kb.dismiss_notification(notification)
        self._emit(SourceEvent("fragment_restored", material_id, seg))
        return self.guard_report(material_id)

    def rescan(self, material_id: str, *, segs: Collection[int] | None = None) -> GuardReport:
        """Run the detector again over the material's current fragments (restored texts stay included).

        For reprocessing and for materials added by other areas (speech).
        ``segs``: only these fragments (speech appended them just now); the
        other fragments keep their exclusions as they are. A new exclusion
        raises a notification like adding does.
        """
        with self._lock:
            files = self._material_files(material_id)
            current = self._read_exclusions(files.directory)
            scanned = [item for item in files.fragments if segs is None or item.seg in segs]
            detections = [detect_instruction(fragment.text) for fragment in scanned]
            excluded = self._exclusions(scanned, detections, current)
            known = {(item.seg, item.text_hash) for item in current.excluded}
            new = [item for item in excluded if (item.seg, item.text_hash) not in known]
            if segs is not None:
                kept = [item for item in current.excluded if item.seg not in segs]
                if not new and len(kept) + len(excluded) == len(current.excluded):
                    return self.guard_report(material_id)  # nothing changed: no write
                excluded = sorted([*kept, *excluded], key=lambda item: item.seg)
            current.excluded = excluded
            if new:
                current.notification_id = self._notify(material_id, files.title, new)
            self._write_exclusions(files.directory, current)
        return self.guard_report(material_id)

    # -- visual preparation and frame retention (V3 seam for V1/V4) ------------

    def prepare_image(
        self,
        path: str | Path,
        *,
        material_id: str | None = None,
    ) -> PreparedVisual:
        return self.visual.prepare_image(path, material_id=material_id)

    def prepare_pdf_pages(
        self,
        material_id: str,
        *,
        pages: Sequence[int] | None = None,
        page_range: tuple[int, int] | None = None,
        query: str | None = None,
        max_pages: int = DEFAULT_SEARCH_PDF_PAGES,
    ) -> tuple[PreparedVisual, ...]:
        return self.visual.prepare_pdf_pages(
            material_id,
            pages=pages,
            page_range=page_range,
            query=query,
            max_pages=max_pages,
        )

    async def prepare_video_frames(
        self,
        material_id: str,
        *,
        timestamps_ms: Sequence[int] | None = None,
        query: str | None = None,
    ) -> tuple[PreparedVisual, ...]:
        return await self.visual.prepare_video_frames(
            material_id,
            timestamps_ms=timestamps_ms,
            query=query,
        )

    def retain_video_frames(
        self,
        material_id: str,
        frames: Sequence[PreparedVisual],
        *,
        cited_timestamps_ms: Collection[int] = (),
        cited_sha256s: Collection[str] = (),
        pinned_timestamps_ms: Collection[int] = (),
        pinned_sha256s: Collection[str] = (),
        citation_refs: Mapping[int, Sequence[str]] | Sequence[str] = (),
    ) -> tuple[RetainedFrameRecord, ...]:
        return self.visual.retain_video_frames(
            material_id,
            frames,
            cited_timestamps_ms=cited_timestamps_ms,
            cited_sha256s=cited_sha256s,
            pinned_timestamps_ms=pinned_timestamps_ms,
            pinned_sha256s=pinned_sha256s,
            citation_refs=citation_refs,
        )

    def pin_video_frame(self, material_id: str, frame: PreparedVisual) -> RetainedFrameRecord:
        return self.visual.pin_video_frame(material_id, frame)

    def unpin_video_frame(
        self,
        material_id: str,
        frame_id_or_timestamp_ms: str | int,
    ) -> tuple[RetainedFrameRecord, ...]:
        return self.visual.unpin_video_frame(material_id, frame_id_or_timestamp_ms)

    def list_retained_frames(self, material_id: str) -> tuple[RetainedFrameRecord, ...]:
        return self.visual.list_retained_frames(material_id)

    def read_retained_frame(
        self,
        material_id: str,
        frame_id_or_timestamp_ms: str | int,
    ) -> PreparedVisual:
        return self.visual.read_retained_frame(material_id, frame_id_or_timestamp_ms)

    def prepare_visual_seam(
        self,
        *,
        material_id: str | None = None,
        image_path: str | Path | None = None,
        pages: Sequence[int] | None = None,
        page_range: tuple[int, int] | None = None,
        timestamps_ms: Sequence[int] | None = None,
        query: str | None = None,
        max_pages: int = DEFAULT_SEARCH_PDF_PAGES,
    ) -> VisualFallbackSeam:
        return self.visual.prepare_visual_seam(
            material_id=material_id,
            image_path=image_path,
            pages=pages,
            page_range=page_range,
            timestamps_ms=timestamps_ms,
            query=query,
            max_pages=max_pages,
        )

    async def prepare_video_frames_seam(
        self,
        material_id: str,
        *,
        timestamps_ms: Sequence[int] | None = None,
        query: str | None = None,
    ) -> VisualFallbackSeam:
        return await self.visual.prepare_video_frames_seam(
            material_id,
            timestamps_ms=timestamps_ms,
            query=query,
        )
