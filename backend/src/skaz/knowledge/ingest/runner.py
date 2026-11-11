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
from .drafts import ConceptDraft, DraftSection, place_block
from .execution import (
    RETRY_DELAYS_S,
    STOP_KINDS,
    UNSENT_RETRIES,
    current_execution,
    never_sent,
    retry_unsent,
    run_wiki_turn,
)
from .jobs import IngestScope, JobRepository, JobStep, agent_failure_code, agent_failure_text
from .matching import (
    AgentNeeded,
    Candidate,
    MatchDecision,
    agent_choices,
    agent_decision,
    concept_state,
    decide_locally,
    find_candidates,
)
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
from .repetition import AnswerRun, LoopDetector, Looping
from .sources import DEFAULT_PART_BUDGET, ExclusionsUnreadable, IngestSource, load_source, split_parts
from .stream import ItemStream
from .writer import ConceptTarget, WikiWriter, WritePlan, WriteResult

BLOCKED_KIND = "blocked_output"
# STOP_KINDS: a break the answer doesn't continue past by itself (C1-f): the next call would fail the
# same way. Its finished items stay in the checkpoint, so Retry continues from them.
SPEECH_KINDS = frozenset({"recording", "audio", "video", "video_link"})
EXCERPT_CHARS = 300
#: Fragments sent again before the resume point of a Notes continuation (WR2), for a smooth seam.
RESUME_OVERLAP = 3


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
    #: Of those, items of answers now in the checkpoint (an answer that added nothing is not kept).
    stored: int = 0


Item = SectionOut | ConceptOut


def _title(item: Item) -> str:
    title = item.title if isinstance(item, SectionOut) else item.title_in_wiki_language
    return clean_title(title)[:80]


def _names(item: Item) -> list[str]:
    """What makes two items the same concept (any of its names) or the same Notes section (its title)."""
    if isinstance(item, SectionOut):
        return [match_key(item.title)]
    return [match_key(name) for name in (item.title_in_wiki_language, item.original or "", *item.aliases)]


def _texts(item: Item) -> list[str]:
    blocks = item.blocks if isinstance(item, SectionOut) else item.definition_blocks
    return [block.text for block in blocks]


@dataclass
class _Live:
    """One answer of a Notes/Concepts operation, read while it streams (C1-f): every finished item
    that moves the answer on is kept in the checkpoint at once and counted for the progress line;
    items that add nothing wait in :class:`AnswerRun` and, three in a row, cut the answer (WR3).
    ``synthetic()`` is the answer so far as one that says there is ``more``."""

    unit: str
    item_model: type[SectionOut] | type[ConceptOut]
    detector: LoopDetector
    progress: Callable[[int], Awaitable[None]]
    operation: _Operation
    save: Callable[[str], Awaitable[None]] | None = None
    run: AnswerRun[dict[str, Any]] | None = None
    stream: ItemStream | None = None
    #: Items the stream returned (valid or not), so the parsed answer adds only the ones it didn't.
    streamed: int = 0
    #: Items of this step now in its checkpoint (the latest ``save``), for an honest failure text.
    saved: int = 0

    def reset(self) -> None:
        self.stream = ItemStream(self.unit)
        self.run = AnswerRun(self.detector)
        self.streamed = 0

    @property
    def items(self) -> list[dict[str, Any]]:
        return self.run.kept if self.run is not None else []

    @property
    def useful(self) -> int:
        return self.run.useful if self.run is not None else 0

    def synthetic(self) -> str:
        return json.dumps({self.unit: self.items, "more": True}, ensure_ascii=False)

    def cut(self, model: type[NotesOut] | type[ConceptsOut]) -> NotesOut | ConceptsOut:
        """The answer up to the loop, as one that says there is ``more``."""
        return model.model_validate({self.unit: self.items, "more": True})

    def parsed_items(self, answer: NotesOut | ConceptsOut) -> list[Item]:
        return list(answer.sections) if isinstance(answer, NotesOut) else list(answer.concepts)

    async def feed(self, text: str) -> None:
        assert self.stream is not None
        for raw in self.stream.feed(text):
            self.streamed += 1
            try:
                data = json.loads(raw)
                item = self.item_model.model_validate(data)
            except (ValueError, ValidationError):
                continue  # the whole answer is parsed at the end and repaired as usual
            await self._take(data, item)

    async def finish(self, answer: NotesOut | ConceptsOut) -> None:
        """The answer arrived whole: items the stream didn't show finished, then any short run of
        repeats at its end (scattered, not a loop) is kept for the duplicate filter."""
        for item in self.parsed_items(answer)[self.streamed:]:
            await self._take(item.model_dump(), item)
        assert self.run is not None
        self.run.close()

    async def _take(self, data: dict[str, Any], item: Item) -> None:
        assert self.run is not None
        if not self.run.add(data, _title(item), _names(item), _texts(item)):
            return
        if self.save is not None:
            await self.save(self.synthetic())
            self.saved = len(self.items)
        await self.progress(self.operation.kept + len(self.items))

    def remember(self, items: Sequence[Item]) -> int:
        """Items of a kept answer: what they add is known now. Returns how many add something."""
        return sum(1 for item in items if self.detector.take(_names(item), _texts(item)))


