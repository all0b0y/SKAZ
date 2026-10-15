"""``runtime.kb_wiki``: the wiki after ingest (area W2).

Recognition corrections, discrepancies, deletion with preview, rename/move,
page edits, external edits, connections and the graph, folder overviews and
the notification feed with actions. Every write to wiki files takes ingest's
write lock, so W1 and W2 never interleave writes to one page.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4

from ...native_io import disk_call
from ..agents.engine import AgentEngine
from ..corrections.check import RecognitionChecker
from ..corrections.model import apply_to_text
from ..corrections.service import CorrectionChange, CorrectionService
from ..corrections.store import CorrectionsLayer, CorrectionStore
from ..errors import KnowledgeError, NotFound
from ..ingest.jobs import JobRecord
from ..ingest.service import IngestService
from ..ingest.writer import WikiWriter
from ..logsafe import error_note
from ..markdown.page import PageDocument
from ..notifications.feed import NotificationFeed, register_material_kinds
from ..service import KnowledgeService, MaterialDetail, PageView
from .agent import AgentCaller, WikiJobFailed
from .connections import Connections
from .context import NO_DETECTOR, WikiContext
from .delete import DeletePlan, MaterialBusy, StillRecording, append_log, execute_delete, plan_delete
from .discrepancy import KIND as DISCREPANCY_KIND
from .discrepancy import Discrepancies
from .edit import add_note, delete_note, update_block
from .graph import Graph, GraphIndex
from .jobs import JobContext, WikiBusy, WikiJobs
from .move import move_material
from .overview import FolderOverviews
from .pages_io import page_path, reindex, rewrite
from .recheck import Recheck
from .retract import retract_unquoted
from .watch import INTERVAL_S, WikiWatcher

logger = logging.getLogger(__name__)
NO_ENGINE = "No agent is ready to write the wiki. Connect one in Settings → Models, then retry."
#: Background "Find connections": only after this long without wiki work, and only when the wiki changed.
IDLE_AFTER_S = 300.0


@dataclass(frozen=True)
class PageRefView:
    id: str
    kind: str
    title: str


@dataclass(frozen=True)
class PageDetail:
    view: PageView
    related: list[PageRefView]
    mentioned_in: list[PageRefView]
    folder_names: list[str]
    updated_at: str | None


def _log_failure(task: asyncio.Task[None]) -> None:
    error = None if task.cancelled() else task.exception()
    if error is not None:
        logger.error("wiki work after ingest failed: %s", error_note(error))


class WikiService:
    def __init__(self, kb: KnowledgeService, ingest: IngestService) -> None:
        self.kb = kb
        self.ingest = ingest
        self.store = CorrectionStore(kb)
        self.corrections = CorrectionService(kb, self.store)
        self.corrections.on_text_changed = self._text_changed
        self.graph = GraphIndex(kb.db)
        self.ctx = WikiContext(
            kb,
            self.store,
            self.graph,
            ingest.write_lock,
            decisions=lambda: ingest.decisions,
            detector=lambda: ingest.detector,
            settings=ingest.settings,
        )
        self.discrepancies = Discrepancies(self.ctx)
        self.connections = Connections(self.ctx)
        self.overviews = FolderOverviews(self.ctx)
        self.rechecks = Recheck(self.ctx)
        self.jobs = WikiJobs(ingest.jobs)
        self.feed = NotificationFeed(kb)
        self.watcher = WikiWatcher(kb)
        self.recognition = RecognitionChecker(
            kb,
            self.store,
            decisions=lambda: ingest.decisions,
            detector=lambda: ingest.detector,
            auto=lambda: ingest.settings().auto_corrections,
        )
        self.idle_after_s = IDLE_AFTER_S
        self.clock = time.monotonic
        self._last_activity = self.clock()
        self._background_signature: str | None = None
        self._loop_task: asyncio.Task[None] | None = None
        self._post_tasks: set[asyncio.Task[None]] = set()
        self._writer = WikiWriter(kb, ingest.write_lock)

    # -- wiring -------------------------------------------------------------

    def connect(self) -> None:
        """Fill the ingest seams and register the notification kinds (``wiring.wire_wiki``)."""
        self.ingest.text_layer = CorrectionsLayer(self.store)
        self.ingest.recognition = self.recognition
        self.ingest.hook = self
        self.ingest.finished_listeners.append(self._after_ingest)
        actions = self.kb.notification_actions
        actions.register(DISCREPANCY_KIND, self.discrepancies.actions, self.discrepancies.resolve)
        actions.register(
            "doubtful_corrections",
            self.corrections.notification_actions,
            self.corrections.resolve_notification,
        )
        register_material_kinds(actions, ("excluded_instruction", "blocked_output"))
        self.kb.after_scan.append(self._after_scan)

    def _after_scan(self) -> None:
        try:
            self.store.rebuild_index()
            self.graph.refresh(force=True)
        except Exception as error:  # the scan itself succeeded; these indexes are rebuilt on the next one
            logger.error("rebuilding the corrections index or graph after a scan failed: %s",
                         error_note(error))

    # -- engines ------------------------------------------------------------

    def _engine(self) -> AgentEngine:
        if self.ingest.detector is None:
            raise WikiJobFailed(NO_DETECTOR)
        resolve = self.ingest.engines
        engine = resolve(self.ingest.settings().engine) if resolve is not None else None
        if engine is None:
            raise WikiJobFailed(NO_ENGINE)
        return engine

    def _caller(self, prefix: str) -> AgentCaller:
        return AgentCaller(self._engine(), f"{prefix}-{uuid4().hex[:8]}")

    def _touch(self) -> None:
        self._last_activity = self.clock()

    @property
    def busy(self) -> bool:
        """Wiki jobs or the work started around a new source are still running."""
        return self.jobs.any_running or bool(self._post_tasks)

    # -- ingest seams ---------------------------------------------------------

    async def on_concept_updated(self, page_id: str, new_block_ids: Sequence[str]) -> None:
        """W1 ``ConceptUpdateHook``: compare the new statements with other sources on the page."""
        self._touch()

        async def log(_message: str) -> None:
            # The message names pages and materials: the log gets the page id only.
            logger.info("discrepancy check on page %s: one step logged", page_id)

        await self.discrepancies.check_page(page_id, list(new_block_ids), self._caller("disc"), log)

    def _after_ingest(self, material_id: str, _job: JobRecord) -> None:
        self._touch()
        task = asyncio.get_running_loop().create_task(self._post_ingest(material_id))
        self._post_tasks.add(task)
        task.add_done_callback(self._post_tasks.discard)
        task.add_done_callback(_log_failure)

    async def _post_ingest(self, material_id: str) -> None:
        """Around the new source: its folder's overview and connections of its concept pages (decision 5)."""
        record = await disk_call(self.kb.material_repo.get, material_id)
        if record is None:
            return
        pages = [
            page.id
            for page in await disk_call(lambda: self.kb.pages(kind="concept"))
            if material_id in page.sources
        ]
        with contextlib.suppress(KnowledgeError):
            await self.write_overview(record.folder_id)
        if pages:
            with contextlib.suppress(KnowledgeError):
                await self.find_connections(pages)

    # -- jobs -----------------------------------------------------------------

    async def find_connections(self, page_ids: Sequence[str] | None = None) -> JobRecord:
        """``connections`` job: disagreements and connections, around ``page_ids`` or the whole wiki."""
        if self.jobs.running("connections"):
            raise WikiBusy("SKAZ is already looking for connections.")
        self._touch()
        scope = list(page_ids) if page_ids is not None else None

        async def work(job: JobContext) -> None:
            caller = self._caller("links")
            pages = (
                scope
                if scope is not None
                else [page.id for page in await disk_call(lambda: self.kb.pages(kind="concept"))]
            )
            await job.count(parts_total=len(pages), parts_done=0)
            written = found = 0
            for done, page_id in enumerate(pages, start=1):
                await job.step("checking_discrepancies")
                found += await self.discrepancies.check_page(page_id, None, caller, job.log)
                await job.step("finding_connections")
                written += await self.connections.find_for_page(page_id, caller, job.log)
                await job.count(parts_done=done, blocks_written=written)
            await disk_call(self.graph.refresh)
            await job.log(
                f"Looked at {len(pages)} concept page(s): {written} connection(s) written, "
                f"{found} disagreement(s) marked."
            )
            self._touch()

        return await self.jobs.start("connections", None, "finding_connections", work)

    async def write_overview(self, folder_id: str) -> JobRecord:
        if self.jobs.running("folder_overview", folder_id):
            raise WikiBusy("The overview of this folder is already being written.")

        async def work(job: JobContext) -> None:
            await self.overviews.write(folder_id, self._caller("overview"), job.log)
            await disk_call(self.graph.refresh)
            await disk_call(self._refresh_index)

        return await self.jobs.start("folder_overview", folder_id, "writing_overview", work)

    async def recheck(self, page_id: str, block_id: str) -> JobRecord:
        await disk_call(self.rechecks.target, page_id, block_id)  # 404/409 before a job exists
        if self.jobs.running("recheck", page_id):
            raise WikiBusy("A statement of this page is already being rechecked.")
        self._touch()

        async def work(job: JobContext) -> None:
            await self.rechecks.run(page_id, block_id, self._caller("recheck"), job.log)

        return await self.jobs.start("recheck", page_id, "rechecking", work)

    # -- corrections ----------------------------------------------------------

    async def change_correction(self, correction_id: str, action: str) -> CorrectionChange:
        return await self.corrections.change(correction_id, action)

    async def _text_changed(self, material_id: str, segs: set[int]) -> tuple[int, JobRecord | None]:
        """A correction changed the text: take down statements whose quote broke, then refresh."""
        removed = await disk_call(self._retract_unquoted, material_id, segs)
        job = None
        if removed:
            try:
                job = await self.ingest.request_ingest(material_id, kind="refresh")
            except KnowledgeError:
                job = None  # already being added to the wiki: that run reads the corrected text
        return removed, job

    def _retract_unquoted(self, material_id: str, segs: set[int]) -> int:
        record = self.kb.material_repo.get(material_id)
        if record is None:
            return 0
        originals = {fragment.seg: fragment.text for fragment in self.kb.material_repo.fragments(material_id)}
        data = self.store.read_or_empty(material_id)

        def text_of(seg: int) -> str | None:
            original = originals.get(seg)
            return None if original is None else apply_to_text(original, data.for_seg(seg))

        marks = ", ".join("?" * len(segs))
        with self.kb.db.read() as connection:
            pages = [
                row[0]
                for row in connection.execute(
                    f"SELECT DISTINCT page_id FROM citations WHERE material_id = ? AND seg IN ({marks})",
                    (material_id, *sorted(segs)),
                )
            ]
        removed = 0
        with self.ctx.write_lock:
            for page_id in pages:
                try:
                    library, path = page_path(self.kb, page_id)
                except NotFound:
                    continue
                taken: list[str] = []

                def build(
                    document: PageDocument, page_id: str = page_id, taken: list[str] = taken
                ) -> PageDocument | None:
                    updated, result = retract_unquoted(document, material_id, text_of)
                    extra = self._explanations_of(page_id, set(result.removed))
                    if extra:
                        updated, result = retract_unquoted(document, material_id, text_of, also=extra)
                    taken[:] = result.removed
                    return updated if result.removed else None

                if rewrite(library, path, build):
                    reindex(self.kb, library, path)
                    removed += len(taken)
        if removed:
            self.graph.refresh()
        return removed

    def _explanations_of(self, page_id: str, removed: set[str]) -> set[str]:
        with self.kb.db.read() as connection:
            rows = connection.execute(
                "SELECT block_a, block_b, explanation_id FROM wiki_discrepancies WHERE page_id = ?",
                (page_id,),
            ).fetchall()
        return {
            row["explanation_id"]
            for row in rows
            if row["explanation_id"] and (row["block_a"] in removed or row["block_b"] in removed)
        }

    # -- deleting and moving materials ---------------------------------------

    def delete_preview(self, material_id: str) -> DeletePlan:
        return plan_delete(self.kb, self.graph, material_id)

    def _check_deletable(self, material_id: str) -> None:
        record = self.kb.material_repo.get(material_id)
        if record is None:
            raise NotFound("Material not found.")
        if record.status == "recording":
            raise StillRecording()
        if any(job.state == "running" for job in self.ingest.list_jobs(material_id=material_id)):
            raise MaterialBusy("This material is being added to the wiki. Wait until it finishes or stop it.")

    def delete_material(self, material_id: str) -> DeletePlan:
        self._check_deletable(material_id)
        with self.ctx.write_lock:
            plan = plan_delete(self.kb, self.graph, material_id)
            execute_delete(self.kb, plan)
            library = self.kb.require()
            append_log(library, self.ingest.settings().language, plan.title)
        self.graph.refresh()
        self._refresh_index()
        self._touch()
        return plan

    def move_material(self, material_id: str, *, title: str | None, folder_id: str | None) -> MaterialDetail:
        with self.ctx.write_lock:
            journal = move_material(self.kb, material_id, title=title, folder_id=folder_id)
        if journal:  # the lines name pages; the log gets ids and a count only
            logger.info("move %s: %d page(s) could not be updated", material_id, len(journal))
        self.graph.refresh()
        self._refresh_index()
        return self.kb.material(material_id)

    def _refresh_index(self) -> None:
        try:
            with self.ctx.write_lock:  # reads the page index, writes Wiki/index.md: one library write
                self._writer.refresh_index(self.ingest.settings().language)
        except (OSError, KnowledgeError) as error:
            logger.info("Wiki/index.md could not be refreshed: %s", error_note(error))

    # -- pages ----------------------------------------------------------------

    def page(self, page_id: str) -> PageDetail:
        view = self.kb.page(page_id)
        related, mentioned = self.graph.neighbours(page_id)

        def refs(ids: Sequence[str]) -> list[PageRefView]:
            found = []
            for other in ids:
                record = self.kb.page_repo.get(other)
                if record is not None:
                    found.append(PageRefView(record.id, record.kind, record.title))
            return found

        names = []
        for folder_id in view.folders:
            folder = self.kb.folder_repo.get(folder_id)
            if folder is not None:
                names.append(folder.name)
        updated_at = None
        with contextlib.suppress(KnowledgeError, OSError):
            stamp = (self.kb.library_root / view.rel_path).stat().st_mtime
            updated_at = (
                datetime.fromtimestamp(stamp, UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
            )
        return PageDetail(view, refs(related), refs(mentioned), names, updated_at)

    def _edited(self, page_id: str) -> PageDetail:
        self.graph.refresh()
        self._touch()
        return self.page(page_id)

    def update_block(self, page_id: str, block_id: str, text: str) -> PageDetail:
        with self.ctx.write_lock:
            update_block(self.kb, page_id, block_id, text)
        return self._edited(page_id)

    def add_note(
        self, page_id: str, text: str, *, after_block_id: str | None, section: str | None
    ) -> PageDetail:
        with self.ctx.write_lock:
            add_note(self.kb, page_id, text, after_block_id=after_block_id, section=section)
        return self._edited(page_id)

    def delete_note(self, page_id: str, block_id: str) -> PageDetail:
        with self.ctx.write_lock:
            delete_note(self.kb, page_id, block_id)
        return self._edited(page_id)

    def graph_view(self, folder_id: str | None) -> Graph:
        if folder_id is not None and self.kb.folder_repo.get(folder_id) is None:
            raise NotFound("Folder not found.")
        return self.graph.graph(folder_id)

    def rescan(self) -> int:
        """Full rescan of the library; returns how many pages were added, changed or removed."""

        def pages() -> dict[str, str]:
            return {page.id: page.file_sha256 for page in self.kb.pages()}

        before = pages()
        self.kb.rescan()
        self.kb.require()
        after = pages()
        return sum(1 for page_id in before.keys() | after.keys() if before.get(page_id) != after.get(page_id))

    # -- background -----------------------------------------------------------

    async def start(self) -> None:
        """App lifespan: watch ``Wiki/`` for outside edits and run background connections when allowed."""
        if self._loop_task is None:
            self._loop_task = asyncio.create_task(self._loop(), name="kb-wiki-watch")

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(INTERVAL_S)
            try:
                if await disk_call(self.watcher.poll):
                    await disk_call(self.graph.refresh)
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as error:  # one bad tick never stops the watcher
                logger.error("wiki watcher tick failed: %s", error_note(error))

    async def tick(self) -> JobRecord | None:
        """Start background "Find connections" when the user allowed it, SKAZ is idle and the wiki changed."""
        if not (await disk_call(self.ingest.settings)).background_connections:  # a database read
            return None
        if self.ingest.active_jobs() or self.busy:
            self._touch()
            return None
        if self.clock() - self._last_activity < self.idle_after_s:
            return None
        signature = await disk_call(self.graph.signature)
        if signature == self._background_signature:
            return None
        try:
            job = await self.find_connections()
        except KnowledgeError:
            return None
        self._background_signature = signature
        return job

    async def close(self) -> None:
        if self._loop_task is not None:
            self._loop_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._loop_task
            self._loop_task = None
        for task in list(self._post_tasks):
            task.cancel()
        if self._post_tasks:
            await asyncio.gather(*self._post_tasks, return_exceptions=True)
        await self.jobs.close()
