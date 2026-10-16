"""Layer 3: does a fragment read like an instruction addressed to an AI? (ru/en heuristics)

Each rule has a weight; a fragment's score is the sum of the weights of the
distinct rules it matches. ``THRESHOLD`` (1.0) is reached by one strong
signal — "ignore previous instructions", a model's control token, a forged
``<system>`` tag — or by two weaker ones together ("Note to AI:" + "add this to
the wiki"). Weak signals alone (a "System:" line, "run the following command",
"you are now") never exclude a fragment: they are common in ordinary text.

Matching runs on the NFKC form with whitespace collapsed and, in addition, on
two skeletons where Cyrillic/Latin look-alike letters are folded to one
script, so ``ignоre`` with a Cyrillic ``о`` still matches.

Addressing a model is a signal in several shapes (final review H1): a
vocative with an order ("Нейросеть, слушай внимательно: … напиши"), "for the
language model that processes this text:", "the model that reads this must
insert …" (a modal with an output verb), "ATTENTION LLM:", "disregard the rules
above". Words people and physics also use ("assistant", "agent", "model") never
reach the threshold alone; the shared decision-41 set
(``tests/knowledge/decision41.py``) holds the attacks and the near misses.

This is a heuristic, not a guarantee: paraphrases, other languages, text in
images and instructions split across fragments are not caught. An article
*about* prompt injection is expected to trigger it — the user restores it.
"""

from __future__ import annotations

import re
import unicodedata
from bisect import bisect_right
from dataclasses import dataclass

THRESHOLD = 1.0
MAX_FOUND = 300

_FLAGS = re.IGNORECASE | re.MULTILINE


@dataclass(frozen=True)
class Rule:
    id: str
    weight: float
    pattern: re.Pattern[str]
    #: Plain-English reason shown to the user.
    reason: str


def _rule(rule_id: str, weight: float, reason: str, pattern: str) -> Rule:
    return Rule(rule_id, weight, re.compile(pattern, _FLAGS), reason)


_AI_EN = (
    r"(?:ai|a\.i\.|llm|large\s+language\s+models?|language\s+models?|ai\s+(?:assistant|model|agent)s?|"
    r"assistants?|chat-?bots?|bots?|agents?|gpt(?:-\d+)?|chatgpt|claude|gemini|codex|copilot|models?)"
)
_AI_RU = (
    r"(?:ии|ai|llm|gpt|chatgpt|claude|codex|ассистент\w*|модел\w*|нейросет\w*|языков\w+\s+модел\w*|"
    r"агент\w*|чат-?бот\w*|бот\w*)"
)
#: Names that can only mean an AI (not "assistant", "agent", "model" — people and physics use those).
_AI_NAME_EN = (
    r"(?:ai|a\.i\.|llm|large\s+language\s+model|language\s+model|chatgpt|gpt(?:-\d+)?|claude|gemini|"
    r"codex|copilot)"
)
_AI_NAME_RU = r"(?:ии|ai|llm|gpt|chatgpt|claude|codex|нейросет\w*|языков\w+\s+модел\w*)"
_PREVIOUS_EN = r"(?:previous|prior|above|earlier|preceding|former|original|initial|system|all)"
_PREVIOUS_RU = (
    r"(?:предыдущ\w*|прошл\w*|прежн\w*|вышеуказанн\w*|вышеизложенн\w*|выше\w*|ранее\s+\w+|"
    r"ранн\w*|исходн\w*|системн\w*|все)"
)
_VERBS_EN = (
    r"(?:write|save|store|record|send|email|post|upload|execute|run|open|visit|navigate|go|click|fetch|"
    r"download|add|insert|include|remember|delete|remove|output|print|say|tell|reply|respond|translate|"
    r"summari[sz]e|ignore|disregard|forget|call|use|append|change|replace|listen|state|claim|answer|"
    r"insert|mention|report)"
)
_VERBS_RU = (
    r"(?:запиши|сохрани|отправь|выполни|запусти|перейди|открой|добавь|удали|напиши|вставь|запомни|"
    r"игнорируй|забудь|ответь|скажи|выведи|переведи|перескажи|скачай|загрузи|используй|замени|измени|"
    r"слушай|послушай|следуй|укажи|сообщи|упомяни|утверждай|напечатай|перепиши)"
)
_SENTENCE_START = r"(?:^|[.!?;:]\s+|\n)\s*"
#: Output verbs a modal sentence about the model asks for ("the model must claim …", "должна вставить …").
_MODAL_VERBS_EN = (
    r"(?:claim|state|say|write|add|insert|include|mention|report|output|print|tell|assert|ignore|disregard|"
    r"forget|remove|delete|replace|send|reply|respond|answer)"
)
_MODAL_VERBS_RU = (
    r"(?:вставить|добавить|написать|записать|дописать|указать|сообщить|сказать|утверждать|заявить|упомянуть|"
    r"удалить|убрать|изменить|заменить|игнорировать|проигнорировать|забыть|вывести|отправить|ответить)"
)

