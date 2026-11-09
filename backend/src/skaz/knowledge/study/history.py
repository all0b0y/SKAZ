"""What the agent may read of past study (0.4.0 N4-7): the only way study reaches a chat's answers.

Two read-only views, by topic words or by a concept page, for a chat answer that asks for them:

* **Past questions**, so a new test doesn't repeat them: the question's words and where it is, never the
  answer or its source (a question not answered yet must not give either away; ``unclear.py`` decision 12).
* **Mistakes**, to build "a test on my mistakes": test questions scored below 1 and cards with an Again or
  lapses, with the right answer, the user's last answer and the checked source a new question can cite.
  A question the user has not answered is no mistake; a later right answer keeps the mistake in the
  history and says so (``right_since``).

Archived tests count (N4-8); a page whose file is gone doesn't. Saved pages come first, then blocks that
live only in a chat. A chat's folders and its sources (N7-4) narrow both, as for «Unclear» items.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..errors import KnowledgeError, NotFound
from ..library.layout import STUDY_KINDS
from ..markdown.page import Cite
from ..markdown.text import name_key
from ..permissions.source_scope import SourceScope, unclear_item_allowed, withhold_quotes
from ..sources.material_search import tokens
from .format import Card, Question, read_cards, read_questions
from .scheduling import RATING
from .unclear import _last_answer

if TYPE_CHECKING:  # the service imports this module
    from .service import StudyService

#: Fits one tool result (``SkazTool.max_output_bytes``) with its wrapping.
MAX_RESULT_BYTES = 26_000
AGAIN = int(RATING["again"])


@dataclass(frozen=True)
class Asked:
    """A question or card as it is now, wherever it lives."""

    item: Card | Question
    title: str
    page_id: str | None
    where: str
    folders: tuple[str, ...]
    archived: bool
    #: Lower-cased words it can be found by, its links included (a card's own text drops them).
    words: str


@dataclass(frozen=True)
class Wanted:
    words: tuple[str, ...] = ()
    names: tuple[str, ...] = ()
    fragments: frozenset[tuple[str, int]] = frozenset()

    def matches(self, asked: Asked) -> bool:
        if self.words and not all(word in asked.words for word in self.words):
            return False
        if not self.names and not self.fragments:
            return True
        cited = {(cite.material_id, cite.seg) for cite in asked.item.cites}
        return bool(cited & self.fragments) or any(name in asked.words for name in self.names)


def wanted(study: StudyService, topic: str | None, concept_page_id: str | None) -> Wanted:
    """``topic``: every word must occur; ``concept_page_id``: a shared source fragment, or its name."""
    words = tuple(tokens(topic)) if topic else ()
    if concept_page_id is None:
        return Wanted(words)
    record = study.kb.page_repo.get(concept_page_id)
    if record is None or record.kind in STUDY_KINDS:
        raise NotFound("Concept page not found. Use skaz_wiki_index or skaz_search to find its id.")
    fragments = frozenset((cite.material_id, cite.seg) for block in study.kb.page_repo.blocks(record.id)
                          for cite in block.citations)
    names = tuple(name for name in (name_key(text) for text in (record.title, *record.aliases)) if name)
    return Wanted(words, names, fragments)


def _text_of(item: Card | Question) -> list[str]:
    answers = [item.answer] if isinstance(item, Card) else list(item.answers)
    return [item.question, *answers, item.explanation or ""]


def _saved(study: StudyService, archived: set[str]) -> Iterator[Asked]:
    for page in study.kb.page_repo.list_all():
        if page.kind not in STUDY_KINDS:
            continue
        try:
            document = study._document(page.id)
        except (KnowledgeError, OSError, ValueError, UnicodeDecodeError):
            continue  # its file is gone or being synced: nothing to say about it
        items: Sequence[Card | Question] = (read_cards(document) if page.kind == "deck"
                                            else read_questions(document))
        bodies = {block.id: block.body for block in document.blocks()}
        for item in items:
            words = name_key(" ".join([page.title, bodies.get(item.id, ""), *_text_of(item)]))
            yield Asked(item, page.title, page.id, f"p:{page.id}#{item.id}", tuple(page.folders),
                        page.id in archived, words)


def _chat_only(study: StudyService, seen: set[str]) -> Iterator[Asked]:
    for block in study.store.unsaved_blocks():
        items: list[Card | Question] = (
            [card for card, _page in study.cards(block)] if block.kind == "deck"
            else list(study.questions(block))
        )
        for item in items:
            if item.id in seen:
                continue
            words = name_key(" ".join([block.title, *_text_of(item)]))
            where = f"{block.kind} block {block.id} in chat {block.chat_id} (not saved)"
            yield Asked(item, block.title, None, where, (block.folder_id,) if block.folder_id else (),
                        False, words)


def everything(study: StudyService) -> list[Asked]:
    archived = study.shelf.archived_ids()
    saved = list(_saved(study, archived))
    return [*saved, *_chat_only(study, {asked.item.id for asked in saved})]


def _sources(cites: Sequence[Cite]) -> list[dict[str, Any]]:
    return [{"cite": f"m:{c.material_id}:{c.seg}", "quote": c.quote} for c in cites]


def _in_scope(asked: Asked, folders: Sequence[str], scope: SourceScope | None) -> bool | None:
    """``False``: outside the chat's folders, silently; ``None``: its sources forbid it, counted."""
    if folders and not set(folders) & set(asked.folders):
        return False
    if scope is not None and not unclear_item_allowed(
        {"page_id": asked.page_id, "source": _sources(asked.item.cites)}, scope
    ):
        return None
    return True


