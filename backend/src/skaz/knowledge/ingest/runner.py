"""One ingest job end to end: read → Notes → Concepts → match → write → hooks.

Model calls go through ``AgentEngine.run`` with ``tools=None`` (layer 1) and a
JSON schema; the source is wrapped as untrusted data (layer 6). Long sources
are cut into parts by fragments; a part may take several answers (``more``).
Technical guards as in DETAILED-NOTES-SPEC — a bounded number of answers and
characters per operation — end the job with an honest error, never with
shortened notes.
"""
from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any

from ...native_io import disk_call
from ..agents.engine import AgentEngine, AgentTurn, Failed, TurnMessage, collect
from ..decisions.protocol import DecisionLayer
from ..errors import NotFound
from ..markdown.source import Fragment
from ..service import KnowledgeService
from ..skills import SkazSkill
from . import prompts
from .checks import CheckedBlock, CheckStats, check_statement, clean_text, clean_title, flags_instructions
from .drafts import ConceptDraft, DraftSection
from .jobs import JobRepository, JobStep, agent_failure_code, agent_failure_text
from .matching import decide, find_candidates
from .model import AnswerInvalid, BlockOut, ConceptsOut, MatchOut, NotesOut, parse_answer
from .pages import match_key
from .protocols import ConceptUpdateHook, InstructionDetector, RecognitionCheck, RecognitionRequest, TextLayer
from .sources import DEFAULT_PART_BUDGET, ExclusionsUnreadable, IngestSource, load_source, split_parts
from .writer import ConceptTarget, WikiWriter, WritePlan, WriteResult

BLOCKED_KIND = "blocked_output"
SPEECH_KINDS = frozenset({"recording", "audio", "video", "video_link"})
EXCERPT_CHARS = 300


class IngestCancelled(Exception):
    pass


class IngestFailed(Exception):
    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        #: ``JobRecord.error_code`` (``AGENT_UNAVAILABLE``: fixed in Settings, not by a retry).
        self.code = code


@dataclass(frozen=True)
class Limits:
    part_budget: int = DEFAULT_PART_BUDGET
    #: Answers per multipart operation (Notes, Concepts), as in DETAILED-NOTES-SPEC.
    max_answers: int = 64
    #: Characters of statements per operation.
    max_chars: int = 200_000
    #: Retries of one model call that failed only because the engine was busy or the network dropped.
    transient_retries: int = 3
    #: Seconds before each such retry (the last value repeats).
    retry_delays_s: tuple[float, ...] = (5.0, 15.0, 30.0)


@dataclass
class _Operation:
    name: str
    answers: int = 0
    chars: int = 0


@dataclass
class RunReport:
    result: WriteResult | None = None
    stats: CheckStats = field(default_factory=CheckStats.empty)
    blocked: list[dict[str, str]] = field(default_factory=list)


