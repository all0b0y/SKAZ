"""Rewriting one passage of a note from the speech it rests on.

A whole-note generation replaces a document; this replaces exactly the characters
the user selected and nothing else. Their own edits elsewhere, and every point the
model would otherwise have dropped, survive untouched — which is the only reason
regenerating a paragraph is safe to offer at all.

Two steps on purpose. :func:`preview` writes the replacement and stores it; nothing
in the note changes until :func:`apply` is called with that preview's id. The user
compares the old passage with the new one before either lands, so a rewrite can be
read and refused rather than discovered afterwards.

Grounding works exactly as it does for a whole note: the model is shown only the
monologues the selected passage already cites, must cite them back as ``[P<n>]``,
and the labels are stripped once they have been checked. A selection that resolves
to no stored speech is refused instead of being rewritten from the whole session,
which would let the model restate anything it liked as a source.
"""

from __future__ import annotations

import re
from collections import OrderedDict
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import uuid4

from .. import monologue_context as mctx
from .. import monologues as mono
from .. import note_anchors, note_store
from .. import repository as repo
from .. import transcript_monologues as tmono
from ..gateways import ProviderError, ProviderNotConfigured, require_cloud_consent
from ..gateways.chat import ChatGateway, ChatMessage, build_chat
from ..schemas import Citation, Note
from .notes import DETAIL_RULES, SYSTEM_RULES, Detail

if TYPE_CHECKING:  # pragma: no cover
    from ..runtime import Runtime

MAX_REWRITE_TOKENS = 900
#: Previews waiting for a decision. Small on purpose: a preview is a few seconds of
#: the user's attention, not a document store, and an abandoned one must not pin
#: generated text in memory indefinitely.
MAX_PENDING = 16
#: Below this, word overlap is too easy to hit by chance and would source a passage
#: on speech it only shares a common word with.
MIN_WORDS_FOR_OVERLAP = 3
OVERLAP_THRESHOLD = 0.75

_WORDS = re.compile(r"[^\w]+", re.UNICODE)


class InvalidSpan(ValueError):
    """The selection does not describe a stretch of this note's text."""


class NoSource(ValueError):
    """The selected passage rests on no stored speech, so it cannot be rewritten."""


class PreviewMissing(ValueError):
    """The preview expired, was already applied, or belongs to another note."""


@dataclass(frozen=True)
class PendingRewrite:
    """One written-but-unapplied replacement, pinned to the exact text it replaces."""

    id: str
    session_id: str
    note_id: str
    #: The revision the passage was read from. Applying against anything else is a
    #: conflict: the offsets would point into text the user has since changed.
    revision: int
    start: int
    end: int
    original: str
    replacement: str
    citations: tuple[Citation, ...]


class PendingRewrites:
    """The previews this process is holding, oldest evicted first."""

    def __init__(self, limit: int = MAX_PENDING) -> None:
        self._items: OrderedDict[str, PendingRewrite] = OrderedDict()
        self._limit = limit

    def add(self, pending: PendingRewrite) -> None:
        self._items[pending.id] = pending
        while len(self._items) > self._limit:
            self._items.popitem(last=False)

    def take(self, preview_id: str, session_id: str, note_id: str) -> PendingRewrite:
        pending = self._items.get(preview_id)
        if pending is None or pending.session_id != session_id or pending.note_id != note_id:
            raise PreviewMissing(
                "This preview is no longer available. Regenerate the passage and compare again."
            )
        del self._items[preview_id]
        return pending

    def drop_note(self, note_id: str) -> None:
        for key in [key for key, item in self._items.items() if item.note_id == note_id]:
            del self._items[key]


async def preview(
    runtime: Runtime, session_id: str, note_id: str, *,
    expected_revision: int, start: int, end: int,
    language: str | None = None, detail: Detail = "normal",
) -> PendingRewrite:
    """Write a replacement for ``content[start:end]`` without storing anything."""
    note = note_store.check_revision(runtime.db, session_id, note_id, expected_revision)
    original = _selected(note, start, end)

    with runtime.db.read() as connection:
        segments = repo.list_segments(runtime.db, session_id)
        monologues = tmono.build_monologues(connection, session_id, segments)
    sources = _sources_for(original, note.citations, monologues)
    if not sources:
        raise NoSource(
            "This passage does not resolve to stored speech, so there is nothing to rewrite it from."
        )

    settings = runtime.settings_store.load()
    gateway = _gateway(runtime)
    context = mctx.build(sources, budget_chars=_unbounded(sources))
    labelled = await gateway.complete(
        [
            ChatMessage("system", SYSTEM_RULES),
            ChatMessage("user", _prompt(original, context.text, language or settings.output_language, detail)),
        ],
        max_tokens=MAX_REWRITE_TOKENS,
    )

    unresolved = mctx.unresolved(context.references, labelled)
    if unresolved:
        raise ProviderError(
            "The model cited sources that are not behind this passage: "
            f"{', '.join(unresolved)}. Nothing was changed."
        )
    citations = context.citations_for(labelled)
    if not citations:
        raise ProviderError(
            "The model returned no citation into the transcript, so the new passage cannot be "
            "checked against the recording. Nothing was changed."
        )
    cleaned = note_anchors.strip_labels(labelled).content.strip()
    if not cleaned:
        raise ProviderError("The model returned an empty passage. Nothing was changed.")

    pending = PendingRewrite(
        id=uuid4().hex, session_id=session_id, note_id=note_id, revision=note.revision,
        start=start, end=end, original=original, replacement=cleaned, citations=tuple(citations),
    )
    runtime.note_rewrites.add(pending)
    runtime.mark_verified(
        "notes", gateway.provider, gateway.model, "Rewrote a passage from stored transcript"
    )
    return pending


