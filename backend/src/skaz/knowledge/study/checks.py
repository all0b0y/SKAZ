"""What the agent sends for cards and test questions, checked before anything is shown (S3, S4).

* A right answer is always "from the source": at least one citation whose quote is verbatim in the
  cited fragment (the wiki's layer 4, ``MaterialReader.checked_quote``). A card or question without
  one is dropped with the reason, the rest are kept (S3).
* The agent's explanation and its made-up wrong options are kept apart from the source and labelled.
* Text that reads like instructions to an AI is refused (layer 5); model text is made inert for the
  page format (no wikilinks, no ``%%``, no ``::`` inside a question).
* Short answers are compared by code after normalisation; open answers are judged by the agent (S4).
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import Field

from ..agents.tools import _Args
from ..chats.resolve import MaterialReader
from ..ingest.checks import MIN_QUOTE_CHARS, clean_text, clean_title
from ..ingest.pages import SourceRef
from ..markdown.page import Cite
from ..sources.guard.detector import detect_instruction
from .format import SEPARATOR, QuestionType, StudyBasis

MAX_ITEMS = 60
MAX_TEXT = 1_000
MAX_OPTIONS = 6
MIN_IDEAS = 2
MAX_IDEAS = 6


class CitationIn(_Args):
    material_id: str = Field(min_length=1, max_length=120, description="Material id (mat-…).")
    seg: int = Field(ge=1, le=10_000_000, description="Fragment number (the N in seg-N).")
    quote: str = Field(
        min_length=1,
        max_length=2_000,
        description="The exact words of that fragment the answer rests on, copied verbatim.",
    )


class CardIn(_Args):
    question: str = Field(min_length=1, max_length=MAX_TEXT, description="The front: a question or a term.")
    answer: str = Field(
        min_length=1,
        max_length=MAX_TEXT,
        description="The back: the answer as the source says it, in your words if needed (or from your own "
        "knowledge when the user explicitly asked for it).",
    )
    basis: StudyBasis = Field(
        default="source",
        description="'source' (default): from the user's materials, with verbatim citations; 'agent': from "
        "your own knowledge, only when the user explicitly asked for it in the chat (shown as "
        "'Not based on your materials').",
    )
    citations: list[CitationIn] = Field(
        default_factory=list,
        max_length=4,
        description="Where the answer is in the sources (verbatim quote); required when basis is 'source', "
        "empty when basis is 'agent'.",
    )
    explanation: str | None = Field(
        default=None,
        max_length=MAX_TEXT,
        description="Optional: your own example or mnemonic, shown as 'Agent "
        "explanation', never as the source.",
    )


class IdeaIn(_Args):
    """P3-a decision 7: one key idea of an open question's reference answer, from the source (or agent)."""

    text: str = Field(min_length=1, max_length=300, description="One key idea, a short sentence.")
    citations: list[CitationIn] = Field(
        default_factory=list,
        max_length=2,
        description="Where the source says it (verbatim quote); required when the question's basis is "
        "'source', empty when basis is 'agent'.",
    )


class QuestionIn(_Args):
    type: Literal["choice", "multi", "short", "open"] = Field(
        description="choice: one right option; multi: several right options; short: a word or number; "
        "open: an answer in the user's own words (you will judge it later)."
    )
    question: str = Field(min_length=1, max_length=MAX_TEXT)
    answers: list[str] = Field(
        min_length=1,
        max_length=MAX_OPTIONS,
        description="choice/multi: the right options; short/open: one reference answer. "
        "Every source-backed right answer must be backed by the citations.",
    )
    wrong: list[str] = Field(
        default_factory=list,
        max_length=MAX_OPTIONS,
        description="choice/multi: wrong options you make up (shown as made up by you).",
    )
    accept: list[str] = Field(
        default_factory=list,
        max_length=8,
        description="short: other spellings of the same answer (e.g. '-70', '−70 mV').",
    )
    basis: StudyBasis = Field(
        default="source",
        description="'source' (default): from the user's materials, with verbatim citations; 'agent': from "
        "your own knowledge, only when the user explicitly asked for it in the chat (shown as "
        "'Not based on your materials').",
    )
    citations: list[CitationIn] = Field(
        default_factory=list,
        max_length=4,
        description="Where the right answer is in the sources (verbatim quote); required when basis is "
        "'source', empty when basis is 'agent'.",
    )
    explanation: str | None = Field(default=None, max_length=MAX_TEXT)
    ideas: list[IdeaIn] = Field(
        default_factory=list,
        max_length=MAX_IDEAS,
        description="open: the 2–6 key ideas a full answer covers (each with a verbatim citation when "
        "basis is 'source'). The user's answer is judged against them.",
    )


@dataclass(frozen=True)
class CheckedCard:
    question: str
    answer: str
    cites: tuple[Cite, ...]
    links: tuple[str, ...]
    explanation: str | None
    basis: StudyBasis = "source"


@dataclass(frozen=True)
class CheckedQuestion:
    type: QuestionType
    question: str
    answers: tuple[str, ...]
    wrong: tuple[str, ...]
    accept: tuple[str, ...]
    cites: tuple[Cite, ...]
    links: tuple[str, ...]
    explanation: str | None
    #: An open question's key ideas (P3-a): ``(text, cites)``; empty = built at the first check.
    ideas: tuple[tuple[str, tuple[Cite, ...]], ...] = ()
    basis: StudyBasis = "source"


@dataclass(frozen=True)
class Dropped:
    index: int
    reason: str


