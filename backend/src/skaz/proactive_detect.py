"""Noticing that someone is asking the user something, from confirmed speech only.

The trigger is deliberately strict (issue #10): one of the user's configured names,
nicknames or code phrases used as a *direct address* — a vocative — together with a
question or a request. Everything else is silence:

* a third-person mention ("as Alex said", "ask Alex", "Алекс сказал") never fires,
  because the name is then embedded in the sentence instead of standing apart from it;
* a plain statement to the user ("Alex, thanks.") never fires: it asks nothing;
* importance, a "you missed something" guess or inattention are not inputs here at all.

When the recogniser dropped the punctuation that would make the address certain
("Alex what do you think") the detection is reported as ``possible``, so the card can
say "Possibly addressed to you" instead of pretending to know.

This module is pure text processing: no model, no storage, no clock. The service maps
the character offsets it returns back onto transcript tokens.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

Addressed = Literal["direct", "possible"]

#: Aliases longer than this are refused by the settings schema too.
MAX_ALIAS_CHARS = 60

#: End of a sentence: terminal punctuation, optionally closing a quote or bracket.
_BOUNDARY = re.compile(r"[.!?…]+['\"»”)\]]*(?=\s|$)")
_TERMINAL = re.compile(r"[.!?…]['\"»”)\]]*\s*$")
_WORD = re.compile(r"[^\W_]+(?:['’-][^\W_]+)*", re.U)

#: Words that may precede a vocative without making it part of the clause.
_INTERJECTIONS = frozenset({
    "hey", "hi", "hello", "ok", "okay", "so", "and", "well", "alright", "oh", "now", "right", "yes",
    "yeah", "listen", "look", "um", "uh", "dear",
    "эй", "слушай", "слушайте", "а", "ну", "так", "привет", "здравствуй", "здравствуйте", "вот",
    "и", "да", "окей", "ок", "смотри", "смотрите", "хорошо", "итак", "кстати", "дорогой", "дорогая",
})

#: Words that make a sentence-final name an object ("have you met Alex?"), not an address.
_OBJECT_BEFORE_NAME = frozenset({
    "to", "with", "for", "about", "from", "by", "at", "of", "and", "or", "ask", "asked", "tell", "told",
    "met", "meet", "call", "called", "see", "saw", "like", "than", "as", "the", "a", "is", "was", "thank",
    "у", "с", "со", "к", "ко", "о", "об", "про", "для", "от", "и", "или", "как", "чем", "без", "при",
    "спроси", "спросите", "спросим", "позови", "позовите", "видел", "видели", "знаешь", "знаете",
})

#: Verbs that, right after a name, make it the subject of reported speech.
_REPORTING = frozenset({
    "said", "says", "told", "tells", "thinks", "thought", "asked", "asks", "mentioned", "mentions",
    "suggested", "suggests", "wrote", "writes", "believes", "wants", "is", "was", "has", "had", "did",
    "does", "and", "or",
    "сказал", "сказала", "говорит", "говорил", "говорила", "считает", "считал", "считала", "спросил",
    "спросила", "спрашивал", "спрашивала", "упоминал", "упоминала", "предложил", "предложила", "написал",
    "написала", "думает", "хочет", "уже", "тоже", "также", "и", "или",
})

_QUESTION_START = re.compile(
    r"^(?:what|why|how|when|where|who|whom|whose|which|do|does|did|is|are|was|were|can|could|would|will"
    r"|should|shall|have|has|had|may|might|any|anything|got|"
    r"что|чего|чем|как|почему|зачем|когда|где|куда|откуда|кто|кого|кому|какой|какая|какое|какие|каким"
    r"|какую|каков|сколько|чей|чья|чьё|чьи|разве|неужели|можно|есть)\b",
    re.I,
)
_QUESTION_ANYWHERE = re.compile(r"\bли\b", re.I)

_REQUEST = re.compile(
    r"\b(?:please|pls|could you|can you|would you|will you|would you mind|do you mind|do you have|do you know"
    r"|what do you think|what are your thoughts|your thoughts|your take|your opinion|any thoughts"
    r"|any update|any updates|let us know|let me know|go ahead|over to you|your turn)\b"
    r"|^(?:tell|explain|remind|show|give|share|walk|send|clarify|describe|summari[sz]e|repeat|comment"
    r"|confirm|check|update|help|answer|introduce|present|take|say|elaborate|recap)\b"
    r"|\b(?:пожалуйста|можешь|можете|могли бы|сможешь|сможете|не мог бы|не могла бы|не могли бы"
    r"|подскажи|подскажите|расскажи|расскажите|объясни|объясните|скажи|скажите|напомни|напомните"
    r"|покажи|покажите|поделись|поделитесь|дай|дайте|прокомментируй|прокомментируйте|ответь|ответьте"
    r"|уточни|уточните|проверь|проверьте|помоги|помогите|представь|представьте|повтори|повторите"
    r"|как думаешь|как думаете|что думаешь|что думаете|твоё мнение|твое мнение|ваше мнение"
    r"|что скажешь|что скажете|твой ход|ваш ход|тебе слово|вам слово)\b",
    re.I,
)
_SECOND_PERSON = re.compile(
    r"\b(?:you|your|yours|yourself|ты|тебя|тебе|тобой|твой|твоя|твоё|твое|твои|вы|вас|вам|вами|ваш|ваша"
    r"|ваше|ваши)\b",
    re.I,
)
#: How many words, besides the name, a short "Alex, quick question." preface may have
#: for the next sentence to count as the question addressed by it.
_PREFACE_WORDS = 5


@dataclass(frozen=True)
class Sentence:
    start: int
    end: int
    text: str
    terminated: bool


@dataclass(frozen=True)
class Detection:
    """A question or request addressed to one of the user's names.

    ``start``/``end`` are character offsets into the analysed text covering the
    address and the question as heard. ``finished`` is false while the question
    sentence is still being spoken (no terminal punctuation and more may follow).
    """

    addressed: Addressed
    alias: str
    start: int
    end: int
    finished: bool
    text: str


def normalise_aliases(aliases: Sequence[str]) -> list[str]:
    """Trimmed, de-duplicated (case-insensitively) aliases; longest first."""
    seen: dict[str, str] = {}
    for alias in aliases:
        cleaned = " ".join(alias.split())
        if cleaned and cleaned.casefold() not in seen:
            seen[cleaned.casefold()] = cleaned
    return sorted(seen.values(), key=lambda value: (-len(value), value.casefold()))


def split_sentences(text: str) -> list[Sentence]:
    """Sentences with their offsets. A full stop inside "3.5" is not a boundary."""
    sentences: list[Sentence] = []
    start = 0
    for match in _BOUNDARY.finditer(text):
        _add_sentence(text, start, match.end(), sentences)
        start = match.end()
    _add_sentence(text, start, len(text), sentences)
    return sentences


def _add_sentence(text: str, start: int, end: int, out: list[Sentence]) -> None:
    raw = text[start:end]
    if not raw.strip():
        return
    first = start + len(raw) - len(raw.lstrip())
    last = start + len(raw.rstrip())
    body = text[first:last]
    out.append(Sentence(first, last, body, bool(_TERMINAL.search(body))))


def _alias_pattern(alias: str) -> re.Pattern[str]:
    words = [re.escape(word) for word in alias.split()]
    return re.compile(r"(?<![\w])" + r"\s+".join(words) + r"(?![\w])", re.I | re.U)


def is_question_or_request(text: str) -> bool:
    stripped = text.strip().strip("\"'«»“”()[]—–- ")
    if not _WORD.search(stripped):
        return False
    if stripped.rstrip("\"'»”)]").endswith("?"):
        return True
    return bool(
        _QUESTION_START.search(stripped)
        or _QUESTION_ANYWHERE.search(stripped)
        or _REQUEST.search(stripped)
    )


def _words(text: str) -> list[str]:
    return [word.casefold() for word in _WORD.findall(text)]


def _only_interjections(text: str) -> bool:
    return all(word in _INTERJECTIONS for word in _words(text))


def _address(sentence: str, start: int, end: int) -> Literal["vocative", "bare_lead", "bare_tail"] | None:
    """How a name at ``sentence[start:end]`` relates to its sentence, if it is an address."""
    before = sentence[:start]
    after = sentence[end:]
    before_stripped = before.rstrip()
    after_stripped = after.strip()
    lead = _only_interjections(before)
    tail = not after_stripped or not _WORD.search(after_stripped)
    # "Alex, …", "Hey Alex — …", "Alex?" / "Alex." standing alone.
    if lead and (not after_stripped or after_stripped[0] in ",!?:;—–-.…"):
        return "vocative"
    # "…, Alex?" / "…, Alex." — the name closes the sentence after a comma.
    if tail and before_stripped.endswith((",", "—", "–")):
        return "vocative"
    # "So, Alex, what …" / "What do you think, Alex, about …".
    if before_stripped.endswith(",") and after_stripped.startswith(","):
        return "vocative"
    following = _words(after_stripped)[:1]
    if after_stripped[:1] in ("'", "’") or (following and following[0] in _REPORTING):
        return None  # "Alex's point", "Alex said …": the name is talked about, not to.
    # The recogniser may drop the comma of an address: report it as uncertain only.
    if lead and after_stripped:
        return "bare_lead"
    if tail and before_stripped:
        previous = _words(before_stripped)
        if previous and previous[-1] not in _OBJECT_BEFORE_NAME:
            return "bare_tail"
    return None


def _without(sentence: str, start: int, end: int) -> str:
    return (sentence[:start] + " " + sentence[end:]).strip(" ,.;:—–-")


def detect(text: str, aliases: Sequence[str], *, final: bool) -> list[Detection]:
    """Every question or request addressed to one of ``aliases`` in ``text``.

    ``final`` tells whether more speech can still extend the text: a sentence
    without terminal punctuation is finished only when the text is final.
    """
    names = normalise_aliases(aliases)
    if not names or not text.strip():
        return []
    patterns = [(alias, _alias_pattern(alias)) for alias in names]
    sentences = split_sentences(text)
    found: list[Detection] = []
    used_until = -1
    for index, sentence in enumerate(sentences):
        if sentence.start < used_until:
            continue
        match = _first_address(sentence.text, patterns)
        if match is None:
            continue
        alias, kind, (a, b) = match
        rest = _without(sentence.text, a, b)
        question: Sentence | None = None
        if is_question_or_request(rest):
            if kind != "vocative" and not _SECOND_PERSON.search(rest) and not _REQUEST.search(rest):
                continue  # An unpunctuated name next to an impersonal question is not an address.
            question = sentence
        elif kind == "vocative" and len(_words(rest)) <= _PREFACE_WORDS and index + 1 < len(sentences):
            following = sentences[index + 1]
            if is_question_or_request(following.text):
                question = following
        if question is None:
            continue
        addressed: Addressed = "direct" if kind == "vocative" else "possible"
        is_last = question is sentences[-1]
        finished = question.terminated or final or not is_last
        found.append(Detection(
            addressed=addressed, alias=alias, start=sentence.start, end=question.end,
            finished=finished, text=text[sentence.start:question.end],
        ))
        used_until = question.end
    return found


def _first_address(
    sentence: str, patterns: list[tuple[str, re.Pattern[str]]],
) -> tuple[str, Literal["vocative", "bare_lead", "bare_tail"], tuple[int, int]] | None:
    best: tuple[str, Literal["vocative", "bare_lead", "bare_tail"], tuple[int, int]] | None = None
    for alias, pattern in patterns:
        for match in pattern.finditer(sentence):
            kind = _address(sentence, match.start(), match.end())
            if kind is None:
                continue
            candidate = (alias, kind, (match.start(), match.end()))
            if best is None or (kind == "vocative" and best[1] != "vocative") or (
                (kind == "vocative") == (best[1] == "vocative") and match.start() < best[2][0]
            ):
                best = candidate
    return best


def public_query(question: str, aliases: Sequence[str]) -> str:
    """The question without the user's names: a starting point for a web lookup.

    It only removes what SKAZ knows is private (the configured names) and the
    address punctuation around them; the user still reviews and edits the query
    before anything is sent.
    """
    result = question
    for alias in normalise_aliases(aliases):
        result = _alias_pattern(alias).sub(" ", result)
    words = result.split()
    while words and words[0].strip(",.!?:;—–-").casefold() in _INTERJECTIONS:
        words.pop(0)
    cleaned = " ".join(words)
    cleaned = re.sub(r"\s+([,.!?;:])", r"\1", cleaned)
    cleaned = re.sub(r"^[\s,.;:—–-]+", "", cleaned)
    cleaned = re.sub(r",\s*([?.!])", r"\1", cleaned)
    return cleaned.strip()[:400]


def mentions_alias(text: str, aliases: Sequence[str]) -> bool:
    return any(_alias_pattern(alias).search(text) for alias in normalise_aliases(aliases))
