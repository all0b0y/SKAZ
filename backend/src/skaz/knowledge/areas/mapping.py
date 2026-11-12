"""EX2: the hidden OpenAlex label of each own topic (never shown in the UI).

When a topic appears, is renamed or merged, one free OpenAlex ``/topics`` search by its name and main
concept titles (only those names leave the machine; the science client journals the request), then the
decision model picks 1–3 of the found OpenAlex topics or "no match". The result is stored; searching inside
the topic filters by those ids (no match: text only). A stop (consent, the day limit, no decision model, an
unsure answer) leaves the topic ``pending``: it is tried again when topics change or a search asks for it.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable, Sequence

from ...native_io import disk_call
from ..decisions.protocol import ChoiceAnswer, ChoiceQuestion, DecisionLayer
from ..logsafe import error_note
from ..science.protocols import ScienceStop, TaxonomyNode
from . import prompts
from .topics import OwnTopic, TopicStore

logger = logging.getLogger(__name__)
#: ``(query) -> OpenAlex topics``: B1's free ``/topics`` search (wired by the runtime).
TopicSearch = Callable[[str], Awaitable[Sequence[TaxonomyNode]]]
#: Main concept titles added to the topic name in the one search.
SEARCH_CONCEPTS = 3
MAX_QUERY = 200
#: Found OpenAlex topics offered to the decision model.
MAX_CANDIDATES = 10
#: Up to this many OpenAlex topics per own topic; an extra pick needs this probability.
MAX_PICKS = 3
EXTRA_PICK = 0.25


def search_query(name: str, concepts: Sequence[str]) -> str:
    query = name
    for concept in concepts[:SEARCH_CONCEPTS]:
        longer = f"{query} {concept}"
        if len(longer) > MAX_QUERY:
            break
        query = longer
    return query[:MAX_QUERY]


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
        if search is None or decisions is None:
            return 0
        async with self._lock:
            pending = await disk_call(self.topics.pending_mapping)
            if area_ids is not None:
                wanted = set(area_ids)
                pending = [topic for topic in pending if topic.id in wanted]
            stored = 0
            for topic in pending:
                try:
                    if await self._map(topic, search, decisions):
                        stored += 1
                except ScienceStop as stop:
                    logger.info("topic mapping paused: %s", stop.stop_reason)
                    break  # consent, the day limit, a provider failure: the rest waits too
            return stored

    async def _map(self, topic: OwnTopic, search: TopicSearch, decisions: DecisionLayer) -> bool:
        concepts = await disk_call(self.topics.top_concepts, topic.id, SEARCH_CONCEPTS)
        found = await search(search_query(topic.name, concepts))
        candidates: dict[str, str] = {}
        for node in found:
            if node.level == "topic" and node.name and node.name not in candidates:
                candidates[node.name] = node.taxonomy_id
            if len(candidates) >= MAX_CANDIDATES:
                break
        if not candidates:
            return await disk_call(self.topics.store_mapping, topic.id, topic.name, None)
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
            return False
        if not isinstance(answer, ChoiceAnswer):
            return False  # undecided: stays pending, asked again later
        ids = [candidates[name] for name in picks(answer, options)]
        return await disk_call(self.topics.store_mapping, topic.id, topic.name, ids)