class Refused(ValueError):
    """One card or question can't be shown; the reason goes to the agent."""


def _inert(text: str, label: str) -> str:
    cleaned = clean_text(text).replace("%%", "%").replace("[[", "[").replace("]]", "]")
    cleaned = " ".join(cleaned.split())
    if not cleaned:
        raise Refused(f"{label} is empty.")
    if detect_instruction(cleaned) is not None:
        raise Refused(f"{label} reads like instructions to an AI.")
    return cleaned


def clean_study_title(title: str) -> str:
    cleaned = clean_title(title)
    if detect_instruction(cleaned) is not None:
        raise Refused("The title reads like instructions to an AI.")
    return cleaned


def _cites(
    reader: MaterialReader, citations: Sequence[CitationIn]
) -> tuple[tuple[Cite, ...], tuple[str, ...]]:
    cites: list[Cite] = []
    links: list[str] = []
    for citation in citations:
        ref = f"{citation.material_id}:seg-{citation.seg}"
        source = reader.source(citation.material_id)
        if source is None or reader.fragment(citation.material_id, citation.seg) is None:
            raise Refused(f"{ref} is not a fragment SKAZ can cite (unknown or excluded).")
        checked = reader.checked_quote(citation.material_id, citation.seg, citation.quote)
        if checked is None:
            raise Refused(
                f"the quote for {ref} is not verbatim in that fragment (or is shorter than "
                f"{MIN_QUOTE_CHARS} characters)"
            )
        cite = Cite(citation.material_id, citation.seg, checked)
        if cite in cites:
            continue
        cites.append(cite)
        link = SourceRef(
            material_id=citation.material_id,
            folder_name=source.folder_name,
            title=source.title,
            file_stem=source.files.source_path.stem,
            start_ms={f.seg: f.start_ms for f in source.fragments},
            page={f.seg: f.page for f in source.fragments},
        ).link(citation.seg)
        if link not in links:
            links.append(link)
    return tuple(cites), tuple(links)


_QUOTED_SPAN = re.compile(
    r"(?ms:^(?P<fence>`{3,}|~{3,})[^`~\n]*\n.*?(?:^(?P=fence)[`~]*$|\Z))"
    r"|(?m:^>[^\n]*)"
    r'|"[^"\n]*"'
    r"|«[^»\n]*»"
    r"|“[^”\n]*”"
    r"|„[^“”\n]*[“”]"
    r"|‘[^’\n]*’"
    r"|`[^`\n]*`"
    r"|(?<!\w)'[^'\n]*'(?!\w)"
)

_STUDY_WORK_CONTEXT = re.compile(
    r"\b(?:"
    r"flash\s*cards?|cards?|decks?|tests?|quiz(?:zes)?"
    r"|карточ\w*|флешкарт\w*|флэшкарт\w*|колод\w*"
    r"|тест(?:ы|а|ов|у|ом|е|ам|ами|ах)?|квиз\w*|опросни\w*"
    r"|(?:make|create|generate|build|write|prepare|draft|add|include|give\s+me)\b"
    r"[^.!?;:\n]{0,45}\b(?:questions?|study\s+items?|items?)"
    r"|(?:choice|multi|multiple[- ]choice|short(?:-answer)?|open(?:-ended)?"
    r"|test|quiz|exam|study|review|practice)\s+questions?"
    r"|questions?\s+(?:from|out\s+of|using|based\s+on)\b"
    r"|(?:сдела\w*|состав\w*|созда\w*|сгенерир\w*|придума\w*|напиш\w*"
    r"|подготов\w*|добав\w*|включ\w*|дай\w*|давай|дополн\w*)\b"
    r"[^.!?;:\n]{0,45}\b(?:вопрос\w*|задани\w*|пункт\w*)"
    r"|(?:тестов\w+|открыт\w+|закрыт\w+|коротк\w+|учебн\w+"
    r"|экзаменационн\w+|проверочн\w+)\s+(?:вопрос\w*|задани\w*)"
    r"|(?:вопрос\w*|задани\w*)\s+"
    r"(?:из|на\s+основе|на\s+базе|с\s+использованием|с\s+помощью|от\s+себя)\b"
    r")\b",
    re.IGNORECASE,
)

_EN_KNOWLEDGE_NOUN = (
    r"(?:own\s+)?(?:general\s+|background\s+|prior\s+|internal\s+)?knowledge\b"
    r"(?!\s+(?:bases?|graphs?|representations?|distillation|engineering"
    r"|management|transfer|extraction|retrieval|systems?|cut-?offs?)\b)"
)

_EN_AGENT_KNOWLEDGE = (
    r"(?:"
    r"(?:your|(?:the\s+)?(?:agent'?s|assistant'?s|ai'?s|model'?s|llm'?s)|its\s+own)\s+"
    + _EN_KNOWLEDGE_NOUN
    + r"|(?:own|(?:the\s+)?(?:agent|assistant|ai|model|llm))\s+"
    + _EN_KNOWLEDGE_NOUN
    + r")"
)

_RU_AGENT_OWNER = r"(?:самого\s+|самой\s+)?(?:агента|ассистента|помощника|модели|ии|нейросети)"
_RU_KNOWLEDGE_TAIL = (
    r"(?!\s+(?:баз\w*|граф\w*|систем\w*|представлени\w*"
    r"|студент\w*|учени\w*|учащ\w*|пользовател\w*)\b)"
)
_RU_POSSESSIVE = r"(?:сво(?:и|их|им|ими|его|ему)|тво(?:и|их|им|ими|его|ему)|ваш(?:и|их|им|ими|его|ему))"
_RU_OWN = r"собственн(?:ые|ых|ым|ыми|ого|ому)"
_RU_GENERAL = r"общ(?:ие|их|им|ими|его|ему)"

