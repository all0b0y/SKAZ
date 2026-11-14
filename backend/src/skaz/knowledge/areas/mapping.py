"""EX2: the hidden OpenAlex label of each own topic (never shown in the UI).

When a topic appears, is renamed or merged, free OpenAlex ``/topics`` searches by its name and main concept
titles, one per term (OpenAlex ANDs the words of a search: the joined query of EX2 matched nothing), without
the concepts' parenthesised glosses (only those names leave the machine; the science client journals each
request). Then the decision model picks 1–3 of the found OpenAlex topics or "no match". The result is stored;
searching inside the topic filters by those ids (no match: by the topic's name and concepts only). A stop
(consent, the day limit, no decision model) leaves the topic ``pending`` with the reason. An unsure
answer is stored as ``no_match``: search uses words without retrying the same label on every start.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from collections.abc import Awaitable, Callable, Sequence
from typing import Literal

from ...native_io import disk_call
from ..decisions.protocol import ChoiceAnswer, ChoiceQuestion, DecisionLayer, Undecided
from ..logsafe import error_note
from ..science.protocols import TOPIC_TERM_CHARS, TOPIC_TERMS, ScienceStop, TaxonomyNode
from . import prompts
from .topics import OwnTopic, TopicStore

logger = logging.getLogger(__name__)
#: ``(query) -> OpenAlex topics``: B1's free ``/topics`` search (wired by the runtime).
#: B1/X2 ``ScienceGateway.search_topics``: up to ``TOPIC_TERMS`` terms of up to ``TOPIC_TERM_CHARS``
#: characters, each its own search.
TopicSearch = Callable[[Sequence[str]], Awaitable[Sequence[TaxonomyNode]]]
#: Main concept titles searched after the topic name.
SEARCH_CONCEPTS = 3
assert SEARCH_CONCEPTS + 1 <= TOPIC_TERMS
#: Found OpenAlex topics offered to the decision model.
MAX_CANDIDATES = 10
#: Up to this many OpenAlex topics per own topic; an extra pick needs this probability.
MAX_PICKS = 3
EXTRA_PICK = 0.25


#: Why a topic has no label (``explore_areas.mapping_reason``; the system's, never shown):
#: ``no_match`` + no_candidates (OpenAlex found no topic) | none_fit | undecided (no confident label);
#: ``pending`` + a science stop | no_topic_search | no_decision_model | decision_failed.
MappingReason = Literal[
    "no_candidates",
    "none_fit",
    "undecided",
    "decision_failed",
    "no_decision_model",
    "no_topic_search",
    "science_consent_required",
    "openalex_daily_limit",
    "provider_unavailable",
]
_GLOSS = re.compile(r"\([^()]*\)")
_ABBREVIATIONS = {
    "ai": "Artificial intelligence",
    "llm": "Large language model",
    "llms": "Large language model",
    "rag": "Retrieval augmented generation",
    "moe": "Mixture of experts",
    "nlp": "Natural language processing",
    "rl": "Reinforcement learning",
    "cv": "Computer vision",
    "ml": "Machine learning",
}
_ABBREVIATION = re.compile(r"\b(?:AI|LLMs?|RAG|MoE|NLP|RL|CV|ML)\b", re.IGNORECASE)


def _term(text: str) -> str:
    """A wiki title as a search term: without its parenthesised glosses ("Agent loop (Цикл)"), within the
    contract's length (cut at a word)."""
    previous = None
    while previous != text:
        previous, text = text, _GLOSS.sub(" ", text)
    text = " ".join(text.replace("(", " ").replace(")", " ").replace('"', " ").split())
    if len(text) > TOPIC_TERM_CHARS:
        text = text[:TOPIC_TERM_CHARS].rsplit(" ", 1)[0] or text[:TOPIC_TERM_CHARS]
    return text.strip()


def search_terms(name: str, concepts: Sequence[str]) -> list[str]:
    """Name, expanded abbreviations, then main concepts; each term one bounded ``/topics`` search."""
    name = _term(name)
    expanded = _ABBREVIATION.sub(lambda match: _ABBREVIATIONS[match[0].casefold()], name)
    expansions = [_ABBREVIATIONS[match[0].casefold()] for match in _ABBREVIATION.finditer(name)]
    terms: list[str] = []
    for raw in [name, expanded, *expansions, *concepts[:SEARCH_CONCEPTS]]:
        term = _term(raw)
        if term and term.casefold() not in {t.casefold() for t in terms}:
            terms.append(term)
        if len(terms) >= TOPIC_TERMS:
            break
    return terms


