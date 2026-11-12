"""EX2: the wiki agent gives each wiki material one of the user's topics (``topic › subtopic``).

A material is labelled once: at the end of its wiki processing, through the same agent and profile as its
ingest (``MaterialLabeller``, the ``TopicLabeller`` seam of ingest), or — for materials already in the wiki —
by the "Sort materials" job the user starts on the map (``TopicSorting``, job kind ``topics``, ~20 materials
per call). The agent sees the material's title, its concept titles and the existing topic paths, and answers
an existing path verbatim or a new one. Reading the map never calls the agent.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import uuid4

from pydantic import BaseModel, ConfigDict

from ...native_io import disk_call
from ..agents.engine import TurnMessage
from ..agents.update_gate import holding
from ..api.contract_routes import ContractFailure
from ..api.schemas_areas import KbTopicLabelling
from ..ingest.jobs import AGENT_UNAVAILABLE, ENGINE_LIMIT, JobRecord
from ..ingest.model import AnswerInvalid, parse_answer
from ..ingest.prompts import language_name, repair_message
from ..ingest.protocols import AskAgent, TopicRequest
from ..ingest.settings import read_settings
from ..logsafe import error_note
from ..service import KnowledgeService
from . import prompts
from .topics import TopicStore

if TYPE_CHECKING:
    from ..ingest.service import IngestService
    from ..wiki.jobs import JobContext, WikiJobs

logger = logging.getLogger(__name__)
#: Materials per agent call of the sorting job (decision G2-1: ~20 per call).
BATCH = 20
#: Concept titles per material in the prompt.
CONCEPTS_PER_MATERIAL = 25
JOB_KIND = "topics"
NO_ENGINE = "No agent is ready to sort materials. Choose the wiki agent in Settings → Models, then retry."
#: ``KbTopicLabelling.reason_code`` values (besides ``None``).
REASON_NOT_READY = "not_ready"
REASON_NO_ENGINE = "no_wiki_engine"
REASON_ENGINE_LIMIT = "engine_limit"
REASON_FAILED = "failed"
REASON_INTERRUPTED = "interrupted"


class _Assignment(BaseModel):
    model_config = ConfigDict(extra="ignore")
    item: int
    topic: str
    subtopic: str = ""


class _Answer(BaseModel):
    model_config = ConfigDict(extra="ignore")
    materials: list[_Assignment]


@dataclass(frozen=True)
class BatchOutcome:
    labelled: int
    #: Topics the answer created (their hidden label is made afterwards).
    created: tuple[str, ...]
    #: The answer could not be read even after one repair: the batch stays unsorted.
    unreadable: bool = False


def _split_path(topic: str, subtopic: str) -> tuple[str, str]:
    """An answer may put the whole ``Topic › Subtopic`` path into ``topic``."""
    if not subtopic.strip():
        for mark in ("›", ">", "/"):
            if mark in topic:
                head, _, tail = topic.partition(mark)
                return head, tail
    return topic, subtopic


class TopicLabels:
    """The shared core: the prompt for some materials and applying the agent's answer."""

    def __init__(self, topics: TopicStore) -> None:
        self.topics = topics

    def prompt(self, material_ids: Sequence[str]) -> str:
        records = {record.id: record for record in self.topics.kb.material_repo.list_all()}
        concepts = self.topics.concept_titles(material_ids, CONCEPTS_PER_MATERIAL)
        listed = [
            (records[mid].title if mid in records else "(untitled)", concepts.get(mid, []))
            for mid in material_ids
        ]
        return prompts.label_prompt(self.topics.paths(), listed)

    def apply(self, material_ids: Sequence[str], answer: _Answer) -> BatchOutcome:
        labelled = 0
        created: list[str] = []
        seen: set[int] = set()
        for entry in answer.materials:
            if entry.item in seen or not 1 <= entry.item <= len(material_ids):
                continue  # a number the prompt did not give, or a second path for one material
            seen.add(entry.item)
            topic, subtopic = _split_path(entry.topic, entry.subtopic)
            try:
                leaf, new = self.topics.ensure_path(topic, subtopic or None)
            except ValueError:
                continue  # an empty name: the material stays unsorted
            created += new
            if self.topics.label(material_ids[entry.item - 1], leaf, "agent"):
                labelled += 1
        return BatchOutcome(labelled, tuple(created))

    async def ask(self, ask: AskAgent, material_ids: Sequence[str], language: str) -> BatchOutcome:
        """One call for these materials (one structure repair, as every wiki answer)."""
        instructions = prompts.LABEL_INSTRUCTIONS.replace("{language}", language_name(language))
        messages = [TurnMessage("user", await disk_call(self.prompt, material_ids))]
        for attempt in range(2):
            text = await ask(instructions, messages, prompts.LABEL_SCHEMA)
            try:
                answer = parse_answer(text, _Answer)
            except AnswerInvalid as error:
                if attempt == 1:
                    return BatchOutcome(0, (), unreadable=True)
                messages += [TurnMessage("assistant", text), TurnMessage("user", repair_message(str(error)))]
                continue
            return await disk_call(self.apply, material_ids, answer)
        return BatchOutcome(0, (), unreadable=True)