_RU_AGENT_KNOWLEDGE = (
    r"(?:"
    r"(?:" + _RU_POSSESSIVE + r"\s+(?:" + _RU_OWN + r"\s+)?|" + _RU_OWN + r"\s+)"
    r"(?:" + _RU_GENERAL + r"\s+)?знани\w*(?:\s+" + _RU_AGENT_OWNER + r")?"
    r"|(?:" + _RU_POSSESSIVE + r"|" + _RU_OWN + r"|" + _RU_GENERAL + r")?\s*знани\w+\s+"
    + _RU_AGENT_OWNER
    + r")"
    + _RU_KNOWLEDGE_TAIL
)

_EN_DIRECTIVE_PREFIX = (
    r"(?:"
    r"\b(?:you\s+(?:can|may|could|are\s+allowed\s+to|are\s+free\s+to|are\s+welcome\s+to)"
    r"|you're\s+(?:allowed|free|welcome)\s+to"
    r"|(?:can|could|would|will)\s+you(?:\s+please)?"
    r"|feel\s+free\s+to|go\s+ahead\s+and)\s+(?:also\s+|freely\s+|please\s+)*"
    r"|(?:^|(?<=[.!?;:\n])\s*|,\s*(?:and\s+|or\s+|then\s+|so\s+)?|\b(?:and|or|then)\s+)"
    r"(?:please\s+|also\s+|freely\s+|just\s+)*"
    r")"
)

_EN_DIRECTIVE_VERB = (
    r"(?:use|(?:draw|rely|lean)\s+(?:also\s+)?on|include|add|incorporate|bring\s+in"
    r"|supplement(?:\s+\S+){0,4}\s+with|take(?:\s+\S+){0,4}\s+from)"
)

_RU_DIRECTIVE_VERB = (
    r"(?:"
    r"(?:используй(?:те)?|воспользуй(?:ся|тесь)|привлек(?:и|ите|ай|айте)"
    r"|примен(?:и|ите|яй|яйте)|задействуй(?:те)?|включ(?:и|ите|ай|айте)"
    r"|добав(?:ь|ьте|ляй|ляйте)|возьм(?:и|ите)|бери(?:те)?|дополн(?:и|ите|яй|яйте)"
    r"|(?:опирай(?:ся|тесь)|полагай(?:ся|тесь))\s+(?:также\s+|еще\s+)?на)"
    r"|(?:(?:ты\s+|вы\s+)?(?:можешь|можете)|можно|разрешаю)(?!\s+ли)\s+"
    r"(?:также\s+|еще\s+|и\s+|смело\s+|спокойно\s+)?"
    r"(?:использовать|воспользоваться|привлечь|привлекать|применить|применять"
    r"|задействовать|включить|включать|добавить|добавлять|взять|брать"
    r"|дополнить|дополнять|(?:опираться|полагаться)\s+(?:также\s+|еще\s+)?на)"
    r")"
)

_RU_INST_KNOWLEDGE = (
    r"(?:(?:сво(?:ими|им)|тво(?:ими|им)|ваш(?:ими|им))\s+(?:собственн(?:ыми|ым)\s+)?"
    r"|собственн(?:ыми|ым)\s+)(?:общ(?:ими|им)\s+)?знани\w*(?:\s+" + _RU_AGENT_OWNER + r")?"
)

