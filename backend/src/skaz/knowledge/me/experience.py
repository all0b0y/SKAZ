"""Evidence from delivered replies. Histories contain no user or assistant text."""

from __future__ import annotations

import base64
import hashlib
import math
import re
from collections import Counter, defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..answer_blocks.part import BlockPart
from .semantic import ENCODER

if TYPE_CHECKING:
    from ..chats.model import Message, MessageInput


Outcome = Literal["confirmed", "continued", "corrected", "unknown"]
_STOP = frozenset(
    [
        "как",
        "когда",
        "этот",
        "этой",
        "этом",
        "мне",
        "для",
        "что",
        "или",
        "это",
        "мне",
        "чем",
        "при",
        "мне",
        "take",
        "what",
        "when",
        "this",
        "with",
        "the",
        "that",
        "from",
        "into",
        "could",
        "about",
        "give",
        "your",
        "please",
    ]
)
_SELF = re.compile(
    r"самостоятел|(?:реш[иу]\w*|попроб\w*|дойти|пришлю)(?:\s+[\w-]+){0,2}\s+сам\b|"
    r"решение я пришлю|let me try|my own|try (?:it )?myself",
    re.I,
)
_ORIGINAL = re.compile(
    r"\b(?:верни|найди|покажи)\b.{0,35}\b(?:тот|сохран[её]нн\w*|прежн\w*)\b|"
    r"\b(?:retrieve|return|show|find)\b.{0,32}\b(?:saved|original|previous)\b",
    re.I,
)
_CORRECTION = re.compile(
    r"\b(?:нет[,!]|не (?:так|то\b|помог\w*|нуж\w*)|лишн\w*|я (?:хотел|просил|спрашивал)"
    r"|не это|неверно|wrong|not (?:what|helpful)|didn.t help|unhelpful|unwanted|instead)",
    re.I,
)
_APPROVAL = re.compile(
    r"\b(?:помог(?:ло|ла|ли)?\b|подош[её]л|подходит|то[, ]+что (?:нужно|надо)|"
    r"helpful|helped|exactly (?:right|what)|that worked)",
    re.I,
)
_CONTINUATION = re.compile(r"^(?:а (?:если|почему|зачем|как)\b|what if\b|and (?:if|why)\b)", re.I)
_REFERENT = re.compile(r"\b(?:этом|этой|тогда|вместо|замен\w*|that|instead|replace)\b", re.I)
_NAMES = {
    "table": r"таблиц|таблич|table",
    "code": r"\bкод|\bcode",
    "numbered steps": r"шаг|спис|steps|list",
    "calculation": r"числ|расч[её]т|вычисл|calculat|numbers",
    "question": r"вопрос|question",
}
_ARITHMETIC = re.compile(r"\d\s*[%.)]?\s*[+/=×÷−*–-]\s*[(]?\s*\d")
_TABLE = re.compile(r"(?m)^\s*\|?\s*:?-{2,}\s*:?\s*\|\s*:?-{2,}")
_CODE = re.compile(r"(?ms)^`{3,}[^\n]*\n.+?^`{3,}")
_SIGNALS: tuple[Outcome, ...] = ("confirmed", "continued", "corrected", "unknown")


