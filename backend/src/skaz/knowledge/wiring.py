"""Seams between the knowledge areas, connected in one place.

* The S1 instruction detector is the ingest layer-5 output check (W1).
* The decision layer the user chose *now* (D1) answers ingest's "which page"
  questions; when it is off, ingest asks the writing model and logs that.
* Wiki engines resolve through the engine registry (A2); an unknown engine
  yields ``None`` (the job fails with a plain reason) — never a silent
  substitute. Claude Code and Hermes reach the SKAZ tools through per-run
  MCP tokens of the A1 server (``McpGrants``).
* A new material (S1 documents, S2 finished speech — never a paused
  recording) is added to the wiki when the wiki settings say so (decision
  15), and a restored fragment re-runs its material (decision 41).
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Mapping, Sequence

from .agents.engine import AgentEngine, EngineId, ToolSpec
from .agents.mcp_access import McpAccess as EngineMcpAccess
from .agents.registry import ENGINE_IDS
from .decisions.protocol import Answer, DeciderId, DecisionLayer, Question, Undecided
from .ingest.service import IngestService
from .mcp.server import McpServer
from .mcp.tokens import McpRunScope
from .service import KnowledgeService
from .sources.guard.detector import Detection, detect_instruction
from .sources.service import SourceEvent, SourceService

log = logging.getLogger(__name__)

DECISIONS_OFF = "The decision layer is off; the writing model decides."


class GuardDetector:
    """S1 layer-3 detector behind the ingest ``InstructionDetector`` protocol."""

    def detect(self, text: str) -> Sequence[Detection]:
        detection = detect_instruction(text)
        return [detection] if detection is not None else []


class McpGrants:
    """A2's ``McpAccessProvider`` over the A1 MCP server: a token per run, limited to its tools."""

    def __init__(self, server: McpServer) -> None:
        self._server = server

    def grant(self, run_id: str, tools: tuple[ToolSpec, ...]) -> EngineMcpAccess:
        token = self._server.issue_mcp_token(McpRunScope(run_id, frozenset(tool.name for tool in tools)))
        return EngineMcpAccess(self._server.url, token)

    def revoke(self, run_id: str) -> None:
        self._server.revoke_run(run_id)


class CurrentDecisions:
    """Whatever decision layer is selected at the moment of each question."""

    def __init__(self, current: Callable[[], DecisionLayer | None]) -> None:
        self._current = current

    @property
    def id(self) -> DeciderId:
        layer = self._current()
        return layer.id if layer is not None else "local"

    async def ask(self, question: Question) -> Answer:
        layer = self._current()
        if layer is None:
            return Undecided(DECISIONS_OFF)
        return await layer.ask(question)

    async def ask_many(self, questions: Sequence[Question]) -> Sequence[Answer]:
        layer = self._current()
        if layer is None:
            return [Undecided(DECISIONS_OFF) for _ in questions]
        return await layer.ask_many(questions)


class AutoIngest:
    """Starts ingest from source events, which may fire on any thread."""

    def __init__(self, kb: KnowledgeService, ingest: IngestService) -> None:
        self._kb = kb
        self._ingest = ingest
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def wants(self, event: SourceEvent) -> bool:
        if event.kind == "fragment_restored":
            return True
        material = self._kb.material_repo.get(event.material_id)
        if material is None:
            return False
        settings = self._ingest.settings()
        return settings.auto_add_text if material.kind == "text" else settings.auto_add_files_links

    def material_finished(self, material_id: str) -> None:
        """A recording was stopped or an import completed (speech, S2)."""
        self(SourceEvent("material_ready", material_id))

    def __call__(self, event: SourceEvent) -> None:
        if not self.wants(event):
            return
        coroutine = self._start(event.material_id)
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is not None:
            running.create_task(coroutine)
        elif self._loop is not None and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(coroutine, self._loop)
        else:
            coroutine.close()
            log.warning("No running loop to add material %s to the wiki", event.material_id)

    async def _start(self, material_id: str) -> None:
        try:
            await self._ingest.request_ingest(material_id)
        except Exception:
            # Busy (already running) or not ready: the user can still press "Add to wiki".
            log.info("Automatic ingest of %s did not start", material_id, exc_info=True)


def engine_resolver(engines: Mapping[EngineId, AgentEngine],
                    default: Callable[[], str]) -> Callable[[str | None], AgentEngine | None]:
    """The wiki engine, or the app's default engine (Settings → Models) when none is chosen."""
    def resolve(engine_id: str | None) -> AgentEngine | None:
        wanted = engine_id or default()
        return engines.get(wanted) if wanted in ENGINE_IDS else None

    return resolve


def wire(
    kb: KnowledgeService,
    ingest: IngestService,
    sources: SourceService,
    decisions: Callable[[], DecisionLayer | None],
    engines: Mapping[EngineId, AgentEngine],
    default_engine: Callable[[], str] = lambda: "codex",
) -> AutoIngest:
    ingest.detector = GuardDetector()
    ingest.decisions = CurrentDecisions(decisions)
    ingest.engines = engine_resolver(engines, default_engine)
    auto = AutoIngest(kb, ingest)
    sources.subscribe(auto)
    return auto