_AGENT_KNOWLEDGE_OPT_IN = re.compile(
    r"(?:(?P<en_directive>"
    + _EN_DIRECTIVE_PREFIX
    + _EN_DIRECTIVE_VERB
    + r"\s+(?:(?:some\s+|a\s+few\s+|more\s+|extra\s+|additional\s+|an?\s+)?"
    + r"(?:open\s+|choice\s+|short\s+)?"
    + r"(?:cards?|flash\s*cards?|questions?|items?|material|facts?|examples?)\s+"
    + r"(?:from|out\s+of|based\s+on|using)\s+)?"
    + _EN_AGENT_KNOWLEDGE
    + r")"
    + r"|\b(?:from|out\s+of|based\s+on|using|by\s+using"
    + r"|(?:by\s+)?(?:drawing|relying|leaning)\s+(?:also\s+)?on)\s+(?:also\s+)?"
    + _EN_AGENT_KNOWLEDGE
    + r"|\b(?:(?:make|create|generate|add|include|write|take|draw|bring\s+in"
    + r"|supplement|go|use|using)\b[^.!?;:\n]{0,45}\b(?:from\s+)?|from\s+)"
    + r"(?:outside|beyond)\s+(?:of\s+)?"
    + r"(?:my\s+|the\s+|our\s+|these\s+|attached\s+|provided\s+)"
    + r"(?:materials?|sources?|lectures?|notes|documents?|textbooks?)\b"
    + r"|(?P<ru_directive>\b"
    + _RU_DIRECTIVE_VERB
    + r"\s+(?:также\s+|еще\s+|и\s+|смело\s+)?"
    + r"(?:(?:пару\s+|несколько\s+|еще\s+|немного\s+)?"
    + r"(?:открыт\w+\s+|тестов\w+\s+)?(?:карточ\w*|вопрос\w*|задани\w*|пункт\w*)\s+"
    + r"(?:из|на\s+основе|с\s+использованием|с\s+помощью)\s+)?"
    + _RU_AGENT_KNOWLEDGE
    + r")"
    + r"|\b(?:из|на\s+основе|на\s+базе|с\s+использованием|с\s+помощью|при\s+помощи"
    + r"|используя|привлекая|применяя|задействуя"
    + r"|(?:опираясь|полагаясь)\s+(?:также\s+|еще\s+)?на)\s+(?:также\s+|еще\s+|и\s+)?"
    + _RU_AGENT_KNOWLEDGE
    + r"|\b(?:(?:дополн(?:и|ите|яй|яйте|ить|ять|ив|яя)|добав(?:ь|ьте|ляй|ляйте|ить|лять|ив|ляя)"
    + r"|расшир(?:ь|ьте|яй|яйте|ить|ять|ив)|воспользуй(?:ся|тесь)|воспользоваться"
    + r"|пользуй(?:ся|тесь)|пользуясь)(?:\s+\S+){0,3}\s+"
    + _RU_INST_KNOWLEDGE
    + r"|"
    + _RU_INST_KNOWLEDGE
    + r"\s+(?:дополн(?:и|ите|ить)|расшир(?:ь|ьте|ить)|воспользуй(?:ся|тесь)))"
    + r"|\b(?:добав(?:ь|ьте|ляй|ляйте|ить|лять|ив)|включ(?:и|ите|ай|айте|ить|ать|ив)"
    + r"|придума(?:й|йте|ть)|состав(?:ь|ьте|ляй|ляйте|ить)|сдела(?:й|йте|ть)"
    + r"|напиш(?:и|ите)|написать|предлож(?:и|ите|ить)|дай(?:те)?|давай"
    + r"|возьм(?:и|ите)|взять|бери(?:те)?|брать|дополн(?:и|ите|ить|яй|яйте))"
    + r"(?:\s+\S+){0,4}\s+(?:от\s+себя|(?:из\s+|что-нибудь\s+|что-то\s+)?"
    + r"(?:вне|за\s+пределами|помимо)\s+"
    + r"(?:моих\s+|наших\s+|этих\s+|приложенн\w+\s+)?"
    + r"(?:материал\w*|источник\w*|лекци\w*|конспект\w*))\b"
    + r")",
    re.IGNORECASE,
)

_DIRECTIVE_PURPOSE = re.compile(r"(?:\s+to|\s*,?\s+чтобы)\s+(?P<work>[^,]+)", re.IGNORECASE)

_SENTENCE_DISQUALIFIER = re.compile(
    r"\b(?:"
    r"not\s+sure|unsure|uncertain|hesitant|whether\s+or\s+not|maybe\s+not|or\s+not"
    r"|don't\s+know\s+(?:if|whether)"
    r"|up\s+to\s+date|up-to-date|how\s+current|how\s+recent|cut-?offs?"
    r"|не\s+уверен\w*|не\s+знаю|сомнева\w*|то\s+ли|или\s+нет"
    r"|стоит\s+ли|нужно\s+ли|надо\s+ли|можно\s+ли|\w+\s+ли"
    r"|насколько\s+(?:актуальн\w*|свеж\w*|нов\w*)|актуальност\w*|до\s+какого\s+года"
    r")\b",
    re.IGNORECASE,
)

_POLITE_REQUEST_SENTENCE = re.compile(
    r"\b(?:(?:can|could|would|will)\s+you|(?:ты\s+|вы\s+)?(?:можешь|можете)(?!\s+ли))\b",
    re.IGNORECASE,
)

_STUDY_REQUEST_START = re.compile(
    r"^(?:(?:and|or|then|and\s+then|и|а|затем|потом|а\s+потом|и\s+потом)\s+)?"
    r"(?:(?:can|could|would|will)\s+you\s+|(?:ты\s+|вы\s+)?(?:можешь|можете)\s+)?"
    r"(?:(?:please|also)\s+|пожалуйста[, ]+)?"
    r"\b(?:make|create|generate|build|write|prepare|draft|add|include|give\s+me"
    r"|сдела\w*|состав\w*|созда\w*|сгенерир\w*|придума\w*|подготов\w*|напиш\w*|написать"
    r"|добав\w*|включ\w*|дай\w*)\b",
    re.IGNORECASE,
)

_ATTRIBUTION = re.compile(
    r"\b(?:examples?|instance|instructions?|prompts?|quotes?|phrases?|wording"
    r"|say(?:s|ing)?|said|wrote|reads?"
    r"|пример\w*|инструкци\w*|промпт\w*|цитат\w*|фраз\w*|формулиров\w*"
    r"|говор\w*|сказа\w*|написа\w*|глас\w*)\b",
    re.IGNORECASE,
)