class _Data(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Situation(_Data):
    words: frozenset[str]
    embedding: str = Field(default="", pattern=r"^(?:[A-Za-z0-9+/]{416})?$")
    independent: bool = False


class Reaction(_Data):
    outcome: Outcome
    source: str
    sequence: int


class Attempt(_Data):
    chat: str
    question: str
    answer: str
    epoch: str
    situation: Situation
    shapes: tuple[str, ...]
    reactions: dict[str, Reaction] = Field(default_factory=dict)

    @property
    def shape(self) -> str:
        return " + ".join(self.shapes)

    def outcomes(self) -> dict[str, Outcome]:
        return {key: value.outcome for key, value in self.reactions.items()} or {self.shape: "unknown"}


class ReplyExperience(_Data):
    attempts: dict[str, Attempt] = Field(default_factory=dict)
    retained: dict[str, dict[str, int]] = Field(default_factory=dict)
    disabled: frozenset[str] = frozenset()

    def counts(self) -> dict[str, Counter[str]]:
        totals = {key: Counter(counts) for key, counts in self.retained.items()}
        for item in self.attempts.values():
            for key, outcome in item.outcomes().items():
                totals.setdefault(key, Counter())[outcome] += 1
        return totals


def own_input(given: MessageInput | None) -> bool:
    return bool(
        given
        and given.text.strip()
        and not (
            given.attachments
            or given.quotes
            or given.mentions
            or given.context.page_id
            or given.context.material_id
            or given.context.study_id
        )
    )


def words(text: str) -> frozenset[str]:
    terms = (
        word
        for word in re.findall(r"[\w]+", text[:2048].casefold().replace("ё", "е"))
        if word not in _STOP and (len(word) >= 3 or word.isdigit())
    )
    return frozenset(hashlib.blake2s(word[:5].encode(), digest_size=8).hexdigest() for word in terms)


def situation(text: str) -> Situation:
    vector = ENCODER.vector(text)
    packed = bytes(round(max(-1, min(1, x)) * 127) + 128 for x in vector)
    return Situation(
        words=words(text),
        embedding=base64.b64encode(packed).decode("ascii"),
        independent=bool(_SELF.search(text)),
    )


def relevance(query: Situation, other: Situation, *, lexical_only: bool = False) -> float:
    if query.independent != other.independent:
        return 0
    common = len(query.words & other.words)
    lexical = common / math.sqrt(max(1, len(query.words) * len(other.words)))
    score = lexical if lexical >= 0.25 else 0.0
    if not lexical_only and query.embedding and other.embedding:
        import numpy as np

        def unpack(value: str) -> np.ndarray:
            return np.frombuffer(base64.b64decode(value), dtype=np.uint8).astype(np.float32) - 128

        a, b = unpack(query.embedding), unpack(other.embedding)
        cosine = float(a @ b) / max(1, float(np.linalg.norm(a) * np.linalg.norm(b)))
        # A close semantic match may have no shared words. Weak topical resemblance abstains.
        if cosine >= 0.75:
            score = max(score, cosine)
    return score


def delivered(question: Message, answer: Message, epoch: str) -> Attempt | None:
    from ..chats.model import TextPart

    given = question.input
    if (
        given is None
        or not own_input(given)
        or given.selection
        or answer.role != "assistant"
        or answer.state != "done"
        or answer.reply_to != question.id
        or answer.chat_id != question.chat_id
    ):
        return None
    text = "".join(p.text for p in answer.parts if isinstance(p, TextPart)).strip()
    shapes = set()
    for part in answer.parts:
        if isinstance(part, BlockPart) and part.state == "ready" and part.kind:
            shapes.add("block " + part.kind)
    prose = _CODE.sub("", text)
    if _CODE.search(text):
        shapes.add("code")
    if _TABLE.search(prose):
        shapes.add("table")
    if len(re.findall(r"(?m)^\s*\d+[.)]\s+\S", prose)) >= 2:
        shapes.add("numbered steps")
    if _ARITHMETIC.search(prose):
        shapes.add("calculation")
    if prose.rstrip().endswith("?"):
        shapes.add("question")
    if not shapes and len(text) >= 30:
        shapes.add("prose")
    if not shapes:
        return None
    return Attempt(
        chat=answer.chat_id,
        question=question.id,
        answer=answer.id,
        epoch=epoch,
        situation=situation(given.text),
        shapes=tuple(sorted(shapes)),
    )


def _named(text: str, name: str) -> bool:
    return bool(name in _NAMES and re.search(_NAMES[name], text, re.I))


def feedback(item: Attempt, given: MessageInput) -> dict[str, Outcome]:
    result: dict[str, Outcome] = {}
    clean = given.text.strip()
    if given.selection and given.selection.intent == "wrong":
        return {item.shape: "corrected"}
    # Do not turn a quotation, question about someone else or a hypothetical into a vote.
    if re.search(
        r"[«»“”\x22\x60]|(?:помог\w*|подош\w*)\s+бы\b|\b(?:would|might) (?:have )?help", clean, re.I
    ):
        return {}
    if "?" in clean and _APPROVAL.search(clean) and not _CORRECTION.search(clean):
        return {}
    # An explicit clause can attribute an outcome to one component. A generic continuation
    # belongs to the complete delivered response, even when that response had several parts.
    for clause in re.split(r"[,;.!?]\s*(?:а\s+|но\s+|but\s+|and\s+)?", clean):
        named = [shape for shape in item.shapes if _named(clause, shape)]
        if len(named) == 1:
            if _CORRECTION.search(clause):
                result[named[0]] = "corrected"
            elif _APPROVAL.search(clause):
                result[named[0]] = "confirmed"
    if result:
        return result
    if _CORRECTION.search(clean):
        return {item.shape: "corrected"}
    if _APPROVAL.search(clean):
        return {item.shape: "confirmed"}
    linked_values = re.search(r"\d", clean) and (
        _REFERENT.search(clean) or re.fullmatch(r"(?:а если|what if)\s+(?:взять\s+)?\d+[?.!]?", clean, re.I)
    )
    continuing = re.fullmatch(
        r"(?:понял[аи]?,?\s*)?(?:продолжим|продолжаем)(?:\s+(?:этот|это|тот же)"
        r"\s+\w+)?(?:\s+дальше)?[.!]?|(?:let.s |please )?continue (?:this|with that)[.!]?",
        clean,
        re.I,
    )
    if given.selection or continuing or (_CONTINUATION.match(clean) and linked_values):
        return {item.shape: "continued"}
    if ("?" in clean or _REFERENT.search(clean)) and relevance(situation(clean), item.situation) >= 0.5:
        return {item.shape: "continued"}
    return {}


def target(
    experience: ReplyExperience, question: Message, prior: Sequence[Message], epoch: str
) -> Attempt | None:
    given = question.input
    if given is None or not own_input(given):
        return None
    picked = given.selection
    if picked:
        item = experience.attempts.get(picked.message_id)
        return item if item and item.chat == question.chat_id and item.epoch == epoch else None
    recent = [m for m in prior[-8:] if m.role == "assistant" and m.chat_id == question.chat_id]
    if not recent:
        return None
    current = experience.attempts.get(recent[-1].id)
    if _CORRECTION.search(given.text) and not (
        current and any(_named(given.text, s) for s in current.shapes)
    ):
        # Only revisit a single identifiable recent response; a generic objection addresses the last turn.
        matches = [
            item
            for msg in recent[:-1]
            if (item := experience.attempts.get(msg.id))
            and item.epoch == epoch
            and any(_named(given.text, s) for s in item.shapes)
        ]
        if len(matches) == 1:
            return matches[0]
        if re.search(r"я (?:спрашивал|имел[аи]? в виду)|i (?:meant|was asking)", given.text, re.I):
            identifiers = {key for term in re.findall(r"\d+", given.text) for key in words(term)}
            if identifiers:
                matching = [
                    item
                    for msg in recent
                    if (item := experience.attempts.get(msg.id))
                    and item.epoch == epoch
                    and identifiers <= item.situation.words
                ]
                return matching[0] if len(matching) == 1 else None
            if matches:
                return None
    return current if current and current.epoch == epoch else None


def updated(item: Attempt, reactions: dict[str, Outcome], source: str, seq: int) -> Attempt:
    if not reactions or any(r.sequence >= seq for r in item.reactions.values()):
        return item
    results = dict(item.reactions)
    if all(outcome == "continued" for outcome in reactions.values()) and results:
        return item
    if set(reactions) == {item.shape}:
        results.clear()
    else:
        results.pop(item.shape, None)
    for key, outcome in reactions.items():
        results[key] = Reaction(outcome=outcome, source=source, sequence=seq)
    return item.model_copy(update={"reactions": results})


def withdraw(
    memory: ReplyExperience,
    sources: frozenset[str],
    scopes: frozenset[str],
    preserve: frozenset[str],
    discard: frozenset[str],
) -> ReplyExperience:
    attempts = {}
    retained = {key: dict(value) for key, value in memory.retained.items()}
    for key, item in memory.attempts.items():
        roots = {item.answer, item.question}
        if item.chat in scopes or roots & sources:
            if item.chat in preserve and not roots & discard:
                for name, outcome in item.outcomes().items():
                    reaction = item.reactions.get(name)
                    if reaction and reaction.source in discard:
                        outcome = "unknown"
                    counts = retained.setdefault(name, {})
                    counts[outcome] = counts.get(outcome, 0) + 1
            continue
        remaining = {k: v for k, v in item.reactions.items() if v.source not in sources}
        attempts[key] = (
            item if remaining == item.reactions else item.model_copy(update={"reactions": remaining})
        )
    return memory.model_copy(update={"attempts": attempts, "retained": retained})


# A mentioned paragraph can be the subject of a question. Match requests for a form of reply.
_PLAIN_REQUEST = re.compile(
    r"\b(?:ответь|ответьте|напиши|напишите|пиши|изложи|мне нужен|хочу получить)\s+"
    r"(?:(?:мне|только|ответ|пожалуйста|в)\s+)*"
    r"(?:(?:(?:один|одним|одном|коротк\w*|связн\w*|небольш\w*)\s+){1,3}абзац(?:ем|е)?\b"
    r"|(?:обычным|сплошным|простым|связным)\s+текстом)"
    r"|\b(?:(?:answer|reply|respond|write|explain)\s+in|use)\s+"
    r"(?:(?:(?:a|one|single|short|brief)\s+){1,3}paragraph|plain text|prose)\b",
    re.I,
)


def _explicit_format(text: str) -> bool:
    """Current format directives make historical formats unnecessary for this turn."""
    return bool(
        _PLAIN_REQUEST.search(text) or re.search(
            r"\b(?:без\s+(?:таблиц|примеров|кода|списк\w*|решения)|одним предложением"
            r"|without\s+(?:tables?|examples?|code|lists?|solutions?)|one sentence)\b",
            text,
            re.I,
        )
    )


def _nearest(memory: ReplyExperience, query: Situation) -> list[tuple[Attempt, float]]:
    eligible = [
        item
        for item in reversed(memory.attempts.values())
        if item.situation.independent == query.independent
        and item.shape not in memory.disabled
        and not memory.disabled.intersection(item.shapes)
    ]
    if len(eligible) <= 32:
        return [(item, score) for item in eligible if (score := relevance(query, item.situation)) > 0]
    scores = [relevance(query, item.situation, lexical_only=True) for item in eligible]
    if query.embedding:
        import numpy as np

        positions = [i for i, item in enumerate(eligible) if item.situation.embedding]
        if positions:
            packed = b"".join(base64.b64decode(eligible[i].situation.embedding) for i in positions)
            q = np.frombuffer(base64.b64decode(query.embedding), dtype=np.uint8).astype(np.float32) - 128
            matrix = np.frombuffer(packed, dtype=np.uint8).reshape(len(positions), len(q)).astype(np.float32)
            matrix -= 128
            norm = np.maximum(1, np.linalg.norm(matrix, axis=1) * np.linalg.norm(q))
            for i, cosine in zip(positions, (matrix @ q) / norm, strict=True):
                if cosine >= 0.75:
                    scores[i] = max(scores[i], float(cosine))
    order = sorted((i for i, score in enumerate(scores) if score), key=scores.__getitem__, reverse=True)
    # If a single long discussion dominates the nearest neighbors, still give separate
    # equally relevant discussions a voice. Keep closeness primary across different scores.
    seen: set[tuple[float, str]] = set()

    def priority(i: int) -> tuple[float, bool]:
        group = round(scores[i], 2), eligible[i].chat
        repeated = group in seen
        seen.add(group)
        return -group[0], repeated

    chosen = sorted(order, key=priority)[:32]
    return [(eligible[i], scores[i]) for i in chosen]


@dataclass(frozen=True)
class ResponseEvidence:
    shape: str
    utility: float
    counts: Counter[str]
    discussions: int
    confirming_discussions: int

    def describe(self) -> str:
        details = " ".join(f"{key}={self.counts[key]}" for key in _SIGNALS)
        return f"{self.shape}: {details} discussions={self.discussions}"


def ranked_evidence(memory: ReplyExperience, query: str) -> list[ResponseEvidence]:
    if not query.strip() or not memory.attempts or _explicit_format(query):
        return []
    q = situation(query)
    groups: dict[str, Counter[str]] = defaultdict(Counter)
    weights: dict[str, dict[str, list[float]]] = defaultdict(dict)
    confirmations: dict[str, set[str]] = defaultdict(set)
    for item, weight in _nearest(memory, q):
        for name, outcome in item.outcomes().items():
            if name in memory.disabled or item.shape in memory.disabled:
                continue
            groups[name][outcome] += 1
            if outcome == "confirmed":
                confirmations[name].add(item.chat)
            # Give each discussion at most one full vote per response shape.
            by_chat = weights[name].setdefault(item.chat, [0.0, 0.0, 0.0])
            if outcome != "unknown":
                by_chat[0] += weight * {"confirmed": 1, "continued": 0.2, "corrected": -1}[outcome]
                by_chat[1] += 1
                by_chat[2] = max(by_chat[2], weight)
    candidates = []
    for name, counts in groups.items():
        evidence = [v for v in weights[name].values() if v[1]]
        if not evidence:
            continue
        # A removed chat has lost its context. Its anonymous counts can break a tie
        # between already relevant approaches, never retrieve or establish one alone.
        archive = memory.retained.get(name, {})
        archived_n = sum(archive.get(k, 0) for k in ("confirmed", "continued", "corrected"))
        prior = (
            archive.get("confirmed", 0) + 0.2 * archive.get("continued", 0) - archive.get("corrected", 0)
        ) / (2 + archived_n)
        utility = sum(total / count for total, count, _ in evidence) + 0.25 * prior
        utility /= 2 + sum(v[2] for v in evidence)
        candidates.append(ResponseEvidence(name, utility, counts, len(evidence), len(confirmations[name])))
    return sorted(candidates, key=lambda row: (abs(row.utility), row.shape), reverse=True)[:3]


def ranked(memory: ReplyExperience, query: str) -> list[str]:
    """Observations returned to the read-only search tool and offline evaluations."""
    return [row.describe() for row in ranked_evidence(memory, query)]

def original(memory: ReplyExperience, question: Message, prior: Sequence[Message]) -> str | None:
    from ..chats.model import TextPart

    given = question.input
    if given is None or not own_input(given) or not _ORIGINAL.search(given.text):
        return None
    reference = _ORIGINAL.sub("", given.text)
    identifiers = {
        token.casefold()
        for token in re.findall(r"\w+", reference)
        if token[:1].isupper() or any(c.isdigit() for c in token)
    }
    description = re.sub(
        r"\b(?:сохран[её]нн\w*|расч[её]т\w*|пример\w*|ответ\w*|пожалуйста|"
        r"saved|calculation|example|answer|please)\b",
        "",
        reference,
        flags=re.I,
    )
    query = words(description)
    source_questions = {
        msg.id: msg.input.text for msg in prior if msg.input and msg.chat_id == question.chat_id
    }
    matches = []
    for message in prior:
        item = memory.attempts.get(message.id)
        if item is None or item.chat != question.chat_id or message.state != "done":
            continue
        if not all(isinstance(part, TextPart) for part in message.parts):
            continue
        body = "".join(part.text for part in message.parts if isinstance(part, TextPart))
        available = item.situation.words | words(body)
        if not query or query - available:
            continue
        source = source_questions.get(item.question, "") + " " + body
        if not identifiers <= {token.casefold() for token in re.findall(r"\w+", source)}:
            continue
        overlap = len(query & available)
        if (identifiers or overlap >= 2) and len(body.encode()) <= 2400:
            matches.append((overlap, body))
    matches.sort(reverse=True)
    if matches and (len(matches) == 1 or matches[0][0] > matches[1][0]):
        return matches[0][1]
    return ""