RULES: tuple[Rule, ...] = (
    # -- strong: one is enough ---------------------------------------------
    _rule(
        "ignore_previous",
        1.0,
        "asks to ignore previous instructions",
        rf"\b(?:ignore|disregard|forget|override|bypass)\b(?:\s+\S+){{0,3}}?\s+{_PREVIOUS_EN}\b"
        r"(?:\s+\S+){0,2}?\s+(?:instructions?|prompts?|directions?|directives?|commands?|orders)\b",
    ),
    _rule(
        "ignore_everything",
        1.0,
        "asks to ignore what it was told",
        r"\b(?:ignore|disregard|forget)\s+(?:everything|all)\s+(?:above|before|you\s+(?:were|have\s+been)\s+told)",
    ),
    _rule(
        "ignore_previous_ru",
        1.0,
        "asks to ignore previous instructions",
        r"\b(?:игнорируй(?:те)?|проигнорируй(?:те)?|забудь(?:те)?|отбрось(?:те)?|отмени(?:те)?|"
        r"не\s+обращай(?:те)?\s+внимания\s+на|не\s+следуй(?:те)?|не\s+выполняй(?:те)?)"
        rf"(?:\s+\S+){{0,3}}?\s+{_PREVIOUS_RU}(?:\s+\S+){{0,2}}?\s+"
        r"(?:инструкц\w*|указани\w*|команд\w*|промпт\w*|распоряжени\w*)",
    ),
    _rule(
        "ignore_everything_ru",
        1.0,
        "asks to ignore what it was told",
        r"\b(?:игнорируй(?:те)?|забудь(?:те)?)\s+(?:всё|все)\s+(?:что\s+(?:тебе|вам)\s+говорили|выше|до\s+этого)",
    ),
    _rule(
        "ignore_rules",
        1.0,
        "asks to ignore the rules it was given",
        r"\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|these\s+)*"
        r"(?:rules|guidelines|guardrails|constraints|restrictions|policies|safety\s+rules)\s+"
        r"(?:above|before|you\s+(?:were|have\s+been)\s+given|stated\s+(?:above|earlier))\b",
    ),
    _rule(
        "ignore_rules_ru",
        1.0,
        "asks to ignore the rules it was given",
        r"\b(?:игнорируй(?:те)?|проигнорируй(?:те)?|забудь(?:те)?|отбрось(?:те)?|нарушь(?:те)?)\s+"
        r"(?:все\s+)?(?:правила|ограничения)\s+(?:выше|сверху|которые\s+тебе\s+дали)\b",
    ),
    _rule(
        "control_token",
        1.0,
        "contains a language model's control token",
        r"<\|\s*(?:im_start|im_end|im_sep|endoftext|system|user|assistant|eot_id|start_header_id|"
        r"end_header_id|begin_of_text|end_of_text|channel|message|fim_\w+)\s*\|>|\[/?INST\]|<<\s*/?SYS\s*>>|"
        r"</s>|<\s*/?\s*(?:start|end)_of_turn\s*>",
    ),
    _rule(
        "system_tag",
        1.0,
        "contains a forged system prompt tag",
        r"<\s*/?\s*(?:system|system[_-]prompt|sys)\s*>",
    ),
    # -- addressed to a model ----------------------------------------------
    _rule(
        "vocative_command",
        0.9,
        "gives an order addressed to an AI",
        rf"{_SENTENCE_START}(?:the\s+|dear\s+|hey\s+|attention\s*,?\s*)?{_AI_EN}\s*[,:!]\s*"
        rf"(?:please\s*,?\s*)?{_VERBS_EN}\b",
    ),
    _rule(
        "vocative_command_ru",
        0.9,
        "gives an order addressed to an AI",
        rf"{_SENTENCE_START}(?:дорог\w+\s+|уважаем\w+\s+|эй\s*,?\s*|внимание\s*,?\s*)?{_AI_RU}\s*[,:!]\s*"
        rf"(?:пожалуйста\s*,?\s*|внимание\s*[,:!]?\s*)?{_VERBS_RU}\b",
    ),
    _rule(
        "addressed_ai",
        0.5,
        "addresses an AI by name",
        rf"{_SENTENCE_START}(?:dear\s+|hey\s+|attention\s*,?\s*|внимание\s*,?\s*|эй\s*,?\s*|дорог\w+\s+)?"
        rf"(?:{_AI_NAME_EN}|{_AI_NAME_RU})\s*(?:[,!]|:(?!\s*(?:определени|истори|definition|history|"
        r"overview|обзор|введение|introduction)))",
    ),
    _rule(
        "ai_reading_this",
        0.8,
        "speaks to the AI that reads or processes the text",
        rf"\b{_AI_EN}\s*,?\s+(?:that|which|who)\s+(?:is\s+)?(?:\S+\s+)?"
        r"(?:process|read|summari[sz]|analy[sz]|ingest|index)\w*\s+(?:this|these|the\s+following)\b",
    ),
    _rule(
        "ai_reading_this_ru",
        0.8,
        "speaks to the AI that reads or processes the text",
        rf"\b{_AI_RU}\s*,?\s+(?:которая|который|которое|что)\s+(?:\S+\s+)?"
        r"(?:обрабатыва|чита|анализиру|пересказыва|конспектиру|прочита|обработа)\w*"
        r"(?:\s+(?:эт\w+|данн\w+|следующ\w+))?",
    ),
    _rule(
        "ai_must",
        0.7,
        "says what the AI must write",
        rf"\b{_AI_EN}\b[^.!?]{{0,80}}?\b(?:must|should|shall|has\s+to|is\s+to|needs\s+to|is\s+required\s+to)\s+"
        rf"(?:\S+\s+)?{_MODAL_VERBS_EN}\b",
    ),
    _rule(
        "ai_must_ru",
        0.7,
        "says what the AI must write",
        rf"\b{_AI_RU}[^.!?]{{0,80}}?\b(?:должн\w*|обязан\w*|следует|нужно|надо)\s+(?:\S+\s+)?{_MODAL_VERBS_RU}\b",
    ),
    _rule(
        "persona",
        0.8,
        "tells the reader it is an AI assistant",
        r"\byou\s+are\s+(?:now\s+)?(?:an?\s+|the\s+)?(?:helpful\s+|unrestricted\s+|uncensored\s+|new\s+|"
        r"jailbroken\s+)?(?:ai|assistant|chat-?bot|language\s+model|llm|gpt|dan|ai\s+assistant)\b",
    ),
    _rule(
        "persona_ru",
        0.8,
        "tells the reader it is an AI assistant",
        r"\bты\s*(?:[—–-]\s*|это\s+|теперь\s+|отныне\s+)?(?:полезн\w+\s+|услужлив\w+\s+|нов\w+\s+)?"
        r"(?:ии|ai|gpt|ассистент|помощник|чат-?бот|бот|языковая\s+модель|нейросеть|модель)\b",
    ),
    _rule(
        "if_you_are_ai",
        0.8,
        "speaks to an AI reading the text",
        rf"\b(?:if|when|since)\s+you(?:'re|\s+are)\s+(?:an?\s+|the\s+)?{_AI_EN}\b"
        r"(?!\s+(?:researcher|engineer|developer|enthusiast|student|company|startup|expert|specialist|"
        r"practitioner|professional|team|lab|user|fan|course|class))",
    ),
    _rule(
        "if_you_are_ai_ru",
        0.8,
        "speaks to an AI reading the text",
        rf"\b(?:если|когда)\s+ты\s*(?:[—–-]\s*|это\s+)?{_AI_RU}\b",
    ),
    _rule(
        "note_to_ai",
        0.8,
        "contains a note meant for an AI",
        rf"\b(?:note|message|instructions?|hint|reminder|attention|memo|prompt)\s+(?:to|for)\s+"
        rf"(?:the\s+|any\s+|all\s+)?{_AI_EN}\b",
    ),
    _rule(
        "note_to_ai_ru",
        0.8,
        "contains a note meant for an AI",
        rf"\b(?:инструкци\w*|указани\w*|сообщени\w*|примечани\w*|заметк\w*|обращени\w*|задани\w*|"
        rf"внимание)\s+(?:для|к)\s+{_AI_RU}",
    ),
    _rule(
        "for_the_ai_colon",
        0.6,
        "contains a note meant for an AI",
        rf"{_SENTENCE_START}(?:for|to)\s+(?:the\s+|any\s+|all\s+)?{_AI_EN}\b[^.!?:\n]{{0,80}}:|"
        rf"{_SENTENCE_START}(?:для|к)\s+{_AI_RU}[^.!?:\n]{{0,80}}:",
    ),
    _rule(
        "greeting_ai",
        0.7,
        "greets an AI directly",
        r"\b(?:dear|hey|hi|hello|attention)\s*,?\s+(?:ai|llm|assistant|chatgpt|claude|gpt|gemini|codex|"
        r"chatbot|language\s+model)\b",
    ),
    _rule(
        "greeting_ai_ru",
        0.7,
        "greets an AI directly",
        r"\b(?:дорог\w+|уважаем\w+|эй|привет|внимание)\s*,?\s+(?:ии|ассистент|нейросеть|chatgpt|claude|"
        r"gpt|codex|чат-?бот)\b",
    ),
    _rule(
        "ignore_content",
        0.6,
        "asks to ignore the text itself",
        r"\b(?:ignore|disregard)\s+(?:the|this|that)\s+(?:article|text|page|document|content|source|post)\b|"
        r"\b(?:игнорируй|не\s+обращай\s+внимания\s+на)\s+(?:эт\w+|данн\w+)\s+(?:стать\w+|текст\w*|страниц\w+|"
        r"документ\w*|источник\w*)",
    ),
    _rule(
        "from_now_on",
        0.6,
        "tries to change the reader's role",
        r"\b(?:from\s+now\s+on|starting\s+now|henceforth),?\s+you\s+(?:are|will|must|shall|should)\b",
    ),
    _rule(
        "from_now_on_ru",
        0.6,
        "tries to change the reader's role",
        r"\b(?:с\s+этого\s+момента|отныне|теперь)\s*,?\s+ты\s+(?:—|-|будешь|должен|являешься)",
    ),
    _rule(
        "act_as_ai",
        0.7,
        "asks to act as an unrestricted AI",
        r"\b(?:act|behave|respond)\s+as\s+(?:an?\s+)?(?:unrestricted|jailbroken|uncensored|dan|system|"
        r"ai\s+without)",
    ),
    _rule("you_are_now", 0.4, "tries to change the reader's role", r"\byou\s+are\s+now\b"),
    _rule("pretend", 0.3, "asks to pretend", r"\bpretend\s+(?:to\s+be|you(?:'re|\s+are))\b"),
    _rule(
        "role_prefix",
        0.6,
        "starts like a chat role line",
        r"^\s*(?:system|assistant|developer|система|ассистент)\s*:\s*\S",
    ),
    # -- what an injection asks for ----------------------------------------
    _rule(
        "hide_from_user",
        0.7,
        "asks to hide something from the user",
        r"\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention|reveal|show|disclose|let)\s+"
        r"(?:this\s+|it\s+|anything\s+)?(?:to\s+)?(?:the\s+)?(?:user|human|operator)\b|"
        r"\bwithout\s+(?:telling|informing|notifying)\s+the\s+user\b",
    ),
    _rule(
        "hide_from_user_ru",
        0.7,
        "asks to hide something from the user",
        r"\b(?:не|никогда\s+не)\s+(?:говори|сообщай|рассказывай|показывай|упоминай|раскрывай)\s+"
        r"(?:об\s+этом\s+|это\s+|ничего\s+)?(?:пользователю|человеку|оператору)\b|без\s+ведома\s+пользователя",
    ),
    _rule(
        "new_task",
        0.7,
        "announces new instructions",
        r"\b(?:your|the)\s+(?:real|true|actual|new|only|primary|secret|hidden)\s+(?:task|instructions?|goal|"
        r"objective|purpose|mission|job|orders)\s+(?:is|are|now)\b|\bnew\s+instructions?\s*:|"
        r"\bupdated\s+instructions?\s*:",
    ),
    _rule(
        "new_task_ru",
        0.7,
        "announces new instructions",
        r"\b(?:твоя|ваша)\s+(?:настоящая|истинная|новая|главная|единственная|секретная|реальная|скрытая)\s+"
        r"(?:задача|цель|инструкция|миссия|роль)\b|\bновые\s+(?:инструкции|указания)\s*:",
    ),
    _rule(
        "jailbreak",
        0.5,
        "uses jailbreak vocabulary",
        r"\b(?:system\s+prompt|developer\s+mode|jailbreak|dan\s+mode|do\s+anything\s+now)\b",
    ),
    _rule(
        "jailbreak_ru",
        0.5,
        "uses jailbreak vocabulary",
        r"\b(?:системн\w+\s+(?:промпт|подсказк|инструкци)\w*|режим\w*\s+разработчика|джейлбрейк\w*)",
    ),
    _rule(
        "write_to_memory",
        0.8,
        "asks to write something into the wiki or memory",
        r"\b(?:add|write|save|insert|append|store|put|record|include)\s+(?:this|the\s+following|these|that|it)"
        r"\s+(?:\S+\s+){0,3}?(?:to|into|in)\s+(?:the\s+|your\s+|its\s+)?(?:wiki|memory|notes|knowledge\s+base|"
        r"summary|database|long-term\s+memory|context|conspectus)\b",
    ),
    _rule(
        "write_to_memory_ru",
        0.8,
        "asks to write something into the wiki or memory",
        r"\b(?:добавь|запиши|сохрани|внеси|вставь|допиши|включи)\s+(?:\S+\s+){0,3}?(?:в|во)\s+"
        r"(?:wiki|вики|память|базу\s+знаний|заметк\w*|конспект\w*|контекст)",
    ),
    _rule(
        "exfiltrate",
        0.8,
        "asks to send data somewhere",
        r"\b(?:send|forward|email|post|upload|transmit|leak|exfiltrate)\s+(?:\S+\s+){0,5}?to\s+"
        r"(?:https?://|www\.|[\w.+-]+@[\w-]+\.)",
    ),
    _rule(
        "exfiltrate_ru",
        0.8,
        "asks to send data somewhere",
        r"\b(?:отправь|перешли|пошли|загрузи|передай|слей)\s+(?:\S+\s+){0,5}?(?:на|по\s+адресу|в)\s+"
        r"(?:https?://|www\.|[\w.+-]+@[\w-]+\.)",
    ),
    _rule(
        "when_processing",
        0.6,
        "addresses whoever processes the text",
        r"\bwhen\s+(?:you\s+)?(?:summari[sz]|process|read|analy[sz]|index|ingest|crawl)\w*\s+(?:this|the)\s+"
        r"(?:page|document|article|text|content|file|source|website|lecture|transcript|recording|video|talk|"
        r"lesson|material|notes)\b|"
        r"\bwhen\s+(?:you\s+)?(?:summari[sz]|process|analy[sz]|ingest|index)\w*\s*,",
    ),
    _rule(
        "when_processing_ru",
        0.6,
        "addresses whoever processes the text",
        r"\bкогда\s+(?:будешь|станешь|ты\s+будешь)\s+(?:пересказывать|обрабатывать|читать|анализировать|"
        r"резюмировать|конспектировать)\s+(?:этот|эту|это|данн\w+)|"
        r"\b(?:в\s+итогов\w+|в\s+(?:сво\w+\s+)?ответе|в\s+пересказе)\s+(?:текст\w*|конспект\w*|ответе)?\s*"
        r"(?:напиши|укажи|сообщи|скажи|добавь|вставь)",
    ),
    _rule(
        "follow_link",
        0.3,
        "asks to open a link",
        r"\b(?:visit|open|go\s+to|navigate\s+to|click|fetch|load|follow)\s+(?:this\s+|the\s+following\s+)?"
        r"(?:link|url)?\s*:?\s*(?:https?://|www\.)\S+|\bперейди\s+по\s+(?:этой\s+|следующей\s+)?ссылке",
    ),
    _rule(
        "run_command",
        0.3,
        "asks to run a command",
        r"\b(?:execute|run)\s+(?:the\s+following|this)\s+(?:command|code|script|shell)|"
        r"\bвыполни\s+(?:следующую\s+|эту\s+)?(?:команду|код|скрипт)",
    ),
    _rule(
        "as_an_ai",
        0.3,
        "talks about being an AI",
        r"\bas\s+an?\s+(?:ai|language\s+model|llm)\b|"
        r"\bкак\s+(?:ии|языковая\s+модель|нейросеть)\b",
    ),
)

