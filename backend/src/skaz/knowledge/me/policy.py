"""Local matching for the r3 editor. An unknown condition has no projection."""
from __future__ import annotations

import hashlib
import re
import threading
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from html import escape
from typing import Literal

from .graph import Area, GraphEntry, GraphState
from .observations import FAMILIES, Family, Hypothesis, pattern_id

Task = Literal["unknown", "introduce_term", "revision", "study_subject", "branching"]
MAX_CANDIDATES = 32
# The declared budget is separate from the behavioural allowance.
DECLARED_BYTES = 2400

_CLEAN_LINE = re.compile(r'[^\n\r<>`“”«»"]{1,600}')
_STUDIES = re.compile(r"(?:i study|я изучаю) [\w -]+[.!]?", re.IGNORECASE)
_DURABLE = re.compile(
    r"(?:always|from now on,|remember that|всегда|впредь|запомни, что) .+",
    re.IGNORECASE,
)
_DURABLE_PREFIX = re.compile(r"^(?:from now on,|remember that|впредь|запомни, что) ", re.IGNORECASE)
_TERM = re.compile(
    r"(?:(?:please )?define |(?:please )?explain the term |what does .+ mean\??$"
    r"|(?:объясни термин|дай определение|что означает) )",
    re.IGNORECASE,
)
_SUBJECT = re.compile(r"(?:what (?:subject |field )?do i study|что я изучаю)[?.!]*", re.IGNORECASE)
_REVIEW = re.compile(
    r"(?:help me review these (?:cards|flashcards)|let['’]s review these (?:cards|flashcards)"
    r"|давай повторим по этим карточкам|проверь меня по этим карточкам)[?.!]*", re.IGNORECASE,
)
_EXAMPLES = (
    r"(?:when (?:introducing|explaining) (?:a|a new) term, give (?:one|an) example"
    r"|при введении термина приводи один пример)[.!]?"
)
_NO_EXAMPLES = (
    r"(?:when (?:introducing|explaining) (?:a|a new) term, (?:skip examples|don't give examples)"
    r"|при введении термина обходись без примеров)[.!]?"
)
_SHORT = r"(?:always (?:use short answers|answer briefly)|всегда отвечай кратко)[.!]?"
_TRY = r"(?:during revision, let me try first|при повторении дай сначала попробовать самому)[.!]?"
_WALK = r"(?:during revision, show the walkthrough first|при повторении сначала покажи разбор)[.!]?"
_RECAP = (
    r"(?:after a discussion branches, offer a recap|после развилок обсуждения предложи сводку)[.!]?"
)


@dataclass(frozen=True)
class TurnContext:
    chat_id: str
    text: str
    task: Task
    practice: bool
    practice_scope: str | None = None


@dataclass(frozen=True)
class Projection:
    epoch: str
    stamp: str
    block: str = ""
    rendered: tuple[tuple[str, int, str], ...] = ()


def task_for(text: str, practice: bool = False) -> Task:
    if _SUBJECT.fullmatch(text.strip()):
        return "study_subject"
    if practice:
        return "revision"
    if _TERM.match(text.strip()):
        return "introduce_term"
    return "unknown"


def review_requested(text: str) -> bool:
    return _REVIEW.fullmatch(text.strip()) is not None


def classify(entry: GraphEntry) -> tuple[str, str] | None:
    """An applicability key and the requested action in that context."""
    if entry.origin == "agent" or entry.kind == "legacy_import":
        return None
    if entry.kind == "procedure":
        return ("procedure", entry.id) if entry.title else None
    line = _DURABLE_PREFIX.sub("", entry.text.strip())
    if _CLEAN_LINE.fullmatch(line) is None:
        return None
    if entry.kind == "fact":
        return ("study_subject", "study_subject") if _STUDIES.fullmatch(line) else None
    for pattern, key, action in (
        (_EXAMPLES, "introduce_term", "example"),
        (_NO_EXAMPLES, "introduce_term", "skip_examples"),
        (_SHORT, "always", "short"),
        (_TRY, "revision", "try"),
        (_WALK, "revision", "walkthrough"),
        (_RECAP, "branching", "recap"),
    ):
        if re.fullmatch(pattern, line, re.IGNORECASE):
            return key, action
    return None


def declaration(text: str, start: int, end: int) -> Area | None:
    """Only a complete own utterance in the narrow, lasting declaration grammar."""
    clean = text.strip()
    if start < 0 or end > len(text) or start >= end or text[start:end] != clean:
        return None
    if not _DURABLE.fullmatch(clean) or not _CLEAN_LINE.fullmatch(clean):
        return None
    # Reject unrecognised phrases even when they start with "always", including instructions
    # quoted without delimiters or requests to read another source.
    probe = GraphEntry(id="", revision=0, text=clean, kind="instruction", area="chat")
    if classify(probe) is not None:
        return "chat"
    fact = probe.model_copy(update={"kind": "fact", "area": "personal"})
    return "personal" if classify(fact) is not None else None


