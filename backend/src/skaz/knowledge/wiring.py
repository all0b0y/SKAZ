"""Seams between the knowledge areas, connected in one place.

* The S1 instruction detector is the ingest layer-5 output check (W1).
* The decision layer the user chose *now* (D1) answers ingest's "which page"
  questions; when it is off, ingest asks the writing model and logs that.
* Wiki engines resolve through the engine registry (A2); an unknown engine
  yields ``None`` (the job fails with a plain reason) — never a silent
  substitute. Claude Code and Hermes reach the SKAZ tools through per-run
  MCP tokens of the A1 server (``McpGrants``).
* The wiki after ingest (W2): recognition corrections and their check, the
  discrepancy hook, notification actions (``wire_wiki``).
* The first finished recording offers the local decision model once, when no
  decision provider is chosen (``corrections/offer.py``, user decision X2-8).
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
from .corrections.offer import AutoFixesOffer
from .decisions.protocol import Answer, DeciderId, DecisionLayer, Question, Undecided
from .decisions.service import DecisionService
from .ingest.service import IngestService
from .logsafe import error_note
from .mcp.server import McpServer
from .mcp.tokens import McpRunScope
from .service import KnowledgeService
from .sources.guard.detector import Detection, detect_instruction
from .sources.service import SourceEvent, SourceService
from .speech.link_failures import LinkFailures
from .speech.service import SpeechService
from .wiki.service import WikiService

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

    def __init__(self, current: Callable[[], DecisionLayer | None],
                 ready: Callable[[], bool] | None = None) -> None:
        self._current = current
        self._ready = ready

    def ready(self) -> bool:
        """A layer is chosen and can answer (local model downloaded / cloud consent and key)."""
        if self._current() is None:
            return False
        return self._ready() if self._ready is not None else True

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


#: Settings key of the user's "to wiki" choice for a speech material still being imported (decision 15).
CHOICE_KEY = "wiki.add_choice."


class AutoIngest:
    """Starts ingest from source events, which may fire on any thread.

    Decision 15: the "to wiki" switch of a new file, link or text is the user's, whatever Settings →
    Wiki says (the settings only give its default). Documents carry the choice in their event; an
    audio/video import finishes later, so its choice is kept (``remember``) until it does — in the
    knowledge settings, so an import resumed after a restart still follows it.
    """

    def __init__(self, kb: KnowledgeService, ingest: IngestService) -> None:
        self._kb = kb
        self._ingest = ingest
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def remember(self, material_id: str, to_wiki: bool | None) -> None:
        """The user's choice for a material that becomes ready later (speech import, video link)."""
        if to_wiki is not None:
            self._kb.settings.set(CHOICE_KEY + material_id, to_wiki)

    def _choice(self, material_id: str) -> bool | None:
        value = self._kb.settings.get(CHOICE_KEY + material_id)
        if value is None:
            return None
        self._kb.settings.set(CHOICE_KEY + material_id, None)
        return value is True

    def wants(self, event: SourceEvent) -> bool:
        if event.kind == "fragment_restored":
            return True
        choice = event.to_wiki if event.to_wiki is not None else self._choice(event.material_id)
        if choice is not None:
            return choice
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
        except Exception as error:
            # Busy (already running) or not ready: the user can still press "Add to wiki".
            # Ids and types only: the reason can name the material (logsafe).
            log.info("Automatic ingest of %s did not start: %s", material_id, error_note(error))


def engine_resolver(engines: Mapping[EngineId, AgentEngine],
                    default: Callable[[], str]) -> Callable[[str | None], AgentEngine | None]:
    """The wiki engine, or the app's default engine (Settings → Models) when none is chosen."""
    def resolve(engine_id: str | None) -> AgentEngine | None:
        wanted = engine_id or default()
        return engines.get(wanted) if wanted in ENGINE_IDS else None

    return resolve


def wire_wiki(wiki: WikiService) -> WikiService:
    """Area W2: corrections layer, recognition check, discrepancy hook, notification kinds (one line)."""
    wiki.connect()
    return wiki


def wire(
    kb: KnowledgeService,
    ingest: IngestService,
    sources: SourceService,
    decisions: Callable[[], DecisionLayer | None],
    engines: Mapping[EngineId, AgentEngine],
    default_engine: Callable[[], str] = lambda: "codex",
    decisions_ready: Callable[[], bool] | None = None,
) -> AutoIngest:
    ingest.detector = GuardDetector()
    ingest.decisions = CurrentDecisions(decisions, decisions_ready)
    ingest.engines = engine_resolver(engines, default_engine)
    auto = AutoIngest(kb, ingest)
    sources.subscribe(auto)
    return auto


def wire_speech(kb: KnowledgeService, speech: SpeechService) -> LinkFailures:
    """S3: a video link that fails after it was added raises ``link_failed`` with its actions."""
    failures = LinkFailures(kb, speech)
    failures.register()
    return failures


def wire_fixes_offer(kb: KnowledgeService, speech: SpeechService,
                     decisions: DecisionService) -> AutoFixesOffer:
    """X2-8: the one-time "turn on automatic fixes" offer at the first finished recording."""
    offer = AutoFixesOffer(kb, decisions)
    offer.register()
    speech.on_finished(offer.material_finished)
    return offer