def _concept_titles(items: Sequence[Item]) -> list[str]:
    """Finished concepts of a part for its continuation: the wiki-language title and the original."""
    titles: dict[str, str] = {}
    for item in items:
        if not isinstance(item, ConceptOut):
            continue
        title = clean_title(item.title_in_wiki_language)
        original = clean_title(item.original or "")
        if title and match_key(title) not in titles:
            same = not original or match_key(original) == match_key(title)
            titles[match_key(title)] = title if same else f"{title} ({original})"
    return list(titles.values())


def _notes_follow_up(title: str, part: Sequence[Fragment], index: int, total: int, earlier: Sequence[str],
                     sections: Sequence[DraftSection]) -> str:
    """The continuation of a Notes part (WR2): the source from the highest fragment the finished
    sections cite, :data:`RESUME_OVERLAP` fragments earlier, with their titles and the last one in full."""
    position = {fragment.seg: number for number, fragment in enumerate(part)}
    cited = [position[seg] for section in sections for block in section.blocks for seg in block.segs
             if seg in position]
    start = max(0, max(cited) + 1 - RESUME_OVERLAP) if cited else 0
    names = (clean_title(section.title) for section in sections)
    written = list(dict.fromkeys(name for name in names if name))
    last_title, last_texts = "", []
    if sections:
        last_title = clean_title(sections[-1].title)
        last_texts = [text for text in (clean_text(block.text) for block in sections[-1].blocks) if text]
    return prompts.notes_continue_prompt(title, part[start:], index, total, earlier, written, last_title,
                                         last_texts)


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
                 effort: str | None = None, scope: IngestScope = "full",
                 write_notes_automatically: bool = False) -> None:
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
        self.scope = scope
        self.write_notes = scope == "notes" or write_notes_automatically
        self.checkpoints: Checkpoints | None = None
        self.report = RunReport()
        self.current_run: str | None = None
        self.writing = False
        self.cancel_requested = False
        self._runs = 0
        self._counters: dict[str, int] = {}
        #: Failures in a row of calls that may have reached the model (one automatic retry).
        self._sent_failures = 0
        #: Statements the duplicate filter merged into kept ones (WR3), for the journal.
        self._duplicates = 0

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
            if terminal.kind == "limit":
                from .jobs import EngineLimited

                raise EngineLimited(self.engine.id, terminal.retry_at)
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

    async def _answers(self, operation: _Operation, instructions: str, prompt: str,
                       follow_up: Callable[[Sequence[Item]], str], schema: dict[str, Any],
                       model: type[NotesOut] | type[ConceptsOut],
                       live: _Live) -> AsyncIterator[NotesOut | ConceptsOut]:
        """Answers for one part until ``more`` is false; one structure repair per answer. Each answer
        is read while it streams (``live``, C1-f).

        A continuation is a NEW short request that ``follow_up`` builds from the items of this part so
        far (WR2) — never the previous answer replayed as the model's own turn — so Retry, and another
        model after a stop, ask exactly for what is left, and each request is its own checkpoint key.
        An answer cut at a loop, or one that brought nothing new, gets one more continuation; a second
        such answer in a row ends the job honestly (WR3)."""
        part_items: list[Item] = []
        #: The previous answer of this part was cut at a loop or brought nothing new.
        stalled = False
        while True:
            messages = [TurnMessage("user", prompt)]
            cache_key = step_key(instructions, messages, schema)
            parsed: NotesOut | ConceptsOut | None = None
            text = ""
            useful = 0
            cached = False
            looped: Looping | None = None
            if self.checkpoints is not None:
                entry = await disk_call(self.checkpoints.entry, cache_key)
                if entry is not None:
                    try:
                        parsed = parse_answer(entry.response, model)
                    except AnswerInvalid:
                        parsed = None
                        await disk_call(self.checkpoints.discard, cache_key)
                    else:
                        before = live.detector.snapshot()
                        useful = live.remember(live.parsed_items(parsed))
                        if not useful and parsed.more:
                            # It moved nothing on: continuing from it would ask the same again.
                            live.detector.restore(before)
                            await disk_call(self.checkpoints.discard, cache_key)
                            parsed = None
                        else:
                            text, cached = entry.response, True
                            await self._kept_from(entry.profile, operation, live,
                                                  len(live.parsed_items(parsed)))
                            operation.answers += 1
                            if operation.answers > self.limits.max_answers:
                                raise IngestFailed("The checkpoint exceeds the answer limit; split the "
                                                   "material.")
                            scope = current_execution()
                            if scope is not None:
                                await disk_call(scope.cache_hit, str(schema["title"]))
            live.save = self._saver(cache_key)
            live.saved = 0
            for attempt in range(0 if cached else 2):
                operation.answers += 1
                if operation.answers > self.limits.max_answers:
                    raise IngestFailed(
                        f"The {operation.name} needed more than {self.limits.max_answers} answers, the "
                        "technical limit for one material. Nothing was saved; split the material and retry.")
                before = live.detector.snapshot()
                try:
                    text = await self._ask(instructions, messages, schema, live)
                    parsed = parse_answer(text, model)
                    await live.finish(parsed)
                except Looping as error:
                    looped = error
                    parsed = live.cut(model)
                    text = live.synthetic()
                except AnswerInvalid as error:
                    live.detector.restore(before)
                    parsed = None
                    if attempt == 1:
                        raise IngestFailed(f"The agent's answer for the {operation.name} was not in the "
                                           "expected format, twice. "
                                           f"{self._kept_note(operation.kept + live.saved, live.unit)}"
                                           ) from error
                    messages = [*messages, TurnMessage("assistant", text, self.engine.id),
                                TurnMessage("user", prompts.repair_message(str(error)))]
                    continue
                useful = live.useful
                break
            assert parsed is not None
            items = live.parsed_items(parsed)
            if looped is not None or (parsed.more and not useful):
                if stalled and not useful:
                    raise IngestFailed(self._stuck(operation, live.unit, looped))
                finished = len(part_items) + len(items)
                await self._log(self._stalled_note(operation, live.unit, looped, finished))
                stalled = True
            else:
                stalled = False
            operation.kept += len(items)
            part_items.extend(items)
            await live.progress(operation.kept)
            yield parsed
            # The consumer has now applied the normal source/output checks to this response.
            if useful or not parsed.more:
                operation.stored += len(items)
                if self.checkpoints is not None and not cached:
                    await disk_call(self.checkpoints.put, cache_key, text)
            elif self.checkpoints is not None and not cached:  # nothing in it moves a Retry on
                await disk_call(self.checkpoints.discard, cache_key)
            if not parsed.more:
                return
            prompt = follow_up(part_items)

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

    @staticmethod
    def _quoted(titles: Sequence[str]) -> str:
        return ", ".join(f"“{title}”" for title in titles)

    def _stalled_note(self, operation: _Operation, unit: str, looped: Looping | None, finished: int) -> str:
        """Journal (counts and titles only): an answer cut at a loop, or one that brought nothing new."""
        if looped is None:
            return (f"The answer for the {operation.name} added nothing new; SKAZ asked once more for the "
                    "rest of the part.")
        return (f"The model started repeating itself while writing the {operation.name}: "
                f"{len(looped.titles)} {unit} in a row added nothing new ({self._quoted(looped.titles)}). "
                f"They were left out, and SKAZ asked it to continue after the {finished} finished {unit} "
                "of this part.")

    def _stuck(self, operation: _Operation, unit: str, looped: Looping | None) -> str:
        kept = operation.stored
        if self.checkpoints is not None and kept:
            noun = unit if kept != 1 else unit[:-1]
            pronoun = "them" if kept != 1 else "it"
            verb = "are" if kept != 1 else "is"
            rest = (f"The {kept} {noun} before that {verb} kept: Retry or another model in Settings → Models "
                    f"continues from {pronoun}.")
        else:
            rest = "Nothing was saved; retry, or choose another model in Settings → Models."
        if looped is None:
            return (f"The model kept answering without anything new while writing the {operation.name}, "
                    f"twice in a row. {rest}")
        return (f"The model kept repeating itself while writing the {operation.name}: asked to continue, "
                f"it again wrote {len(looped.titles)} {unit} in a row that added nothing new. {rest}")

    def _live(self, operation: _Operation, unit: str, item_model: type[SectionOut] | type[ConceptOut],
              counter: str) -> _Live:
        async def progress(count: int) -> None:
            await self._count(**{counter: count})
        return _Live(unit, item_model, LoopDetector(), progress, operation)

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
        live = self._live(operation, "sections", SectionOut, "notes_sections")
        for index, part in enumerate(parts, start=1):
            earlier = [section.title for section in sections]
            prompt = prompts.notes_prompt(source.title, part, index, len(parts), earlier)
            accepted: list[DraftSection] = []

            def follow_up(items: Sequence[Item], part: Sequence[Fragment] = part, index: int = index,
                          earlier: Sequence[str] = earlier, accepted: list[DraftSection] = accepted) -> str:
                # _answers yields before asking for the next prompt: the consumer below has now
                # checked the response. Rejected blocks/titles cannot advance the source cursor.
                return _notes_follow_up(source.title, part, index, len(parts), earlier, accepted)

            answers = self._answers(operation, instructions, prompt, follow_up, prompts.NOTES_SCHEMA,
                                    NotesOut, live)
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
                    if not checked:
                        continue
                    accepted.append(DraftSection(title, checked))
                    key = match_key(title)
                    if sections and match_key(sections[-1].title) == key:
                        target = sections[-1]  # a section continued (next answer or part): one section
                    else:  # the same title later in the lecture stays its own section (order matters)
                        target = DraftSection(title)
                        sections.append(target)
                    # Duplicate filter (WR3): a statement nearly repeating one of a same-titled section.
                    same = [known.blocks for known in sections if match_key(known.title) == key]
                    for statement in checked:
                        if not place_block(target.blocks, statement, same, exact_short=False):
                            self._duplicates += 1
            await self._count(parts_done=index, notes_answers=operation.answers)
        return [section for section in sections if section.blocks]

    async def _concepts(self, source: IngestSource,
                        parts: Sequence[Sequence[Fragment]]) -> list[ConceptDraft]:
        fragments = source.by_seg()
        operation = _Operation("concepts")
        instructions = prompts.instructions_for(prompts.CONCEPTS_INSTRUCTIONS, self.language)
        drafts: list[ConceptDraft] = []
        live = self._live(operation, "concepts", ConceptOut, "concepts_streamed")
        for index, part in enumerate(parts, start=1):
            known = [draft.display_title for draft in drafts]
            prompt = prompts.concepts_prompt(source.title, part, index, len(parts), known)

            def follow_up(items: Sequence[Item], part: Sequence[Fragment] = part, index: int = index,
                          known: Sequence[str] = known) -> str:
                return prompts.concepts_continue_prompt(source.title, part, index, len(parts), known,
                                                        _concept_titles(items))

            async for answer in self._answers(operation, instructions, prompt, follow_up,
                                              prompts.CONCEPTS_SCHEMA, ConceptsOut, live):
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
                    draft = ConceptDraft(
                        title=title, original=original,
                        aliases=[alias for alias in (clean_title(item) for item in concept.aliases) if alias],
                        related=[name for name in (clean_title(item) for item in concept.related) if name],
                    )
                    for given in concept.definition_blocks:
                        found = self._check(given, source, fragments, f"Concept · {title}")
                        if found is not None and not draft.add(found):
                            self._duplicates += 1
                    # Duplicate filter (WR3): a concept listed again merges into its draft.
                    same = next((known for known in drafts if known.keys() & draft.keys()), None)
                    if same is not None:
                        self._duplicates += same.absorb(draft)
                    else:
                        drafts.append(draft)
                    await self._count(concepts_found=len(drafts))
            await self._count(concepts_answers=operation.answers)
        return drafts

    async def _ask_match_batch(self, items: Sequence[tuple[str, Sequence[str]]]) -> dict[int, int] | None:
        text = await self._ask(prompts.MATCH_INSTRUCTIONS,
                               [TurnMessage("user", prompts.match_prompt(items))],
                               prompts.MATCH_SCHEMA)
        try:
            answer = parse_answer(text, MatchOut)
        except AnswerInvalid:
            return None
        choices: dict[int, int] = {}
        for entry in answer.choices:
            if 1 <= entry.item <= len(items):
                choices.setdefault(entry.item, entry.choice)
        return choices

    async def _match(self, drafts: Sequence[ConceptDraft]) -> list[ConceptTarget]:
        """The decision layer per concept first; the undecided ones go to the agent together."""
        decided: list[tuple[ConceptDraft, MatchDecision | None]] = []
        waiting: list[tuple[int, list[Candidate], str]] = []
        for draft in drafts:
            if not any(block.kind == "from_source" for block in draft.blocks):
                self.report.stats.dropped["concept_without_source"] += 1
                continue
            candidates = await disk_call(find_candidates, self.kb, draft)
            decision = await decide_locally(draft, candidates, self.decisions)
            if isinstance(decision, AgentNeeded):
                waiting.append((len(decided), candidates, decision.reason))
                decided.append((draft, None))
            else:
                decided.append((draft, decision))
        if waiting:
            items = [(concept_state(decided[index][0]), [candidate.describe() for candidate in candidates])
                     for index, candidates, _reason in waiting]
            choices = await agent_choices(items, self._ask_match_batch)
            for (index, candidates, reason), choice in zip(waiting, choices, strict=True):
                draft = decided[index][0]
                decided[index] = (draft, agent_decision(draft, candidates, reason, choice))
        targets = []
        for draft, made in decided:
            assert made is not None
            if made.note:
                await self._log(f"Concept match: {made.note}")
            targets.append(ConceptTarget(draft, made.page_id))
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
        job = await disk_call(self.jobs.get, self.job_id)
        if not self.write_notes and job is not None and job.kind == "refresh" and self.scope == "full":
            existing_notes = await disk_call(lambda: self.kb.pages(kind="note"))
            if any(self.material_id in page.sources for page in existing_notes):
                # A correction may already have retracted stale citations from these Notes. The
                # default-off setting controls creation, not silent loss of previously written work.
                self.write_notes = True
                await self._log("Existing Notes are being refreshed after the material's text changed.")
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
        if self.scope != "notes" and self.recognition is not None and record.kind in SPEECH_KINDS:
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

        sections: list[DraftSection] = []
        if self.write_notes:
            await self._step("writing_notes")
            sections = await self._notes(source, parts)
            if not any(block.kind == "from_source" for section in sections for block in section.blocks):
                if self.checkpoints is not None:
                    await disk_call(self.checkpoints.clear)
                raise IngestFailed("No statement of the notes passed the source check, so nothing was saved. "
                                   "Retry.")

        targets: list[ConceptTarget] = []
        if self.scope != "notes":
            await self._step("concepts")
            drafts = await self._concepts(source, parts)
            if not self.write_notes and not any(block.kind == "from_source"
                                               for draft in drafts for block in draft.blocks):
                if self.checkpoints is not None:
                    await disk_call(self.checkpoints.clear)
                raise IngestFailed("No concept statement passed the source check, so nothing was saved. "
                                   "Retry.")
            targets = await self._match(drafts)
        if self.cancel_requested:
            raise IngestCancelled()

        await self._step("saving")
        self.writing = True
        plan = WritePlan(self.material_id, record.rel_dir, self.language, sections, targets,
                         write_notes=self.write_notes, scope=self.scope)
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
        if self._duplicates:
            line += (f" Repeats merged into statements already kept: {self._duplicates} (their sources were "
                     "added to the kept ones).")
        return line

    async def _run_hooks(self, result: WriteResult) -> None:
        if self.hook is None:
            return
        if not result.new_blocks:
            return
        try:
            await self.hook.on_concepts_updated(dict(result.new_blocks))
        except asyncio.CancelledError:
            raise
        except BudgetReached:
            # The pages are written; the connections job of this material checks disagreements
            # of its pages again and pauses for Continue at the same budget (C1-d).
            await self._log("The wiki budget was reached before every disagreement check ran; "
                            "Continue checks the rest.")
        except Exception:  # pages are written; a failed check is reported, not fatal
            await self._log("The discrepancy check could not run for the updated concept pages.")
