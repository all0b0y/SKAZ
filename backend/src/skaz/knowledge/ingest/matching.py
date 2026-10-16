"""Which existing Concept page (if any) a new concept belongs to.

Candidates come from titles/aliases (normalised: NFC, case, ё = е) and the
page-title search. The decision is asked from the decision layer (D1); when it
is absent or ``Undecided``, the writing agent is asked a short multiple-choice
question instead, and the job journal says so. Nothing is picked silently.
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


AskAgent = Callable[[str, Sequence[str]], Awaitable[int | None]]


async def decide(draft: ConceptDraft, candidates: Sequence[Candidate], decisions: DecisionLayer | None,
                 ask_agent: AskAgent) -> MatchDecision:
    if not candidates:
        return MatchDecision(None)
    options = [candidate.title for candidate in candidates] + [NEW_PAGE_OPTION]
    reason: str
    if decisions is None:
        reason = "no decision layer is set up"
    else:
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
        reason = (answer.reason if isinstance(answer, Undecided)
                  else "the decision layer gave no usable answer")
    choice = await ask_agent(concept_state(draft), [candidate.describe() for candidate in candidates])
    title = draft.display_title
    if choice is None or not 0 <= choice <= len(candidates):
        return MatchDecision(None, f"“{title}”: {reason}; the agent's answer was not usable, so a new page "
                                   "was created.")
    if choice == 0:
        return MatchDecision(None, f"“{title}”: {reason}; the agent chose a new page.")
    chosen = candidates[choice - 1]
    return MatchDecision(chosen.page_id, f"“{title}”: {reason}; the agent matched it to “{chosen.title}”.")