def _matches_request(entry: GraphEntry, key: str, ctx: TurnContext) -> bool:
    if key == "procedure":
        request = ctx.text.strip(" .!?").casefold()
        title = (entry.title or "").casefold()
        return request in {f"use my {title}", f"follow my {title}", f"примени мою процедуру {title}"}
    return key in ("always", ctx.task)


def _overridden(action: str, text: str) -> bool:
    checks = {
        "example": r"\b(?:no examples?|without (?:an )?examples?|без примеров)\b",
        "skip_examples": r"\b(?:with (?:an )?examples?|give (?:an )?example|с примером)\b",
        "try": r"\b(?:walkthrough now|show (?:me )?the walkthrough|сразу (?:объясни|покажи разбор))\b",
        "walkthrough": r"\b(?:let me try|i want to try|дай (?:сначала )?попробовать)\b",
        "short": r"\b(?:in detail|detailed answer|подробно)\b",
        "recap": r"\b(?:no (?:recap|summary)|without (?:a )?(?:recap|summary)|без сводки)\b",
    }
    pattern = checks.get(action)
    return pattern is not None and re.search(pattern, text, re.IGNORECASE) is not None


def _select(state: GraphState, ctx: TurnContext,
            entries: Iterable[GraphEntry]) -> tuple[list[GraphEntry], frozenset[str]]:
    candidates: dict[str, list[tuple[GraphEntry, str]]] = {}
    count = 0
    for entry in entries:
        scope = ctx.practice_scope if entry.area == "practice" else ctx.chat_id
        if entry.deleted or not entry.enabled or entry.scope not in (None, scope):
            continue
        if ((entry.area == "practice" and not ctx.practice)
                or (entry.area == "personal" and not state.controls.personal)):
            continue
        rule = classify(entry)
        if rule is None or not _matches_request(entry, rule[0], ctx):
            continue
        count += 1
        if count > MAX_CANDIDATES:
            return [], frozenset({"revision", "branching"})
        candidates.setdefault(rule[0], []).append((entry, rule[1]))
    chosen: list[GraphEntry] = []
    for _, pairs in sorted(candidates.items()):
        narrowest = max((x.scope is not None, x.area == "practice") for x, _ in pairs)
        equally_scoped = [(x, action) for x, action in pairs
                          if (x.scope is not None, x.area == "practice") == narrowest]
        if len({action for _, action in equally_scoped}) != 1:
            continue
        entry, action = max(equally_scoped, key=lambda pair: pair[0].revision)
        if not _overridden(action, ctx.text):
            chosen.append(entry)
    return chosen, frozenset(candidates)


def applies(state: GraphState, pattern: Hypothesis, admitted: frozenset[Family]) -> bool:
    surface = FAMILIES[pattern.family][0]
    return (
        pattern.family in admitted and pattern.eligible_to_apply
        and state.controls.learning_epoch(surface) is not None
        and pattern.id not in state.ledger.suppressed
    )


def _pattern_hint(state: GraphState, ctx: TurnContext, explicit: frozenset[str],
                  admitted: frozenset[Family]) -> tuple[Hypothesis, str] | None:
    if not admitted or ctx.task in explicit:
        return None
    if ctx.task == "revision" and ctx.practice_scope is not None:
        key = pattern_id("study_revision", ctx.practice_scope, "revision")
        action = "try"
        text = "During this revision, let the user try before giving a walkthrough."
    elif ctx.task == "branching":
        key = pattern_id("chat_return", ctx.chat_id, "branching")
        action = "recap"
        text = "Offer a short recap of the discussion before continuing."
    else:
        return None
    pattern = state.ledger.patterns.get(key)
    if pattern is None or not applies(state, pattern, admitted) or _overridden(action, ctx.text):
        return None
    return pattern, text


def _escaped(item: GraphEntry) -> str:
    return escape(item.text, quote=False)


