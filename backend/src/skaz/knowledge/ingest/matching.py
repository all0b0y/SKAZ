"""Which existing Concept page (if any) a new concept belongs to.

Candidates come from titles/aliases (normalised: NFC, case, ё = е) and the
page-title search. The decision is asked from the decision layer (D1); when it
is absent or ``Undecided``, the writing agent is asked instead — the undecided concepts of a
material together, in batches (``agent_choices``) — and the job journal says so. Nothing is picked
silently.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass

from ..agents.prompting import untrusted_block
from ..decisions.protocol import ChoiceAnswer, ChoiceQuestion, DecisionLayer, Undecided
from ..service import KnowledgeService
from ..store.records import PageRecord
from .drafts import ConceptDraft
from .pages import description, match_key

MAX_CANDIDATES = 5
NEW_PAGE_OPTION = "None of these: a different concept (new page)"


@dataclass(frozen=True)
class Candidate:
    page_id: str
    title: str
    aliases: tuple[str, ...]
    summary: str

    def describe(self) -> str:
        names = ", ".join(self.aliases) if self.aliases else "-"
        return f"{self.title} (also: {names}): {self.summary}"


def _related_names(keys: set[str], names: set[str]) -> bool:
    """Same name, or one name inside the other (``энтропия`` / ``энтропия шеннона``)."""
    if keys & names:
        return True
    return any(len(short) >= 3 and short in long
               for key in keys for name in names
               for short, long in ((key, name), (name, key)))


def find_candidates(kb: KnowledgeService, draft: ConceptDraft) -> list[Candidate]:
    """Exact name matches first, then containing names and title-search hits; at most ``MAX_CANDIDATES``."""
    keys = draft.keys()
    pages = kb.pages(kind="concept")

    def names(page: PageRecord) -> set[str]:
        return {match_key(name) for name in (page.title, page.original or "", *page.aliases) if name.strip()}

    exact = [page for page in pages if keys & names(page)]
    found = {page.id: page for page in exact}
    for page in pages:
        if page.id not in found and _related_names(keys, names(page)):
            found[page.id] = page
    for query in (draft.title, draft.original or ""):
        if not query.strip():
            continue
        for hit in kb.search(query, limit=MAX_CANDIDATES).pages:
            if hit.kind == "concept" and hit.id not in found:
                record = next((page for page in pages if page.id == hit.id), None)
                if record is not None:
                    found[record.id] = record
    candidates = []
    for record in list(found.values())[:MAX_CANDIDATES]:
        blocks = kb.page_repo.blocks(record.id)
        first = next((block.text for block in blocks if block.kind == "from_source"), "")
        candidates.append(Candidate(record.id, record.title, record.aliases, description(first, 200)))
    return candidates


def concept_state(draft: ConceptDraft) -> str:
    first = next((block.text for block in draft.blocks if block.kind == "from_source"), "")
    names = ", ".join(draft.all_aliases())
    return f"{draft.display_title} (names: {names}): {description(first, 200)}"


@dataclass(frozen=True)
class MatchDecision:
    page_id: str | None
    #: Plain words for the job journal when the decision layer did not decide.
    note: str | None = None


@dataclass(frozen=True)
class AgentNeeded:
    """The decision layer did not decide: the writing agent is asked (in a batch with others)."""

    reason: str


async def decide_locally(draft: ConceptDraft, candidates: Sequence[Candidate],
                         decisions: DecisionLayer | None) -> MatchDecision | AgentNeeded:
    if not candidates:
        return MatchDecision(None)
    if decisions is None:
        return AgentNeeded("no decision layer is set up")
    options = [candidate.title for candidate in candidates] + [NEW_PAGE_OPTION]
    state = "\n".join([
        untrusted_block("new concept", concept_state(draft)),
        untrusted_block("existing pages", "\n".join(candidate.describe() for candidate in candidates)),
    ])
    question = ChoiceQuestion(state=state, options=options,
                              question="Which existing wiki page is the same concept as the new one?")
    try:
        answer = await decisions.ask(question)
    except Exception:  # an adapter failure is an explicit "undecided", never a guess
        answer = Undecided("the decision layer failed")
    if isinstance(answer, ChoiceAnswer) and answer.option in options:
        index = options.index(answer.option)
        return MatchDecision(candidates[index].page_id if index < len(candidates) else None)
    return AgentNeeded(answer.reason if isinstance(answer, Undecided)
                       else "the decision layer gave no usable answer")


def agent_decision(draft: ConceptDraft, candidates: Sequence[Candidate], reason: str,
                   choice: int | None) -> MatchDecision:
    """The agent's choice for one item (``None``: no usable answer) as a decision with its journal note."""
    title = draft.display_title
    if choice is None or not 0 <= choice <= len(candidates):
        return MatchDecision(None, f"“{title}”: {reason}; the agent's answer was not usable, so a new page "
                                   "was created.")
    if choice == 0:
        return MatchDecision(None, f"“{title}”: {reason}; the agent chose a new page.")
    chosen = candidates[choice - 1]
    return MatchDecision(chosen.page_id, f"“{title}”: {reason}; the agent matched it to “{chosen.title}”.")


#: A batch of match items for one agent call: at most this many, and about this much text.
MATCH_BATCH_ITEMS = 12
MATCH_BATCH_CHARS = 16_000

MatchItem = tuple[str, Sequence[str]]


def match_batches(items: Sequence[MatchItem]) -> list[list[int]]:
    """Indexes of ``items`` grouped for one call each, in order (an oversized item goes alone)."""
    batches: list[list[int]] = []
    size = 0
    for index, (state, candidates) in enumerate(items):
        cost = len(state) + sum(len(text) for text in candidates) + 200
        if batches and len(batches[-1]) < MATCH_BATCH_ITEMS and size + cost <= MATCH_BATCH_CHARS:
            batches[-1].append(index)
            size += cost
        else:
            batches.append([index])
            size = cost
    return batches


#: One agent call for a batch: item number (1-based) → choice, or ``None`` when the answer is unusable.
AskBatch = Callable[[Sequence[MatchItem]], Awaitable[dict[int, int] | None]]


async def agent_choices(items: Sequence[MatchItem], ask: AskBatch) -> list[int | None]:
    """The agent's choice per item, asked in batches; items a batch answer misses (or a whole unusable
    answer) are asked again one by one, so a batch never costs an item more than asking it alone."""
    choices: list[int | None] = [None] * len(items)
    for batch in match_batches(items):
        answered = await ask([items[index] for index in batch])
        missing = []
        for number, index in enumerate(batch, start=1):
            if answered is not None and number in answered:
                choices[index] = answered[number]
            else:
                missing.append(index)
        if len(batch) > 1:
            for index in missing:
                single = await ask([items[index]])
                choices[index] = single.get(1) if single is not None else None
    return choices