class IngestRun:
    def __init__(self, *, kb: KnowledgeService, jobs: JobRepository, job_id: str, material_id: str,
                 engine: AgentEngine, detector: InstructionDetector, decisions: DecisionLayer | None,
                 text_layer: TextLayer, writer: WikiWriter, hook: ConceptUpdateHook | None, language: str,
                 limits: Limits, recognition: RecognitionCheck | None = None,
                 skills: Sequence[SkazSkill] = ()) -> None:
        self.kb = kb
        self.jobs = jobs
        self.job_id = job_id
        self.material_id = material_id
        self.engine = engine
        self.detector = detector
        self.decisions = decisions
        self.text_layer = text_layer
        self.writer = writer
        self.hook = hook
        self.language = language
        self.limits = limits
        self.recognition = recognition
        #: SKAZ skills that were on when the job started (Humanizer, H2): in the writing prompts only.
        self.skills = tuple(skills)
        self.report = RunReport()
        self.current_run: str | None = None
        self.writing = False
        self.cancel_requested = False
        self._runs = 0
        self._counters: dict[str, int] = {}

    # -- bookkeeping --------------------------------------------------------

    async def _step(self, step: JobStep) -> None:
        await disk_call(self.jobs.set_step, self.job_id, step)

    async def _count(self, **values: int) -> None:
        self._counters.update(values)
        await disk_call(self.jobs.update_counters, self.job_id, dict(values))

    async def _log(self, message: str) -> None:
        await disk_call(self.jobs.log, self.job_id, message)

    # -- model calls --------------------------------------------------------

    async def _ask(self, instructions: str, messages: Sequence[TurnMessage], schema: dict[str, Any]) -> str:
        """One model call; a call that failed only because the engine was busy or the network dropped
        is retried a few times after a pause instead of failing the whole material."""
        for attempt in range(self.limits.transient_retries + 1):
            terminal, text = await self._call(instructions, messages, schema)
            if terminal is None:
                return text
            if terminal.kind == "cancelled" or self.cancel_requested:
                raise IngestCancelled()
            retryable = terminal.transient or terminal.kind == "network"
            if retryable and attempt < self.limits.transient_retries:
                delays = self.limits.retry_delays_s or (0.0,)
                await self._log("The agent was busy or offline; trying the same step again shortly.")
                await asyncio.sleep(delays[min(attempt, len(delays) - 1)])
                continue
            when = ""
            if terminal.retry_at is not None:
                when = f" It should work again after {terminal.retry_at.isoformat()}."
            raise IngestFailed(agent_failure_text(terminal.kind, terminal.message) + when,
                               agent_failure_code(terminal.kind))
        raise AssertionError("unreachable")

    async def _call(self, instructions: str, messages: Sequence[TurnMessage],
                    schema: dict[str, Any]) -> tuple[Failed | None, str]:
        if self.cancel_requested:
            raise IngestCancelled()
        self._runs += 1
        run_id = f"{self.job_id}-{self._runs}"
        self.current_run = run_id
        turn = AgentTurn(run_id=run_id, messages=tuple(messages), instructions=instructions, tools=None,
                         response_schema=schema)
        try:
            result = await collect(self.engine.run(turn))
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):  # stop the turn at the engine too, then go
                await self.engine.interrupt(run_id)
            raise
        finally:
            self.current_run = None
        terminal = result.terminal
        if isinstance(terminal, Failed):
            return terminal, ""
        return None, result.text

    async def _answers(self, operation: _Operation, instructions: str, prompt: str, schema: dict[str, Any],
                       model: type[NotesOut] | type[ConceptsOut]) -> AsyncIterator[NotesOut | ConceptsOut]:
        """Answers for one part until ``more`` is false; one structure repair per answer."""
        messages = [TurnMessage("user", prompt)]
        previous: str | None = None
        while True:
            parsed = None
            text = ""
            for attempt in range(2):
                operation.answers += 1
                if operation.answers > self.limits.max_answers:
                    raise IngestFailed(
                        f"The {operation.name} needed more than {self.limits.max_answers} answers, the "
                        "technical limit for one material. Nothing was saved; split the material and retry.")
                text = await self._ask(instructions, messages, schema)
                if previous is not None and text.strip() == previous.strip():
                    raise IngestFailed(f"The agent repeated its previous answer while writing the "
                                       f"{operation.name}. Nothing was saved; retry.")
                try:
                    parsed = parse_answer(text, model)
                except AnswerInvalid as error:
                    if attempt == 1:
                        raise IngestFailed(f"The agent's answer for the {operation.name} was not in the "
                                           "expected format, twice. Nothing was saved; retry.") from error
                    messages += [TurnMessage("assistant", text, self.engine.id),
                                 TurnMessage("user", prompts.repair_message(str(error)))]
                    continue
                break
            assert parsed is not None
            previous = text
            yield parsed
            if not parsed.more:
                return
            messages += [TurnMessage("assistant", text, self.engine.id),
                         TurnMessage("user", prompts.CONTINUE_MESSAGE)]

    def _spend(self, operation: _Operation, blocks: Sequence[BlockOut]) -> None:
        operation.chars += sum(len(block.text) for block in blocks)
        if operation.chars > self.limits.max_chars:
            raise IngestFailed(
                f"The {operation.name} grew beyond {self.limits.max_chars:,} characters, the technical "
                "limit for one material. Nothing was saved, and nothing was shortened; split the material "
                "and retry.")

    # -- checks -------------------------------------------------------------

    def _blocked(self, where: str, kind: str, text: str) -> None:
        self.report.stats.blocked += 1
        self.report.blocked.append({"where": where, "kind": kind, "text": text[:EXCERPT_CHARS]})

    def _check(self, block: BlockOut, source: IngestSource, fragments: dict[int, Fragment],
               where: str) -> CheckedBlock | None:
        if flags_instructions(self.detector, block.text, clean_text(block.text), *block.links):
            self._blocked(where, block.kind, block.text)
            return None
        checked = check_statement(block, fragments, source.excluded)
        if isinstance(checked, str):
            self.report.stats.dropped[checked] += 1
            return None
        return checked

    # -- phases -------------------------------------------------------------

    async def _notes(self, source: IngestSource, parts: Sequence[Sequence[Fragment]]) -> list[DraftSection]:
        fragments = source.by_seg()
        operation = _Operation("notes")
        instructions = prompts.instructions_for(prompts.NOTES_INSTRUCTIONS, self.language, skills=self.skills)
        sections: list[DraftSection] = []
        for index, part in enumerate(parts, start=1):
            prompt = prompts.notes_prompt(source.title, part, index, len(parts),
                                          [section.title for section in sections])
            answers = self._answers(operation, instructions, prompt, prompts.NOTES_SCHEMA, NotesOut)
            async for answer in answers:
                assert isinstance(answer, NotesOut)
                for section in answer.sections:
                    self._spend(operation, section.blocks)
                    title = clean_title(section.title) or f"Part {index}"
                    if flags_instructions(self.detector, section.title, title):
                        for block in section.blocks:
                            self._blocked(f"Notes · section {index}", block.kind, block.text)
                        continue
                    checked = [found for found in (self._check(block, source, fragments, f"Notes · {title}")
                                                   for block in section.blocks) if found is not None]
                    if sections and match_key(sections[-1].title) == match_key(title):
                        sections[-1].blocks.extend(checked)
                    else:
                        sections.append(DraftSection(title, checked))
            await self._count(parts_done=index, notes_answers=operation.answers)
        return [section for section in sections if section.blocks]

    async def _concepts(self, source: IngestSource,
                        parts: Sequence[Sequence[Fragment]]) -> list[ConceptDraft]:
        fragments = source.by_seg()
        operation = _Operation("concepts")
        instructions = prompts.instructions_for(prompts.CONCEPTS_INSTRUCTIONS, self.language,
                                                skills=self.skills)
        drafts: list[ConceptDraft] = []
        for index, part in enumerate(parts, start=1):
            prompt = prompts.concepts_prompt(source.title, part, index, len(parts),
                                             [draft.display_title for draft in drafts])
            async for answer in self._answers(operation, instructions, prompt, prompts.CONCEPTS_SCHEMA,
                                              ConceptsOut):
                assert isinstance(answer, ConceptsOut)
                for concept in answer.concepts:
                    self._spend(operation, concept.definition_blocks)
                    names = [concept.title_in_wiki_language, concept.original or "", *concept.aliases,
                             *concept.related]
                    title = clean_title(concept.title_in_wiki_language)
                    if flags_instructions(self.detector, *names, *(clean_title(name) for name in names)):
                        self._blocked("Concept title", "title", concept.title_in_wiki_language)
                        for block in concept.definition_blocks:
                            self._blocked("Concept", block.kind, block.text)
                        continue
                    if not title:
                        self.report.stats.dropped["concept_bad_name"] += 1
                        continue
                    original = clean_title(concept.original or "") or None
                    checked = (self._check(block, source, fragments, f"Concept · {title}")
                               for block in concept.definition_blocks)
                    draft = ConceptDraft(
                        title=title, original=original,
                        aliases=[alias for alias in (clean_title(item) for item in concept.aliases) if alias],
                        blocks=[found for found in checked if found is not None],
                        related=[name for name in (clean_title(item) for item in concept.related) if name],
                    )
                    same = next((known for known in drafts if known.keys() & draft.keys()), None)
                    if same is not None:
                        same.absorb(draft)
                    else:
                        drafts.append(draft)
                    await self._count(concepts_found=len(drafts))
            await self._count(concepts_answers=operation.answers)
        return drafts

    async def _ask_agent_choice(self, state: str, candidates: Sequence[str]) -> int | None:
        text = await self._ask(prompts.MATCH_INSTRUCTIONS,
                               [TurnMessage("user", prompts.match_prompt(state, candidates))],
                               prompts.MATCH_SCHEMA)
        try:
            return parse_answer(text, MatchOut).choice
        except AnswerInvalid:
            return None

    async def _match(self, drafts: Sequence[ConceptDraft]) -> list[ConceptTarget]:
        targets = []
        for draft in drafts:
            if not any(block.kind == "from_source" for block in draft.blocks):
                self.report.stats.dropped["concept_without_source"] += 1
                continue
            candidates = await disk_call(find_candidates, self.kb, draft)
            decision = await decide(draft, candidates, self.decisions, self._ask_agent_choice)
            if decision.note:
                await self._log(f"Concept match: {decision.note}")
            targets.append(ConceptTarget(draft, decision.page_id))
        return targets

    # -- the job ------------------------------------------------------------

    async def execute(self) -> RunReport:
        await self._step("reading")
        record = await disk_call(self.kb.material_repo.get, self.material_id)
        if record is None:
            raise IngestFailed("The material is no longer in the library.")
        if record.status != "ready":
            raise IngestFailed("The material is not ready yet. Add it to the wiki when its processing "
                               "finishes.")
        library = self.kb.require()
        try:
            source = await disk_call(load_source, library, self.material_id, record.rel_dir, self.text_layer)
        except ExclusionsUnreadable as error:
            raise IngestFailed("SKAZ can't read the list of excluded fragments of this material, so it won't "
                               "add it to the wiki. Check the material and retry.") from error
        except NotFound as error:
            raise IngestFailed(error.message) from error
        if source.excluded:
            await self._log(f"{len(source.excluded)} excluded fragment(s) were left out.")
        if self.recognition is not None and record.kind in SPEECH_KINDS:
            # Area W2: recognition errors are corrected (as a separate layer) before the notes are written.
            await self._step("checking_recognition")
            request = RecognitionRequest(self.material_id, record.kind, source.excluded, self._ask, self._log)
            if await self.recognition.check(request):
                source = await disk_call(load_source, library, self.material_id, record.rel_dir,
                                         self.text_layer)
        if not source.fragments:
            raise IngestFailed("This material has no text the wiki can use.")
        parts = split_parts(source.fragments, self.limits.part_budget)
        await self._count(parts_total=len(parts), parts_done=0, fragments=len(source.fragments))

        await self._step("writing_notes")
        sections = await self._notes(source, parts)
        if not any(block.kind == "from_source" for section in sections for block in section.blocks):
            raise IngestFailed("No statement of the notes passed the source check, so nothing was saved. "
                               "Retry.")

        await self._step("concepts")
        drafts = await self._concepts(source, parts)
        targets = await self._match(drafts)
        if self.cancel_requested:
            raise IngestCancelled()

        await self._step("saving")
        self.writing = True
        plan = WritePlan(self.material_id, record.rel_dir, self.language, sections, targets)
        result = await disk_call(self.writer.write, plan)
        self.report.result = result
        for message in result.journal:
            await self._log(message)
        for reason, count in result.dropped.items():
            self.report.stats.dropped[reason] += count
        stats = self.report.stats
        await self._count(blocks_written=result.blocks_written, blocks_dropped=stats.dropped_total,
                          blocks_blocked=stats.blocked, concepts_created=len(result.created),
                          concepts_updated=len(result.updated))
        await self._log(self._summary(result))
        await self._run_hooks(result)
        return self.report

    def _summary(self, result: WriteResult) -> str:
        stats = self.report.stats
        line = (f"Saved {result.blocks_written} statement(s); {len(result.created)} new and "
                f"{len(result.updated)} updated concept page(s).")
        if stats.dropped:
            reasons = ", ".join(f"{reason.replace('_', ' ')} {count}"
                                for reason, count in sorted(stats.dropped.items()))
            line += f" Left out by the source check: {stats.dropped_total} ({reasons})."
        if stats.blocked:
            line += f" Blocked as instructions to an AI: {stats.blocked}."
        return line

    async def _run_hooks(self, result: WriteResult) -> None:
        if self.hook is None:
            return
        for page_id, block_ids in result.new_blocks.items():
            try:
                await self.hook.on_concept_updated(page_id, block_ids)
            except asyncio.CancelledError:
                raise
            except Exception:  # pages are written; a failed check is reported, not fatal
                await self._log("The discrepancy check could not run for one updated concept page.")