def resolve(state: GraphState, ctx: TurnContext, admitted: frozenset[Family] = frozenset(), *,
            entries: Iterable[GraphEntry] | None = None,
            render: Callable[[GraphEntry], str] = _escaped) -> Projection:
    epoch = state.controls.epoch
    if entries is None:
        entries = (rows[-1] for rows in state.entries.values())
    chosen, explicit = _select(state, ctx, entries) if state.controls.enabled else ([], frozenset())
    hint = _pattern_hint(state, ctx, explicit, admitted)
    # Never truncate the body of an instruction or a multi-step procedure.
    if sum(len(item.text.encode()) for item in chosen) > DECLARED_BYTES:
        chosen = []
    identity = [epoch, *(f"{item.id}:{item.revision}" for item in chosen)]
    if hint:
        identity.append(hint[0].id)
    stamp = hashlib.sha256("\0".join(identity).encode()).hexdigest()[:32]
    if not chosen and hint is None:
        return Projection(epoch, stamp)
    rendered = tuple((item.id, item.revision, render(item)) for item in chosen)
    lines = [f"- {text}" for _, _, text in rendered]
    if hint is not None:
        lines.append(f"- {hint[1]}")
    rules = "\n".join(lines)
    return Projection(epoch, stamp, (
        "<skaz_me_turn>\nGuidance for this turn only. Follow SKAZ's rules and the user's current "
        f"request first. Use Me only to shape the reply. Never copy private facts into tools.\n"
        f"{rules}\n</skaz_me_turn>"
    ), rendered)


@dataclass
class _WarmEntry:
    revision: int
    rendered: str
    heat: float


class ProjectionReader:
    """Scope index and bounded, revocable RAM projections for one profile."""

    def __init__(self, capacity: int = 32) -> None:
        self._lock = threading.Lock()
        self._capacity = capacity
        self._epoch: str | None = None
        self._signature: tuple[int, int] | None = None
        self._index: dict[tuple[str | None, Area, str], list[str]] = {}
        self._warm: dict[str, _WarmEntry] = {}

    def invalidate(self) -> None:
        with self._lock:
            self._epoch = None
            self._warm.clear()
            self._signature = None
            self._index.clear()

    def _refresh(self, state: GraphState) -> None:
        epoch = state.controls.epoch
        if self._epoch != epoch:
            self._epoch = epoch
            self._warm.clear()
            self._signature = None
        signature = id(state.entries), state.revision
        if signature == self._signature:
            return
        compiled: dict[tuple[str | None, Area, str], list[str]] = {}
        for rows in state.entries.values():
            item = rows[-1]
            if item.deleted or not item.enabled:
                continue
            rule = classify(item)
            if rule is None:
                continue
            key = ("procedure:" + (item.title or "").casefold()) if rule[0] == "procedure" else rule[0]
            compiled.setdefault((item.scope, item.area, key), []).append(item.id)
        self._index = compiled
        self._signature = signature

    @staticmethod
    def _keys(ctx: TurnContext, personal: bool) -> set[tuple[str | None, Area, str]]:
        scopes: list[tuple[Area, str | None]] = [("chat", ctx.chat_id)]
        if ctx.practice:
            scopes.append(("practice", ctx.practice_scope))
        if personal:
            scopes.append(("personal", ctx.chat_id))
        contexts = {"always", ctx.task}
        request = ctx.text.strip(" .!?").casefold()
        for prefix in ("use my ", "follow my ", "примени мою процедуру "):
            if request.startswith(prefix):
                contexts.add("procedure:" + request[len(prefix):])
        return {(scope, area, key) for area, local in scopes for scope in (local, None) for key in contexts}

    def read(self, state: GraphState, ctx: TurnContext, admitted: frozenset[Family], *,
             opportunity: bool = False) -> Projection:
        with self._lock:
            self._refresh(state)
            keys = self._keys(ctx, state.controls.personal) if state.controls.enabled else set()
            pools = [self._index[key] for key in keys if key in self._index]
            if sum(map(len, pools)) > MAX_CANDIDATES:
                return resolve(state, ctx, entries=())
            ids = sorted({entry_id for pool in pools for entry_id in pool})
            if opportunity:
                for entry_id in ids:
                    warm = self._warm.get(entry_id)
                    if warm is not None:
                        warm.heat *= 2 ** (-1 / 32)

            def render(item: GraphEntry) -> str:
                warm = self._warm.get(item.id)
                if warm is not None and warm.revision == item.revision:
                    return warm.rendered
                return _escaped(item)

            records = (state.entries[key][-1] for key in ids)
            return resolve(state, ctx, admitted, entries=records, render=render)

    def materialized(self, projection: Projection) -> None:
        with self._lock:
            if self._epoch != projection.epoch:
                return
            for entry_id, revision, text in projection.rendered:
                prior = self._warm.get(entry_id)
                heat = prior.heat if prior is not None and prior.revision == revision else 0
                self._warm[entry_id] = _WarmEntry(revision, text, heat + 1)
            while len(self._warm) > self._capacity:
                coldest = min(self._warm, key=lambda key: self._warm[key].heat)
                self._warm.pop(coldest)