_PREFIX_QUESTION_OR_NON_AGENT = re.compile(
    r"(?:"
    r"\b(?:how|what|when|where|why|who|whose|which|whether"
    r"|(?:do|does|did|is|are|was|were|have|has|had|should)\s+"
    r"(?:you|your|(?:the\s+)?(?:agent|assistant|ai|model|llm)|it|they|we|i)"
    r"|(?:tell\s+me|wonder|ask(?:ing)?|know|see|check|decide|question)\s+"
    r"(?:if|whether|how|when|why|what|where))\b"
    r"|\b(?:насколько|каков\w*|какой|какая|какое|какие|каким\w*|каких|откуда|почему|зачем"
    r"|когда|где|куда|кто|(?:интересно|спрашива\w*|узнать|понять|проверить|вопрос)\s*,?\s*"
    r"(?:как|почему|зачем|когда|откуда|где|можно|нужно|стоит))\b"
    r"|\b(?:i|we|students?|learners?|pupils?|users?|candidates?|readers?|people"
    r"|я|мы|студент\w*|учени\w*|учащ\w+|пользовател\w*)\s+(?:(?:\S+\s+){0,2})?"
    r"(?:want\s+to|need\s+to|can|could|should|will|would"
    r"|хоч\w+|мог\w+|мож\w+|буд\w+|долж\w+|нужно|надо)?\s*$"
    r"|\b(?:assess(?:ing)?|test(?:ing)?|check(?:ing)?|evaluat(?:e|ing)|measur(?:e|ing)"
    r"|verif(?:y|ying)|examin(?:e|ing)|grad(?:e|ing)|refresh(?:ing)?|review(?:ing)?"
    r"|improv(?:e|ing)|distinguish(?:ing)?|separat(?:e|ing)|differ(?:ing|s)?"
    r"|com(?:e|es|ing)|learn(?:ing|s)?|quot(?:e|ing)|prevent(?:ing)?|stop(?:ping)?"
    r"|refrain(?:ing)?|keep(?:ing)?|apart|aside"
    r"|провер\w*|оцен\w*|протестир\w*|тестир\w*|освеж\w*|закреп\w*|подтян\w*"
    r"|улучш\w*|повтор\w*|систематизир\w*|измер\w*|контрол\w*|отлич\w*)\s+"
    r"(?:(?:a|the|my|our|their|your|student'?s?|students'?|learner'?s?|learners'?)\s+)?$"
    r")",
    re.IGNORECASE,
)

_TOPIC_IMMEDIATE_PREFIX = re.compile(
    r"\b(?:"
    r"about|on|regarding|concerning|whose\s+topic\s+is|titled|entitled|called|named"
    r"|topic(?:\s+is|\s+of)?|theme(?:\s+is|\s+of)?|subject(?:\s+is|\s+of)?"
    r"|definition\s+of|concept\s+of|meaning\s+of|difference\s+between|distinction\s+between"
    r"|for\s+example|for\s+instance|e\.g\.|such\s+as|like\s+saying"
    r"|phrase|prompt|instruction|quote|example(?:\s+of)?"
    r"|про|о|об|о\s+том(?:\s*,\s*(?:как|что|когда|почему|зачем))?"
    r"|про\s+то(?:\s*,\s*(?:как|что|когда|почему|зачем))?"
    r"|на\s+тему|по\s+теме|тем(?:а|ой|у|ы)(?:\s+котор\w+)?|поняти\w+|определени\w+|смысл\w*"
    r"|разниц\w+\s+между|отличи\w+\s+между|различи\w+\s+между"
    r"|например|к\s+примеру|скажем|вроде\s+фразы|типа\s+фразы"
    r"|фраз\w+|инструкци\w+|промпт\w*|цитат\w*|приме\w+"
    r")\s*[:—-]?\s*(?:(?:cards?|flash\s*cards?|questions?|items?|facts?|answers?"
    r"|claims?|statements?|examples?|material|information|knowledge"
    r"|карточ\w*|вопрос\w*|пункт\w*|факт\w*|ответ\w*"
    r"|утверждени\w*|приме\w*|информаци\w*|знани\w*)\s+)?$",
    re.IGNORECASE,
)

_TOPIC_CLAUSE_PREFIX = re.compile(
    r"\b(?:about|on|regarding|concerning|whose\s+topic\s+is|про|о|об|на\s+тему|по\s+теме|тем(?:а|ой|у|ы))\b"
    r"(?![^.!?;:\n]*\b(?:and|or|и|а|также)\s+(?:please\s+|also\s+)?"
    r"(?:make|create|generate|add|include|use|draw\s+on|rely\s+on"
    r"|сдела\w*|состав\w*|добав\w*|включ\w*|используй\w*|привлек\w*|дополн\w*|можешь|можете)\b)"
    r"[^.!?;:\n]*\b(?:how|whether|if|when|where|why|what|which|that|who"
    r"|difference\s+between|distinction\s+between|comparison\s+of|vs\.?|versus"
    r"|как|когда|где|куда|откуда|почему|зачем|что|котор\w*"
    r"|разниц\w+|отличи\w+|различи\w+|сравнени\w+)\b",
    re.IGNORECASE,
)

_SENTENCE_AFFIRMATIVE_DIRECTIVE = re.compile(
    r"\b(?:"
    r"make|create|generate|build|write|prepare|draft|add|include|incorporate|use|using"
    r"|(?:draw(?:ing)?|rely(?:ing)?|lean(?:ing)?)\s+(?:also\s+)?on|supplement|take|bring\s+in"
    r"|give\s+me|plus\s+(?:a\s+few|some|\d+|extra|more)|also\s+(?:cards?|flash\s*cards?|questions?)"
    r"|сдела(?:й|йте|ть)|состав(?:ь|ьте|ить|ляй|ляйте)|созда(?:й|йте|ть)"
    r"|сгенериру(?:й|йте)|сгенерировать|придума(?:й|йте|ть)|напиш(?:и|ите)|написать"
    r"|подготов(?:ь|ьте|ить)|добав(?:ь|ьте|ляй|ляйте|ить|лять|ив|ляя)"
    r"|включ(?:и|ите|ай|айте|ить|ать|ив|ая)|используй(?:те)?|использовать|используя"
    r"|воспользуй(?:ся|тесь)|воспользоваться|привлек(?:и|ите|ай|айте|ая)|привлечь"
    r"|примен(?:и|ите|яй|яйте|ить|яя)|задействуй(?:те)?|задействовать"
    r"|возьм(?:и|ите)|взять|бери(?:те)?|брать|дополн(?:и|ите|яй|яйте|ить|ять|ив|яя)"
    r"|(?:опирай(?:ся|тесь)|опираться|опираясь|полагай(?:ся|тесь)|полагаться|полагаясь)"
    r"\s+(?:также\s+|еще\s+)?на|дай(?:те)?|давай"
    r"|плюс\s+(?:еще\s+|пару\s+|пара\s+|несколько\s+|\d+\s+)?(?:карточ\w*|вопрос\w*)"
    r")\b",
    re.IGNORECASE,
)