def _head(asked: Asked) -> dict[str, Any]:
    item = asked.item
    head: dict[str, Any] = {"item_id": item.id,
                            "kind": "flashcard" if isinstance(item, Card) else "test question"}
    if isinstance(item, Question):
        head["type"] = item.type
    head.update({"question": item.question, "in": asked.title, "page_id": asked.page_id,
                 "where": asked.where})
    if asked.archived:
        head["archived"] = True
    return head


def past_questions(study: StudyService, folders: Sequence[str], want: Wanted, scope: SourceScope | None
                   ) -> tuple[list[dict[str, Any]], int]:
    """(items, how many the chat's sources left out)."""
    items: list[dict[str, Any]] = []
    left_out = 0
    for asked in everything(study):
        if not want.matches(asked):
            continue
        allowed = _in_scope(asked, folders, scope)
        if allowed is None:
            left_out += 1
        elif allowed:
            items.append(_head(asked))
    return items, left_out


@dataclass
class _Answers:
    asked: int = 0
    wrong: int = 0
    last: dict[str, Any] | None = None
    last_score: float | None = None
    last_time: str = ""


def _test_answers(study: StudyService) -> dict[str, _Answers]:
    """Each question's scored answers over all attempts; an answer not scored (yet) doesn't count."""
    found: dict[str, _Answers] = defaultdict(_Answers)
    for attempt in study.store.all_attempts():
        for item_id, entry in (attempt.answers.get("items") or {}).items():
            score = entry.get("score")
            if score is None:
                continue
            row = found[item_id]
            row.asked += 1
            row.wrong += float(score) < 1.0
            if attempt.started_at >= row.last_time:
                row.last, row.last_score, row.last_time = dict(entry), float(score), attempt.started_at
    return found


def _chat_only_agains(study: StudyService) -> dict[str, tuple[int, int]]:
    """Grades of cards not saved yet wait in their block (S6): (times Again, lapses) per card."""
    found: dict[str, tuple[int, int]] = {}
    for block in study.store.unsaved_blocks():
        if block.kind != "deck":
            continue
        agains: dict[str, int] = defaultdict(int)
        for entry in block.state.get("reviews") or []:
            if int(entry.get("rating") or 0) == AGAIN:
                agains[str(entry.get("card_id"))] += 1
        pending = block.state.get("pending") or {}
        for card_id in {*agains, *pending}:
            found[card_id] = (agains.get(card_id, 0), int((pending.get(card_id) or {}).get("lapses", 0)))
    return found


def mistakes(study: StudyService, folders: Sequence[str], want: Wanted, scope: SourceScope | None
             ) -> tuple[list[dict[str, Any]], int]:
    """(items, how many left out): what still goes wrong first, then the most often wrong."""
    answers = _test_answers(study)
    agains = study.store.again_counts()
    unsaved = _chat_only_agains(study)
    asked_items = [asked for asked in everything(study) if want.matches(asked)]
    states = study.store.cards([asked.item.id for asked in asked_items if isinstance(asked.item, Card)])
    items: list[tuple[tuple[int, int], dict[str, Any]]] = []
    left_out = 0
    for asked in asked_items:
        item = asked.item
        entry: dict[str, Any]
        if isinstance(item, Question):
            row = answers.get(item.id)
            if row is None or not row.wrong or row.last is None:
                continue
            still = row.last_score is None or row.last_score < 1.0
            entry = {"times_wrong": row.wrong, "times_asked": row.asked, "last_score": row.last_score,
                     "last_answer": _last_answer(row.last, item), "right_answer": list(item.answers)}
            if not still:
                entry["right_since"] = True
            rank = (0 if still else 1, -row.wrong)
        else:
            state = states.get(item.id)
            waiting_again, waiting_lapses = unsaved.get(item.id, (0, 0))
            times_again = agains.get(item.id, 0) + waiting_again
            lapses = (state.lapses if state is not None else 0) + waiting_lapses
            if not times_again and not lapses:
                continue
            entry = {"times_again": times_again, "lapses": lapses, "right_answer": [item.answer]}
            rank = (0, -(times_again + lapses))
        allowed = _in_scope(asked, folders, scope)
        if allowed is None:
            left_out += 1
            continue
        if not allowed:
            continue
        sources = _sources(item.cites)
        if scope is not None:
            withhold_quotes(sources, scope)
        items.append((rank, {**_head(asked), **entry, "source": sources}))
    items.sort(key=lambda pair: pair[0])
    return [entry for _rank, entry in items], left_out