def picks(answer: ChoiceAnswer, options: Sequence[str]) -> list[str]:
    """The chosen option, then up to two more the model also found likely (never "no match")."""
    if answer.option == prompts.NO_MATCH_OPTION or answer.option not in options:
        return []
    chosen = [answer.option]
    likely = sorted(
        ((p, option) for option, p in answer.probabilities.items()
         if option in options and option != prompts.NO_MATCH_OPTION and option != answer.option),
        reverse=True,
    )
    chosen += [option for p, option in likely if p >= EXTRA_PICK][: MAX_PICKS - 1]
    return chosen


class TopicMapper:
    def __init__(
        self,
        topics: TopicStore,
        *,
        search: Callable[[], TopicSearch | None],
        decisions: Callable[[], DecisionLayer | None],
    ) -> None:
        self.topics = topics
        self._search = search
        self._decisions = decisions
        self._lock = asyncio.Lock()
        self._task: asyncio.Task[None] | None = None
        self._again = False

    def schedule(self) -> None:
        """Map pending topics in the background (one run at a time; a request during it repeats it)."""
        if self._task is not None and not self._task.done():
            self._again = True
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._task = loop.create_task(self._run(), name="explore-topic-mapping")

    async def _run(self) -> None:
        while True:
            self._again = False
            try:
                await self.map_pending()
            except Exception as error:  # ids and types only (logsafe)
                logger.error("topic mapping failed: %s", error_note(error))
            if not self._again:
                return

    async def idle(self) -> None:
        if self._task is not None:
            with contextlib.suppress(Exception):
                await asyncio.shield(self._task)

    async def map_pending(self, area_ids: Sequence[str] | None = None) -> int:
        """Map the topics whose label is missing or stale (only ``area_ids`` when given); returns how many
        were stored."""
        search, decisions = self._search(), self._decisions()
        async with self._lock:
            pending = await disk_call(self.topics.pending_mapping)
            if area_ids is not None:
                wanted = set(area_ids)
                pending = [topic for topic in pending if topic.id in wanted]
            if search is None or decisions is None:
                reason: MappingReason = "no_topic_search" if search is None else "no_decision_model"
                await self._waits(pending, reason)
                return 0
            stored = 0
            for index, topic in enumerate(pending):
                try:
                    if await self._map(topic, search, decisions):
                        stored += 1
                except ScienceStop as stop:
                    logger.info("topic mapping paused: %s", stop.stop_reason)
                    # consent, the day limit, a provider failure: the rest waits too, with the reason
                    await self._waits(pending[index:], stop.stop_reason)
                    break
            return stored

    async def _waits(self, topics: Sequence[OwnTopic], reason: MappingReason) -> None:
        await disk_call(self.topics.mapping_waits, [topic.id for topic in topics], reason)

    async def _map(self, topic: OwnTopic, search: TopicSearch, decisions: DecisionLayer) -> bool:
        concepts = await disk_call(self.topics.top_concepts, topic.id, SEARCH_CONCEPTS * 2)
        found = await search(search_terms(topic.name, concepts))
        candidates: dict[str, str] = {}
        for node in found:
            if node.level == "topic" and node.name and node.name not in candidates:
                candidates[node.name] = node.taxonomy_id
            if len(candidates) >= MAX_CANDIDATES:
                break
        if not candidates:
            return await disk_call(self.topics.store_mapping, topic.id, topic.name, None, "no_candidates")
        options = [*candidates, prompts.NO_MATCH_OPTION]
        question = ChoiceQuestion(
            state=prompts.mapping_state(topic.name, concepts),
            question=prompts.MAPPING_QUESTION,
            options=options,
        )
        try:
            answer = await decisions.ask(question)
        except Exception as error:
            logger.info("topic mapping: the decision model failed: %s", error_note(error))
            await self._waits([topic], "decision_failed")
            return False
        if isinstance(answer, Undecided):
            return await disk_call(self.topics.store_mapping, topic.id, topic.name, None, "undecided")
        if not isinstance(answer, ChoiceAnswer):
            await self._waits([topic], "undecided")
            return False
        ids = [candidates[name] for name in picks(answer, options)]
        return await disk_call(self.topics.store_mapping, topic.id, topic.name, ids, "none_fit")