_EN_NEG_TARGET = (
    r"(?:(?:your|agent'?s?|assistant'?s?|ai'?s?|model'?s?|llm'?s?)\s+(?:own\s+)?"
    r"|own\s+|general\s+|external\s+|outside\s+)knowledge"
)
_RU_NEG_TARGET = (
    r"(?:(?:" + _RU_POSSESSIVE + r"|" + _RU_OWN + r"|" + _RU_GENERAL + r"|внешн(?:их|ие))\s+"
    r"(?:собственн\w+\s+)?знани\w*|знани\w+\s+" + _RU_AGENT_OWNER + r")"
)

_AGENT_KNOWLEDGE_NEGATION = re.compile(
    r"\b(?:"
    r"(?:do\s+not|don't|must\s+not|mustn't|should\s+not|shouldn't|cannot|can't"
    r"|never|avoid|exclude|forbid|skip|ignore|omit|drop|leave\s+out)\s+"
    r"(?:use|using|include|including|add|adding|make|making|create|creating"
    r"|draw\s+on|rely\s+on|take|taking|generate|generating|supplement\s+with|go)?\b"
    r"[^.!?;,\n]{0,45}\b" + _EN_NEG_TARGET
    + r"|(?:not|no|never|without|neither|nor|nothing|none)\b"
    r"(?:\s+(?:cards?|questions?|items?|anything|something|from|using|with|based\s+on|in|of)){0,4}\s+"
    r"(?:the\s+)?" + _EN_NEG_TARGET
    + r"|(?:do\s+not|don't|must\s+not|mustn't|should\s+not|shouldn't|cannot|can't"
    r"|never|not|no|without|nothing|none|avoid)\b[^.!?;,\n]{0,40}\b"
    r"(?:outside|beyond)\s+(?:of\s+)?(?:my\s+|the\s+|our\s+|these\s+|attached\s+|provided\s+)?"
    r"(?:materials?|sources?|lectures?|notes|documents?|textbooks?)"
    r"|" + _EN_NEG_TARGET + r"\b[^.!?;,\n]{0,40}\b"
    r"(?:(?:is|are|must|should|can|may|do)\s+not|isn't|aren't|mustn't|shouldn't|cannot|can't|don't)\s+"
    r"(?:be\s+)?(?:use[d]?|using|include[d]?|including|add(?:ed)?|adding"
    r"|allow(?:ed)?|permit(?:ted)?|want(?:ed)?|need(?:ed)?)"
    r"|" + _EN_NEG_TARGET + r"\b[^.!?;,\n]{0,30}\b(?:forbidden|prohibited|disallowed|excluded)"
    r"|(?<!\bnot\s)(?:only|strictly|exclusively|solely)\s+(?:from|based\s+on|using|in)\s+"
    r"(?:my\s+|the\s+|our\s+|these\s+|attached\s+|provided\s+)?"
    r"(?:materials?|sources?|lectures?|notes|documents?|textbooks?|wiki|pages?)"
    r"|(?<!\bnot\s)(?:from|based\s+on|using)\s+"
    r"(?:my\s+|the\s+|our\s+|these\s+|attached\s+|provided\s+)?"
    r"(?:materials?|sources?|lectures?|notes|documents?|textbooks?)\s+(?:only|alone|exclusively)"
    r"|(?:(?:не|не\s+надо|не\s+нужно|не\s+следует|не\s+должн\w*|нельзя)\s+"
    r"(?:используй\w*|использовать|добавляй\w*|добавлять|включай\w*|включать|бери\w*|брать"
    r"|делай\w*|делать|составляй\w*|составлять|придумывай\w*|придумывать"
    r"|привлекай\w*|привлекать|опирайся|опираться|выходи\w*|выходить|пропуска\w*|отключа\w*)"
    r"|не\s+надо|не\s+нужно|нельзя|запрещ\w*|исключ\w*|отключ\w*|убер\w*|убира\w*)\b"
    r"[^.!?;,\n]{0,45}\b(?:" + _RU_NEG_TARGET + r"|от\s+себя)"
    r"|(?:не|ни|без|никак(?:их|ого)|ничего|ни\s+одн\w+)\b"
    r"(?:\s+(?:карточ\w*|вопрос\w*|пункт\w*|ничего|из|по|на\s+основе|с\s+использованием|с\s+помощью|от)){0,4}\s+"
    r"(?:" + _RU_NEG_TARGET + r"|себя)"
    r"|(?:не|не\s+надо|не\s+нужно|не\s+следует|нельзя|ни|без|никак(?:их|ого)|ничего)\b"
    r"[^.!?;,\n]{0,40}\b(?:вне|за\s+пределами|за\s+пределы|помимо)\s+"
    r"(?:моих\s+|наших\s+|этих\s+|приложенн\w+\s+)?"
    r"(?:материал\w*|источник\w*|лекци\w*|конспект\w*)"
    r"|" + _RU_NEG_TARGET + r"\b[^.!?;,\n]{0,40}\b"
    r"(?:(?:не|не\s+надо|не\s+нужно|нельзя)\s*(?:используй\w*|использовать|добавляй\w*|добавлять"
    r"|включай\w*|включать|бери\w*|брать|делай\w*|делать|придумывай\w*|придумывать"
    r"|привлекай\w*|привлекать)|не\s+нужн\w*|не\s+надо|нельзя|запрещ\w*|исключ\w*)"
    r"|(?<!\bне\s)(?:только|строго|исключительно)\s+(?:по|из|на\s+основе)\s+"
    r"(?:моим\s+|моих\s+|нашим\s+|наших\s+|этим\s+|этих\s+|приложенн\w+\s+)?"
    r"(?:материал\w*|источник\w*|лекци\w*|конспект\w*|учебник\w*|документ\w*|страниц\w*|вики)"
    r"|(?:ничего|ни\s+одн\w+\s+\w+)\s+кроме\s+(?:моих\s+|наших\s+|этих\s+)?"
    r"(?:материал\w*|источник\w*|лекци\w*|конспект\w*)"
    r"|(?:без|никак(?:ой|их))\s+отсебятин\w*"
    r")\b",
    re.IGNORECASE,
)

