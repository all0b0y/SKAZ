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
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from ...native_io import disk_call
from ..agents.engine import AgentEngine, AgentTurn, Failed, TurnMessage
from ..decisions.protocol import DecisionLayer
from ..errors import NotFound
from ..markdown.source import Fragment
from ..service import KnowledgeService
from . import prompts
from .budget import BudgetReached
from .checkpoints import Checkpoints, profile_label, source_fingerprint, step_key
from .checks import CheckedBlock, CheckStats, check_statement, clean_text, clean_title, flags_instructions
from .drafts import ConceptDraft, DraftSection
from .execution import (
    RETRY_DELAYS_S,
    STOP_KINDS,
    UNSENT_RETRIES,
    current_execution,
    never_sent,
    retry_unsent,
    run_wiki_turn,
)
from .jobs import JobRepository, JobStep, agent_failure_code, agent_failure_text
from .matching import decide, find_candidates
from .model import (
    AnswerInvalid,
    BlockOut,
    ConceptOut,
    ConceptsOut,
    MatchOut,
    NotesOut,
    SectionOut,
    parse_answer,
)
from .pages import match_key
from .protocols import ConceptUpdateHook, InstructionDetector, RecognitionCheck, RecognitionRequest, TextLayer
from .repetition import RepeatGuard, Repeating
from .sources import DEFAULT_PART_BUDGET, ExclusionsUnreadable, IngestSource, load_source, split_parts
from .stream import ItemStream
from .writer import ConceptTarget, WikiWriter, WritePlan, WriteResult

BLOCKED_KIND = "blocked_output"
# STOP_KINDS: a break the answer doesn't continue past by itself (C1-f): the next call would fail the
# same way. Its finished items stay in the checkpoint, so Retry continues from them.
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
    #: Retries of one model call that failed before it was sent (engine busy, couldn't start).
    #: A failure after it may have been sent gets exactly one retry (user decision, 2026-10-20).
    transient_retries: int = UNSENT_RETRIES
    #: Seconds before each such retry (the last value repeats).
    retry_delays_s: tuple[float, ...] = RETRY_DELAYS_S


@dataclass
class _Operation:
    name: str
    answers: int = 0
    chars: int = 0
    #: Items (sections / concepts) of the answers already taken.
    kept: int = 0


Item = SectionOut | ConceptOut


def _words(item: Item) -> tuple[str, list[str]]:
    if isinstance(item, SectionOut):
        return item.title, [block.text for block in item.blocks]
    return item.title_in_wiki_language, [block.text for block in item.definition_blocks]