class MaterialLabeller:
    """``TopicLabeller`` of ingest: the material just written gets its topic from the same agent."""

    def __init__(self, labels: TopicLabels, after_new_topics: Callable[[], None]) -> None:
        self.labels = labels
        self.after_new_topics = after_new_topics

    async def label(self, request: TopicRequest) -> str | None:
        current = await disk_call(self.labels.topics.labels)
        found = current.get(request.material_id)
        if found is not None and found[1] == "user":
            return found[0]  # the user's choice stays; re-processing never overrides it
        outcome = await self.labels.ask(request.ask, [request.material_id], request.language)
        if outcome.unreadable or not outcome.labelled:
            await request.log("The topic answer could not be used; Sort materials on the Explore map sorts "
                              "this material later.")
            return None
        if outcome.created:
            await request.log(f"New topic(s) on the Explore map: {len(outcome.created)}.")
            self.after_new_topics()
        labelled = (await disk_call(self.labels.topics.labels)).get(request.material_id)
        return labelled[0] if labelled is not None else None


class TopicSorting:
    """The "Sort materials" job (kind ``topics``) over the wiki jobs: WR5 quota pauses apply, a paused job
    continues on the next click (or at the reset while SKAZ runs); after Quit it is interrupted (paid work
    never resumes by itself) and the next click sorts what is still unsorted."""

    def __init__(
        self,
        kb: KnowledgeService,
        labels: TopicLabels,
        *,
        ingest: Callable[[], IngestService | None],
        wiki_jobs: Callable[[], WikiJobs | None],
        after_new_topics: Callable[[], None],
    ) -> None:
        self.kb = kb
        self.labels = labels
        self._ingest = ingest
        self._wiki_jobs = wiki_jobs
        self.after_new_topics = after_new_topics
        self._start = asyncio.Lock()

    # -- state ----------------------------------------------------------------

    def _engine_id(self) -> tuple[bool, str | None]:
        """(wired, the wiki engine's id or ``None`` when no agent is ready)."""
        ingest = self._ingest()
        if ingest is None or self._wiki_jobs() is None or ingest.engines is None:
            return False, None
        engine = ingest.engines(read_settings(self.kb.settings).engine)
        return True, engine.id if engine is not None else None

    def latest_job(self) -> JobRecord | None:
        ingest = self._ingest()
        if ingest is None:
            return None
        return next((job for job in ingest.jobs.list_all() if job.kind == JOB_KIND), None)

    def state(self) -> KbTopicLabelling:
        """Stored state only (no agent call): what the map shows about sorting."""
        wired, engine = self._engine_id()
        job = self.latest_job()
        job_engine = job.execution.profile.engine if job is not None and job.execution is not None else None
        if job is not None and job.state == "running":
            return KbTopicLabelling(
                state="running", job_id=job.id, done=job.counters.get("parts_done", 0),
                total=job.counters.get("parts_total", 0), reason_code=None, engine=job_engine or engine,
            )
        if job is not None and job.state == "paused" and job.error_code == ENGINE_LIMIT:
            return KbTopicLabelling(
                state="paused", job_id=job.id, done=job.counters.get("parts_done", 0),
                total=job.counters.get("parts_total", 0), reason_code=REASON_ENGINE_LIMIT,
                engine=job_engine or engine,
            )
        if not wired:
            return KbTopicLabelling(state="not_ready", job_id=None, done=0, total=0,
                                    reason_code=REASON_NOT_READY, engine=None)
        if engine is None:
            return KbTopicLabelling(state="not_ready", job_id=None, done=0, total=0,
                                    reason_code=REASON_NO_ENGINE, engine=None)
        reason = None
        if job is not None and job.state == "failed":
            reason = REASON_FAILED
        elif job is not None and job.state == "interrupted":
            reason = REASON_INTERRUPTED
        return KbTopicLabelling(state="idle", job_id=job.id if job is not None else None, done=0, total=0,
                                reason_code=reason, engine=engine)

    # -- the click --------------------------------------------------------------

    async def start(self) -> KbTopicLabelling:
        """Start sorting the unsorted wiki materials, or continue a sorting paused at a usage limit."""
        async with self._start:
            ingest, jobs = self._ingest(), self._wiki_jobs()
            wired, engine = await disk_call(self._engine_id)
            if ingest is None or jobs is None or not wired:
                raise ContractFailure(503, "not_ready")
            latest = await disk_call(self.latest_job)
            if latest is not None and latest.state == "running":
                return await disk_call(self.state)
            if latest is not None and latest.state == "paused" and latest.error_code == ENGINE_LIMIT:
                try:
                    await ingest.continue_job(latest.id)
                    return await disk_call(self.state)
                except Exception as error:  # its work is gone (SKAZ restarted): a new job sorts the rest
                    logger.info("sorting job %s could not continue: %s", latest.id, error_note(error))
                    await disk_call(ingest.jobs.cancel_waiting, latest.id, "Continued in another job.")
            if engine is None:
                raise ContractFailure(503, "not_ready")
            if not await disk_call(self.labels.topics.unsorted_material_ids):
                return await disk_call(self.state)
            await jobs.start(JOB_KIND, None, "sorting_topics", self._work)  # type: ignore[arg-type]
            return await disk_call(self.state)

    async def _work(self, job: JobContext) -> None:
        from ..wiki.agent import AgentCaller, WikiJobFailed

        ingest = self._ingest()
        if ingest is None or ingest.engines is None:
            raise WikiJobFailed(NO_ENGINE, AGENT_UNAVAILABLE)
        settings = ingest.settings()  # the job's pinned profile (its execution scope)
        engine = ingest.engines(settings.engine)
        if engine is None:
            raise WikiJobFailed(NO_ENGINE, AGENT_UNAVAILABLE)
        caller = AgentCaller(engine, f"topics-{uuid4().hex[:8]}")
        record = await disk_call(job.jobs.get, job.job_id)
        done_before = record.counters.get("parts_done", 0) if record is not None else 0
        async with holding(engine):  # U1: an agent update waits for the whole job
            remaining = await disk_call(self.labels.topics.unsorted_material_ids)
            total = done_before + len(remaining)
            await job.count(parts_total=total, parts_done=done_before)
            done, labelled, unreadable, created = done_before, 0, 0, 0
            for start in range(0, len(remaining), BATCH):
                batch = remaining[start:start + BATCH]
                outcome = await self.labels.ask(caller.ask, batch, settings.language)
                done += len(batch)
                labelled += outcome.labelled
                created += len(outcome.created)
                if outcome.unreadable:
                    unreadable += len(batch)
                await job.count(parts_done=done)
                if outcome.created:
                    self.after_new_topics()
        line = f"Sorted {labelled} of {len(remaining)} material(s) into topics; {created} new topic(s)."
        if unreadable:
            line += f" {unreadable} material(s) came back in a form SKAZ couldn't read and stay unsorted."
        await job.log(line)