_NOT_STRICTLY_MATERIALS = re.compile(
    r"\b(?:"
    r"(?:do\s+not|don't|not|never)\b[^.!?;,\n]{0,25}\b"
    r"(?:only|strictly|exclusively|solely)\s+(?:from|based\s+on|using|in)"
    r"|(?:не|не\s+надо|не\s+нужно)\b[^.!?;,\n]{0,25}\b"
    r"(?:только|строго|исключительно)\s+(?:по|из|на\s+основе)"
    r")\b",
    re.IGNORECASE,
)


def _clause_is_affirmative_opt_in(sentence: str, match: re.Match[str]) -> bool:
    if _SENTENCE_DISQUALIFIER.search(sentence) is not None:
        return False
    if _SENTENCE_AFFIRMATIVE_DIRECTIVE.search(sentence) is None:
        return False
    if (match["en_directive"] or match["ru_directive"]) and not _STUDY_WORK_CONTEXT.search(match[0]):
        # A directive to use knowledge for another task does not grant it for nearby Study work.
        purpose = _DIRECTIVE_PURPOSE.match(sentence, match.end())
        if purpose and not _STUDY_WORK_CONTEXT.search(purpose["work"]):
            return False

    # The directive pattern can consume the delimiter before the words that grant permission.
    prefix = sentence[: match.end() - len(match[0].lstrip(" ,:\t"))]
    local_prefix = prefix.rsplit(",", 1)[-1]
    direct_study_request = bool(_STUDY_REQUEST_START.match(prefix) and _STUDY_WORK_CONTEXT.search(prefix))
    if ":" in prefix:
        heading, local_prefix = prefix.rsplit(":", 1)
        if not direct_study_request or _ATTRIBUTION.search(heading):
            return False
    else:
        # A comma can also introduce reported speech, so inspect its lead-in before a detached match.
        lead_in = prefix.rstrip(" ,\t").rsplit(",", 1)[-1].lstrip()
        if _ATTRIBUTION.search(lead_in) and not _STUDY_REQUEST_START.match(lead_in):
            return False
    if _STUDY_REQUEST_START.match(local_prefix.lstrip()) and not _STUDY_WORK_CONTEXT.search(local_prefix):
        return False
    if sentence.rstrip().endswith("?") and (
        _POLITE_REQUEST_SENTENCE.match(sentence) is None
        or (not direct_study_request and match.start() != 0)
    ):
        return False
    if _PREFIX_QUESTION_OR_NON_AGENT.search(local_prefix) or _TOPIC_IMMEDIATE_PREFIX.search(local_prefix):
        return False
    # A detached basis phrase can modify the main Study request after an embedded topic clause.
    # Within the topic itself, the same words could describe how someone else does the work.
    if not local_prefix.strip() and prefix.rstrip().endswith(",") and direct_study_request:
        return True
    return _TOPIC_CLAUSE_PREFIX.search(prefix) is None


def allows_agent_knowledge(request_text: str | None) -> bool:
    """Whether the user's request in the current chat turn explicitly asks for cards or questions from the
    agent's own knowledge (0.4.1 #12) without negating it."""
    if not request_text:
        return False
    normalized = unicodedata.normalize("NFKC", request_text).replace("ё", "е").replace("Ё", "Е")
    normalized = re.sub(r"(?<=\w)[’ʼ](?=\w|\s)", "'", normalized)
    cleaned = "\n".join(" ".join(line.split()) for line in normalized.splitlines() if line.strip())
    if not cleaned:
        return False
    scrubbed = _NOT_STRICTLY_MATERIALS.sub(" ", cleaned)
    if _AGENT_KNOWLEDGE_NEGATION.search(scrubbed) is not None:
        return False
    unquoted = re.sub(r":\n+", ": ", _QUOTED_SPAN.sub(" ; ", cleaned))
    unquoted_scrubbed = _NOT_STRICTLY_MATERIALS.sub(" ", unquoted)
    if _AGENT_KNOWLEDGE_NEGATION.search(unquoted_scrubbed) is not None:
        return False
    if _STUDY_WORK_CONTEXT.search(unquoted) is None:
        return False
    for sentence in re.findall(r"[^.!?\n;]+[.!?\n;]?", unquoted):
        chunk = sentence.strip()
        if not chunk:
            continue
        for match in _AGENT_KNOWLEDGE_OPT_IN.finditer(chunk):
            if _clause_is_affirmative_opt_in(chunk, match):
                return True
    return False


