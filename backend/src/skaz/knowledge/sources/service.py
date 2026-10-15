"""``runtime.kb_sources``: add documents, links and pasted text to the library (area S1).

Every path runs: extract → clean (layer 2) → fragments → instruction
detector (layer 3) → ``KnowledgeService.create_material`` (status
``processing``) → evidence and guard files in the material's ``.skaz/`` →
``ready`` (or ``failed`` with a reason). A name collision refuses the whole
add before anything is written.

Material ``.skaz/`` files written here:

* ``original.<ext>`` — the untouched input (PDF, HTML, pasted text, file);
* ``intake.json`` — extractor, failure reason, layer-2 findings;
* ``excluded.json`` — fragments kept out of processing and restore decisions.
"""

from __future__ import annotations

import contextlib
import logging
import os
import shutil
import threading
from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ...native_io import disk_call
from ..errors import KnowledgeError, NotFound
from ..ids import utc_now
from ..library.fsio import dump_json, fsync_dir, read_json, write_atomic
from ..library.layout import SERVICE_DIR
from ..library.library import MaterialFiles
from ..library.names import validate_name
from ..logsafe import error_note
from ..markdown.source import Fragment, MaterialStatus, Origin
from ..markdown.text import block_hash, format_timestamp
from ..service import KnowledgeService
from .fetch import MAX_PAGE_BYTES, SafeFetcher, check_url
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
    PDF_EXTENSIONS,
    TEXT_EXTENSIONS,
    Original,
    Prepared,
    SourceRejected,
    prepare_html,
    prepare_pdf,
    prepare_text,
    prepare_text_file,
)
from .links import LinkInfo, VideoProbe, classify_link, classify_offline, domain_of
from .material_info import INTAKE_FILE
from .paths import given_path, resolved_file

log = logging.getLogger(__name__)

MAX_PDF_BYTES = 200 * 1024 * 1024
MAX_TEXT_FILE_BYTES = 64 * 1024 * 1024
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
        shutil.copyfile(original.path, temp)
        with open(temp, "rb+") as handle:
            os.fsync(handle.fileno())
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
    ) -> None:
        self.kb = kb
        self.fetcher = fetcher or SafeFetcher()
        self.video_probe = video_probe
        self._listeners: list[Listener] = []
        self._lock = _GUARD_LOCK

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

    def add_file(self, path: str | Path, folder_id: str, title: str | None = None, *,
                 to_wiki: bool | None = None) -> IntakeResult:
        """A PDF (or book) or a ``.md``/``.txt`` file the user picked in the file dialog."""
        file_path = self._checked_file(path)
        suffix = file_path.suffix.lower()
        origin = Origin(type="file", file_name=file_path.name)
        if suffix in PDF_EXTENSIONS:
            prepared = prepare_pdf(
                file_path.read_bytes(),
                origin=origin,
                fallback=file_path.stem or "Document",
                original=Original("original.pdf", path=file_path),
            )
        else:
            prepared = prepare_text_file(file_path.read_bytes(), file_path.name, origin=origin)
            if prepared.failure:
                raise SourceRejected("This file has no text.")
        return self._publish(prepared, folder_id, title, to_wiki)

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
        limit = MAX_LINKED_PDF_BYTES if offline is not None and offline.kind == "pdf" else MAX_PAGE_BYTES
        fetched = await self.fetcher.fetch(address, max_bytes=limit)
        content_type = fetched.content_type
        domain = domain_of(address)
        origin = Origin.model_validate(
            {"type": "url", "url": address, "final_url": fetched.url, "content_type": content_type}
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

    async def _publish_async(self, prepared: Prepared, folder_id: str, title: str | None,
                             to_wiki: bool | None = None) -> IntakeResult:
        return await disk_call(self._publish, prepared, folder_id, title, to_wiki)

    async def classify(self, url: str, *, probe: bool = True) -> LinkInfo:
        return await classify_link(url, self.fetcher, video_probe=self.video_probe if probe else None)

    def _checked_file(self, raw: str | Path) -> Path:
        """The file path from the open dialog: absolute, a readable regular file of a supported type,
        not in a hidden folder or SKAZ's own data — checked where the file really is (``paths``)."""
        path = given_path(raw, SourceRejected)
        suffix = path.suffix.lower()
        if suffix not in PDF_EXTENSIONS | TEXT_EXTENSIONS:
            raise SourceRejected(
                "SKAZ adds PDF, Markdown (.md) and text (.txt) files here. "
                "Audio and video go through the speech import."
            )
        resolved, info = resolved_file(path, self.kb.data_dir, SourceRejected)
        limit = MAX_PDF_BYTES if suffix in PDF_EXTENSIONS else MAX_TEXT_FILE_BYTES
        if info.st_size > limit:
            raise SourceRejected(f"This file is larger than {limit // (1024 * 1024)} MB.")
        return resolved

    def _title(self, prepared: Prepared, title: str | None) -> str:
        if title is not None and title.strip():
            return validate_name(title)
        return prepared.title or prepared.fallback_title

    def _publish(self, prepared: Prepared, folder_id: str, title: str | None,
                 to_wiki: bool | None = None) -> IntakeResult:
        name = self._title(prepared, title)
        detections = [detect_instruction(fragment.text) for fragment in prepared.fragments]
        status: MaterialStatus = "failed" if prepared.failure else "processing"
        files = self.kb.create_material(
            folder_id, name, prepared.kind, prepared.fragments, status=status, origin=prepared.origin
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