@dataclass
class _Live:
    """One answer of a Notes/Concepts operation, read while it streams (C1-f): every finished item
    is checked for going round in circles, kept in the checkpoint at once and counted for the
    progress line. ``synthetic()`` is the answer so far as one that says there is ``more``."""

    unit: str
    item_model: type[SectionOut] | type[ConceptOut]
    guard: RepeatGuard
    progress: Callable[[int], Awaitable[None]]
    operation: _Operation
    save: Callable[[str], Awaitable[None]] | None = None
    items: list[dict[str, Any]] = field(default_factory=list)
    stream: ItemStream | None = None
    #: Items of this step now in its checkpoint (the latest ``save``), for an honest failure text.
    saved: int = 0

    def reset(self) -> None:
        self.stream = ItemStream(self.unit)
        self.items = []

    def synthetic(self) -> str:
        return json.dumps({self.unit: self.items, "more": True}, ensure_ascii=False)

    def parsed_items(self, answer: NotesOut | ConceptsOut) -> list[Item]:
        return list(answer.sections) if isinstance(answer, NotesOut) else list(answer.concepts)

    async def feed(self, text: str) -> None:
        assert self.stream is not None
        for raw in self.stream.feed(text):
            try:
                data = json.loads(raw)
                item = self.item_model.model_validate(data)
            except (ValueError, ValidationError):
                continue  # the whole answer is parsed at the end and repaired as usual
            self.guard.check(*_words(item))
            self.items.append(data)
            if self.save is not None:
                await self.save(self.synthetic())
                self.saved = len(self.items)
            await self.progress(self.operation.kept + len(self.items))


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
                 model: str | None = None,
                 effort: str | None = None) -> None:
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
        self.model = model
        self.effort = effort
        self.checkpoints: Checkpoints | None = None
        self.report = RunReport()
        self.current_run: str | None = None
        self.writing = False
        self.cancel_requested = False
        self._runs = 0
        self._counters: dict[str, int] = {}
        #: Failures in a row of calls that may have reached the model (one automatic retry).
        self._sent_failures = 0

    # -- bookkeeping --------------------------------------------------------

    async def _step(self, step: JobStep) -> None:
        await disk_call(self.jobs.set_step, self.job_id, step)

    async def _count(self, **values: int) -> None:
        self._counters.update(values)
        await disk_call(self.jobs.update_counters, self.job_id, dict(values))

    async def _log(self, message: str) -> None:
        await disk_call(self.jobs.log, self.job_id, message)

    # -- model calls --------------------------------------------------------

    async def _ask(self, instructions: str, messages: Sequence[TurnMessage], schema: dict[str, Any],
                   live: _Live | None = None) -> str:
        """One model call with the retry policy the user chose (2026-10-20):

        * failed before it was sent (the engine was busy or couldn't start): up to
          ``transient_retries`` retries after a pause — nothing was paid for;
        * failed after it may have been sent (network drop, a crash mid-answer): exactly one
          automatic retry; with ``live`` (C1-f) it continues from the finished items. A second
          such failure in a row ends the job with the reason and Retry.

        Where an engine can't tell, the request counts as possibly sent."""
        delays = self.limits.retry_delays_s or (0.0,)
        unsent = 0
        while True:
            if live is not None:
                live.reset()
            try:
                terminal, text = await self._call(instructions, messages, schema, live)
            except BudgetReached as reached:
                raise await self._budget(reached, live) from None
            if terminal is None:
                self._sent_failures = 0
                return text
            if terminal.kind == "cancelled" or self.cancel_requested:
                raise IngestCancelled()
            when = ""
            if terminal.retry_at is not None:
                when = f" It should work again after {terminal.retry_at.isoformat()}."
            reason = agent_failure_text(terminal.kind, terminal.message) + when
            if terminal.kind in STOP_KINDS:
                raise IngestFailed(reason, agent_failure_code(terminal.kind))
            if never_sent(terminal):
                if retry_unsent(terminal) and unsent < self.limits.transient_retries:
                    await self._log("The agent was busy or couldn't start; trying the same step again "
                                    "shortly.")
                    await asyncio.sleep(delays[min(unsent, len(delays) - 1)])
                    unsent += 1
                    continue
                raise IngestFailed(reason, agent_failure_code(terminal.kind))
            if self._sent_failures == 0:
                self._sent_failures = 1
                if live is not None and live.items:
                    await self._log(f"The answer broke off ({terminal.message}); continuing from the "
                                    f"{len(live.items)} finished {live.unit}.")
                    return live.synthetic()
                await self._log(f"The answer broke off ({terminal.message}); asking once more.")
                await asyncio.sleep(delays[0])
                continue
            kept = ""
            if live is not None and self.checkpoints is not None and live.operation.kept + len(live.items):
                kept = f" The finished {live.unit} are kept: Retry continues from them."
            raise IngestFailed(f"{reason} SKAZ tried once more and it stopped again.{kept}",
                               agent_failure_code(terminal.kind))

    async def _budget(self, reached: BudgetReached, live: _Live | None) -> Exception:
        """The material's wiki budget is used up: a pause when finished work moves it forward,
        otherwise one step alone is bigger than the whole budget (C1-d)."""
        finished = live.operation.kept + len(live.items) if live is not None else 0
        if not reached.progressed and not (live is not None and live.items):
            return IngestFailed(reached.message)
        if live is not None and finished and self.checkpoints is not None:
            unit = live.unit if finished != 1 else live.unit[:-1]
            await self._log(f"The wiki budget was reached while writing the {live.operation.name}; "
                            f"the {finished} finished {unit} are kept for Continue.")
        else:
            await self._log("The wiki budget was reached before the next step; the finished work is kept "
                            "for Continue.")
        if reached.progressed:
            return reached
        return BudgetReached(reached.budget, reached.spent, progressed=True)

    async def _call(self, instructions: str, messages: Sequence[TurnMessage],
                    schema: dict[str, Any], live: _Live | None = None) -> tuple[Failed | None, str]:
        if self.cancel_requested:
            raise IngestCancelled()
        self._runs += 1
        run_id = f"{self.job_id}-{self._runs}"
        self.current_run = run_id
        turn = AgentTurn(run_id=run_id, messages=tuple(messages), instructions=instructions, tools=None,
                         response_schema=schema, model=self.model, effort=self.effort)
        try:
            result = await run_wiki_turn(self.engine, turn, live.feed if live is not None else None)
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
                       model: type[NotesOut] | type[ConceptsOut],
                       live: _Live) -> AsyncIterator[NotesOut | ConceptsOut]:
        """Answers for one part until ``more`` is false; one structure repair per answer. Each answer
        is read while it streams (``live``, C1-f)."""
        messages = [TurnMessage("user", prompt)]
        previous: str | None = None
        while True:
            parsed = None
            text = ""
            logical_messages = list(messages)
            cache_key = step_key(instructions, logical_messages, schema)
            cached = False
            if self.checkpoints is not None:
                entry = await disk_call(self.checkpoints.entry, cache_key)
                saved = entry.response if entry is not None else None
                if entry is not None and saved is not None:
                    try:
                        parsed = parse_answer(saved, model)
                    except AnswerInvalid:
                        await disk_call(self.checkpoints.discard, cache_key)
                    else:
                        text, cached = saved, True
                        await self._kept_from(entry.profile, operation, live, len(live.parsed_items(parsed)))
                        for item in live.parsed_items(parsed):
                            live.guard.remember(*_words(item))
                        operation.answers += 1
                        if operation.answers > self.limits.max_answers:
                            raise IngestFailed("The checkpoint exceeds the answer limit; split the material.")
                        if previous is not None and text.strip() == previous.strip():
                            await disk_call(self.checkpoints.discard, cache_key)
                            raise IngestFailed("A checkpoint repeated the previous answer; retry this step.")
                        scope = current_execution()
                        if scope is not None:
                            await disk_call(scope.cache_hit, str(schema["title"]))
            live.items = []
            live.save = self._saver(cache_key)
            live.saved = 0
            for attempt in range(0 if cached else 2):
                operation.answers += 1
                if operation.answers > self.limits.max_answers:
                    raise IngestFailed(
                        f"The {operation.name} needed more than {self.limits.max_answers} answers, the "
                        "technical limit for one material. Nothing was saved; split the material and retry.")
                before = live.guard.snapshot()
                try:
                    text = await self._ask(instructions, messages, schema, live)
                    parsed = parse_answer(text, model)
                    for item in live.parsed_items(parsed)[len(live.items):]:
                        live.guard.check(*_words(item))  # items the stream didn't show finished
                except Repeating as error:
                    raise self._repeating(operation, live, error) from error
                except AnswerInvalid as error:
                    live.guard.restore(before)
                    parsed = None
                    if attempt == 1:
                        raise IngestFailed(f"The agent's answer for the {operation.name} was not in the "
                                           "expected format, twice. "
                                           f"{self._kept_note(operation.kept + live.saved, live.unit)}"
                                           ) from error
                    messages += [TurnMessage("assistant", text, self.engine.id),
                                 TurnMessage("user", prompts.repair_message(str(error)))]
                    continue
                if previous is not None and text.strip() == previous.strip():
                    if self.checkpoints is not None:  # what streamed of it is the repeat: not kept
                        await disk_call(self.checkpoints.discard, cache_key)
                    raise IngestFailed(f"The agent repeated its previous answer while writing the "
                                       f"{operation.name}. {self._kept_note(operation.kept, live.unit)}")
                break
            assert parsed is not None
            # A continuation needs the valid answer, not failed JSON/repair history. This also
            # makes its checkpoint key identical when resuming from a repaired cached answer.
            messages = logical_messages
            previous = text
            operation.kept += len(live.parsed_items(parsed))
            await live.progress(operation.kept)
            yield parsed
            # The consumer has now applied the normal source/output checks to this response.
            if self.checkpoints is not None and not cached:
                await disk_call(self.checkpoints.put, cache_key, text)
            if not parsed.more:
                return
            messages += [TurnMessage("assistant", text, self.engine.id),
                         TurnMessage("user", prompts.CONTINUE_MESSAGE)]

    async def _kept_from(self, writer: str | None, operation: _Operation, live: _Live, count: int) -> None:
        """Journal: kept answers another choice wrote (C1-f item 4 — which model wrote what)."""
        checkpoints = self.checkpoints
        if checkpoints is None or writer is None or writer == checkpoints.profile or not count:
            return
        unit = live.unit if count != 1 else live.unit[:-1]
        await self._log(f"Kept from an earlier run: {count} {unit} written by {writer}, for the "
                        f"{operation.name}; this run continues with {checkpoints.profile}.")

    def _saver(self, key: str) -> Callable[[str], Awaitable[None]] | None:
        """Keeps the answer so far under this step's checkpoint key (C1-f), when answers are kept."""
        checkpoints = self.checkpoints
        if checkpoints is None:
            return None

        async def save(answer: str) -> None:
            await disk_call(checkpoints.put, key, answer)
        return save

    def _kept_note(self, kept: int, unit: str) -> str:
        """What a failed answer leaves for Retry: finished items stay in the checkpoint (C1-f)."""
        if self.checkpoints is None or not kept:
            return "Nothing was saved; retry."
        if kept == 1:
            return f"The 1 {unit[:-1]} before that is kept: Retry continues from it."
        return f"The {kept} {unit} before that are kept: Retry continues from them."

    def _repeating(self, operation: _Operation, live: _Live, error: Repeating) -> IngestFailed:
        kept = operation.kept + len(live.items)
        unit = live.unit if kept != 1 else live.unit[:-1]
        if self.checkpoints is not None and kept:
            rest = (f"The {kept} {unit} before that are kept: Retry or another model in Settings → Models "
                    "continues from them.")
        else:
            rest = "Nothing was saved; retry, or choose another model in Settings → Models."
        return IngestFailed(f"The model started repeating itself while writing the {operation.name} "
                            f"({error.reason}). {rest}")

    def _live(self, operation: _Operation, unit: str, item_model: type[SectionOut] | type[ConceptOut],
              guard: RepeatGuard, counter: str) -> _Live:
        async def progress(count: int) -> None:
            await self._count(**{counter: count})
        return _Live(unit, item_model, guard, progress, operation)

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
        instructions = prompts.instructions_for(prompts.NOTES_INSTRUCTIONS, self.language)
        sections: list[DraftSection] = []
        guard = RepeatGuard()
        live = self._live(operation, "sections", SectionOut, guard, "notes_sections")
        for index, part in enumerate(parts, start=1):
            guard.new_part()
            prompt = prompts.notes_prompt(source.title, part, index, len(parts),
                                          [section.title for section in sections])
            answers = self._answers(operation, instructions, prompt, prompts.NOTES_SCHEMA, NotesOut, live)
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
        instructions = prompts.instructions_for(prompts.CONCEPTS_INSTRUCTIONS, self.language)
        drafts: list[ConceptDraft] = []
        guard = RepeatGuard()
        live = self._live(operation, "concepts", ConceptOut, guard, "concepts_streamed")
        for index, part in enumerate(parts, start=1):
            guard.new_part()
            prompt = prompts.concepts_prompt(source.title, part, index, len(parts),
                                             [draft.display_title for draft in drafts])
            async for answer in self._answers(operation, instructions, prompt, prompts.CONCEPTS_SCHEMA,
                                              ConceptsOut, live):
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
        if self.model is not None:
            # The choice (agent · model · reasoning) is not in the revision: after a stop another
            # choice continues from the finished answers (user decision 2026-10-20, C1-f item 4).
            revision = source_fingerprint(
                source, language=self.language, part_budget=self.limits.part_budget,
                rules={"notes": prompts.NOTES_INSTRUCTIONS, "concepts": prompts.CONCEPTS_INSTRUCTIONS,
                       "notes_schema": prompts.NOTES_SCHEMA, "concepts_schema": prompts.CONCEPTS_SCHEMA},
            )
            self.checkpoints = Checkpoints(self.kb.db, self.material_id, revision,
                                           profile_label(self.engine.id, self.model, self.effort))
            await disk_call(self.checkpoints.prepare)
        await self._count(parts_total=len(parts), parts_done=0, fragments=len(source.fragments))

        await self._step("writing_notes")
        sections = await self._notes(source, parts)
        if not any(block.kind == "from_source" for section in sections for block in section.blocks):
            if self.checkpoints is not None:
                await disk_call(self.checkpoints.clear)
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
        if self.checkpoints is not None:
            await disk_call(self.checkpoints.finished)
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
            except BudgetReached:
                # The pages are written; the connections job of this material checks disagreements
                # of its pages again and pauses for Continue at the same budget (C1-d).
                await self._log("The wiki budget was reached before every disagreement check ran; "
                                "Continue checks the rest.")
                return
            except Exception:  # pages are written; a failed check is reported, not fatal
                await self._log("The discrepancy check could not run for one updated concept page.")