def apply(runtime: Runtime, session_id: str, note_id: str, preview_id: str) -> Note:
    """Put an accepted replacement into the note, as one whole new revision.

    The document is written entire rather than patched in place: the note is one
    file and one row, and a partial write is a second way for its text and its
    projected Markdown to disagree.

    ``source_revision`` deliberately does not move. One refreshed passage does not
    make the rest of the note current, and clearing the staleness flag here would
    claim it did.
    """
    pending = runtime.note_rewrites.take(preview_id, session_id, note_id)
    note = note_store.check_revision(runtime.db, session_id, note_id, pending.revision)
    if note.content[pending.start:pending.end] != pending.original:
        raise note_store.NoteConflict("The note changed. Regenerate the passage and compare again.")
    content = note.content[:pending.start] + pending.replacement + note.content[pending.end:]
    return note_store.replace(
        runtime.db, session_id, note_id, pending.revision,
        content=content, citations=_merged(note.citations, pending.citations),
    )


def _selected(note: Note, start: int, end: int) -> str:
    if start < 0 or end > len(note.content) or start >= end:
        raise InvalidSpan("The selection does not lie inside this note.")
    original = note.content[start:end]
    if not original.strip():
        raise InvalidSpan("The selection contains no text.")
    return original


def _merged(existing: list[Citation], produced: tuple[Citation, ...]) -> list[Citation]:
    """The note's citations plus the new passage's, without duplicating a source.

    Citations of the replaced passage are kept rather than removed: nothing records
    which citation belonged to which span, so dropping any of them would take the
    grounding off sentences that still stand.
    """
    known = {_key(citation) for citation in existing}
    return existing + [citation for citation in produced if _key(citation) not in known]


def _key(citation: Citation) -> tuple[str | None, str | None, str | None, str]:
    return (
        citation.monologue_id, citation.start_token_id, citation.end_token_id, citation.segment_id,
    )


def _sources_for(
    selected: str, citations: list[Citation], monologues: list[mono.Monologue],
) -> list[mono.Monologue]:
    """The monologues the selected text already claims to rest on, in transcript order.

    Only the note's own citations are consulted. Searching the whole transcript for
    something that reads like the selection would let a sentence the user typed
    themselves acquire a source it never had.
    """
    by_id = {monologue.id: monologue for monologue in monologues}
    wanted: list[str] = []
    for citation in citations:
        if citation.monologue_id in by_id and citation.monologue_id not in wanted \
                and _overlaps(selected, citation.text):
            wanted.append(citation.monologue_id)
    order = {monologue.id: index for index, monologue in enumerate(monologues)}
    return [by_id[key] for key in sorted(wanted, key=lambda key: order[key])]


def _overlaps(selected: str, cited: str) -> bool:
    left, right = selected.strip(), cited.strip()
    if not left or not right:
        return False
    if left in right or right in left:
        return True
    selected_words = _normalise(left)
    cited_words = _normalise(right)
    if len(selected_words) < MIN_WORDS_FOR_OVERLAP or len(cited_words) < MIN_WORDS_FOR_OVERLAP:
        return False
    shared = len(selected_words & cited_words)
    return shared / min(len(selected_words), len(cited_words)) >= OVERLAP_THRESHOLD


def _normalise(text: str) -> set[str]:
    return {word for word in _WORDS.split(text.lower()) if word}


def _prompt(original: str, context: str, language: str, detail: Detail) -> str:
    return (
        f"Rewrite ONE passage of an existing set of notes, in language: {language}.\n"
        f"{DETAIL_RULES[detail]}\n\n"
        f"{context}\n\n"
        "The passage to rewrite, taken verbatim from the notes:\n"
        f"---\n{original}\n---\n\n"
        "Write only the replacement for that passage, keeping the [P...] labels of the monologues "
        "it rests on. Do not write a heading, an introduction, or anything about the rest of the "
        "notes: whatever you return replaces exactly this passage and nothing else. Keep its "
        "markdown shape — a bullet stays a bullet, a paragraph stays a paragraph."
    )


def _unbounded(monologues: list[mono.Monologue]) -> int:
    return sum(len(monologue.text) for monologue in monologues) + 96 * len(monologues) + 96


def _gateway(runtime: Runtime) -> ChatGateway:
    settings = runtime.settings_store.load()
    profile = settings.profile("notes")
    if not profile.model:
        raise ProviderNotConfigured("No notes model is configured. Pick one in settings.")
    require_cloud_consent(profile.provider, settings.cloud_consent, "transcript text")
    return build_chat(
        http=runtime.http,
        provider=profile.provider,
        model=profile.model,
        api_key=runtime.api_key(profile.provider),
        timeout=runtime.config.request_timeout_s,
    )