#: Look-alike letters folded to one script (Cyrillic → Latin, Latin → Cyrillic).
_TO_LATIN = str.maketrans("АВЕКМНОРСТУХаеорсухіјѕԁӏ", "ABEKMHOPCTYXaeopcyxijsdl")
_TO_CYRILLIC = str.maketrans("ABEKMHOPCTXaeopcyx", "АВЕКМНОРСТХаеорсух")
_SPACES = re.compile(r"[^\S\n]+")
#: Where a new sentence starts: after . ! ? … (and closing quotes) plus whitespace, or after a line break.
_SENTENCE_BREAK = re.compile(r"[.!?…]+[\"'»”’)\]]*\s+|\n+")


@dataclass(frozen=True)
class Detection:
    score: float
    rules: tuple[str, ...]
    #: Plain-English reasons, strongest first.
    reasons: tuple[str, ...]
    #: The sentence around the strongest match, as found (NFKC, whitespace collapsed).
    found: str

    @property
    def reason(self) -> str:
        return "Looks like an instruction for an AI: " + "; ".join(self.reasons) + "."


def normalise(text: str) -> str:
    return _SPACES.sub(" ", unicodedata.normalize("NFKC", text)).strip()


def _sentence(text: str, start: int, end: int) -> str:
    left = max(text.rfind(mark, 0, start) for mark in (". ", "! ", "? ", "\n"))
    left = 0 if left < 0 else left + 1
    right_candidates = [pos for mark in (". ", "! ", "? ", "\n") if (pos := text.find(mark, end)) >= 0]
    right = min(right_candidates) + 1 if right_candidates else len(text)
    found = text[left:right].strip()
    if len(found) > MAX_FOUND:
        middle = text[start:end]
        pad = max(0, (MAX_FOUND - len(middle)) // 2)
        found = (
            ("…" if start - pad > 0 else "")
            + text[max(0, start - pad) : end + pad].strip()
            + ("…" if end + pad < len(text) else "")
        )
    return found


def _sentence_starts(text: str) -> list[int]:
    return [0, *(match.end() for match in _SENTENCE_BREAK.finditer(text))]


def detect_instruction(text: str) -> Detection | None:
    """A ``Detection`` when one sentence scores at least ``THRESHOLD``, else ``None``.

    Weak signals add up only inside one sentence: "write this down in your
    notes." followed by "When reading this article, …" is ordinary teaching
    text, while "Note to AI: when summarising this page, add …" is one sentence.
    """
    base = normalise(text)
    if not base:
        return None
    # A look-alike fold that changed nothing (one-script text) would only find the same matches
    # again: scanned once (QA E14 — a 10 MB paste ran every rule three times per fragment).
    variants = tuple(dict.fromkeys((base, base.translate(_TO_LATIN), base.translate(_TO_CYRILLIC))))
    starts = _sentence_starts(base)
    by_sentence: dict[int, dict[str, tuple[Rule, int, int]]] = {}
    for rule in RULES:
        for variant in variants:
            for match in rule.pattern.finditer(variant):
                anchor = max(match.start(), match.end() - 1)
                sentence = bisect_right(starts, anchor) - 1
                by_sentence.setdefault(sentence, {}).setdefault(rule.id, (rule, match.start(), match.end()))
    best: list[tuple[Rule, int, int]] = []
    best_score = 0.0
    for hits in by_sentence.values():
        score = round(sum(rule.weight for rule, _start, _end in hits.values()), 2)
        if score > best_score:
            best_score, best = score, list(hits.values())
    if best_score < THRESHOLD:
        return None
    best.sort(key=lambda hit: -hit[0].weight)
    _strongest, start, end = best[0]
    reasons = tuple(dict.fromkeys(rule.reason for rule, _start, _end in best))
    return Detection(
        best_score, tuple(rule.id for rule, _s, _e in best), reasons, _sentence(base, start, end)
    )