def _cites_for_basis(
    reader: MaterialReader,
    citations: Sequence[CitationIn],
    basis: StudyBasis,
    what: str,
    *,
    allow_agent: bool = False,
) -> tuple[tuple[Cite, ...], tuple[str, ...]]:
    if basis == "agent":
        if not allow_agent:
            raise Refused(
                f"a {what} from your own knowledge (basis 'agent') is only allowed when the user explicitly "
                "asks for it in this chat turn"
            )
        if citations:
            raise Refused(f"a {what} from your own knowledge (basis 'agent') must not cite source fragments")
        return (), ()
    if not citations:
        raise Refused(f"a source-backed {what} needs a citation with a verbatim quote")
    return _cites(reader, citations)


def check_card(reader: MaterialReader, card: CardIn, *, allow_agent: bool = False) -> CheckedCard:
    question = _inert(card.question, "The question").replace(SEPARATOR, ":")
    answer = _inert(card.answer, "The answer").replace(SEPARATOR, ":")
    cites, links = _cites_for_basis(reader, card.citations, card.basis, "card", allow_agent=allow_agent)
    explanation = (
        _inert(card.explanation, "The explanation") if card.explanation and card.explanation.strip() else None
    )
    return CheckedCard(question, answer, cites, links, explanation, basis=card.basis)


def check_question(reader: MaterialReader, item: QuestionIn, *, allow_agent: bool = False) -> CheckedQuestion:
    question = _inert(item.question, "The question").replace(SEPARATOR, ":")
    answers = tuple(dict.fromkeys(_inert(a, "An answer").replace(SEPARATOR, ":") for a in item.answers))
    wrong = tuple(dict.fromkeys(_inert(w, "A wrong option") for w in item.wrong))
    if item.type in ("choice", "multi"):
        if not wrong:
            raise Refused("a choice question needs wrong options to choose from")
        if item.type == "choice" and len(answers) != 1:
            raise Refused("a choice question has exactly one right option (use multi for several)")
        if set(map(normalize_answer, answers)) & set(map(normalize_answer, wrong)):
            raise Refused("a wrong option is the same as a right one")
    else:
        answers = answers[:1]
        wrong = ()
    accept = (
        tuple(dict.fromkeys(_inert(a, "An accepted answer") for a in item.accept))
        if item.type == "short"
        else ()
    )
    cites, links = _cites_for_basis(reader, item.citations, item.basis, "question", allow_agent=allow_agent)
    explanation = (
        _inert(item.explanation, "The explanation") if item.explanation and item.explanation.strip() else None
    )
    ideas = _ideas(reader, item.ideas, item.basis, allow_agent=allow_agent) if item.type == "open" else ()
    return CheckedQuestion(
        item.type, question, answers, wrong, accept, cites, links, explanation, ideas, basis=item.basis
    )


def _ideas(
    reader: MaterialReader,
    ideas: Sequence[IdeaIn],
    basis: StudyBasis = "source",
    *,
    allow_agent: bool = False,
) -> tuple[tuple[str, tuple[Cite, ...]], ...]:
    """The key ideas whose quotes check out; fewer than ``MIN_IDEAS`` = none (built at the first check)."""
    kept: list[tuple[str, tuple[Cite, ...]]] = []
    for idea in ideas:
        try:
            text = _inert(idea.text, "A key idea")
            cites, _links = _cites_for_basis(
                reader, idea.citations, basis, "key idea", allow_agent=allow_agent
            )
        except Refused:
            continue
        kept.append((text, cites))
    return tuple(kept[:MAX_IDEAS]) if len(kept) >= MIN_IDEAS else ()


def check_all(items: Sequence[Any], check: Any) -> tuple[list[Any], list[Dropped]]:
    """Every item checked; refused ones are dropped with their 1-based number and reason."""
    kept: list[Any] = []
    dropped: list[Dropped] = []
    for number, item in enumerate(items, start=1):
        try:
            kept.append(check(item))
        except Refused as error:
            dropped.append(Dropped(number, str(error)))
    return kept, dropped


# -- short answers -----------------------------------------------------------------------------

_DASHES = dict.fromkeys(map(ord, "−‒–—‐‑"), "-")
_NUMBER = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


def normalize_answer(text: str) -> str:
    """Case, width, dashes, spaces and trailing punctuation don't matter (S4)."""
    folded = unicodedata.normalize("NFKC", text).translate(_DASHES).casefold()
    folded = re.sub(r"\s+", " ", folded).strip()
    return folded.strip(" .,;:!?\"'«»“”()[]")


def _numbers(text: str) -> list[float]:
    return [float(match.replace(",", ".")) for match in _NUMBER.findall(text)]


def short_matches(given: str, answers: Sequence[str]) -> bool:
    """The typed answer equals an accepted one; or, for a number, the same number (units may be left out)."""
    typed = normalize_answer(given)
    if not typed:
        return False
    for answer in answers:
        expected = normalize_answer(answer)
        if typed == expected:
            return True
        typed_numbers, expected_numbers = _numbers(typed), _numbers(expected)
        if len(typed_numbers) == 1 and typed_numbers == expected_numbers:
            words = set(_NUMBER.sub(" ", typed).split())
            if words <= set(_NUMBER.sub(" ", expected).split()):
                return True
    return False
