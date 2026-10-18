"""``/kb/study``: decks and tests in chats, FSRS grades, test answers, saving, deck pages (0.3.1 S)."""
from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, HTTPException, Request

from ...native_io import disk_call
from ..chats.service import ChatService
from ..errors import KnowledgeError
from ..markdown.page import Cite
from ..study.service import StudyService
from ..study.store import StudyBlock
from .schemas import KbCitation
from .schemas_study import (
    KbDeckStudy,
    KbDeckStudyResult,
    KbDeckView,
    KbStudyAnswerIn,
    KbStudyCard,
    KbStudyGradeIn,
    KbStudyGroups,
    KbStudyIntervals,
    KbStudyMarkIn,
    KbStudyMove,
    KbStudyOption,
    KbStudyPart,
    KbStudyQuestion,
    KbStudyResponse,
    KbStudyResult,
    KbStudyResultRow,
    KbStudyRetake,
    KbStudySave,
    KbStudySaveIn,
    KbStudySettings,
    KbStudySettingsPatch,
)

router = APIRouter(prefix="/kb/study", tags=["kb"])


async def get_study(request: Request) -> StudyService:
    study = cast(StudyService, request.app.state.runtime.kb_study)
    study.remember_loop()  # an async dependency runs on the loop; the work then goes to a thread
    return study


def get_chats(request: Request) -> ChatService:
    return cast(ChatService, request.app.state.runtime.kb_chats)


StudyDep = Annotated[StudyService, Depends(get_study)]
ChatsDep = Annotated[ChatService, Depends(get_chats)]
CitationFn = Callable[[str, int, str | None], KbCitation]


def _http(error: KnowledgeError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.message)


def _card(row: dict[str, Any], citation: CitationFn) -> KbStudyCard:
    intervals = row["intervals"]
    return KbStudyCard(
        id=row["id"], page_id=row["page_id"], question=row["question"], answer=row["answer"],
        citations=[citation(cite.material_id, cite.seg, cite.quote)
                   for cite in cast(tuple[Cite, ...], row["cites"])],
        explanation=row["explanation"], group=row["group"], state=row["state"], suspended=row["suspended"],
        marked_hard=row["marked_hard"], intervals=KbStudyIntervals(**intervals), graded=row["graded"],
        due=row["due"],
    )


def _option(option: dict[str, str]) -> KbStudyOption:
    return KbStudyOption(id=option["id"], text=option["text"],
                         origin="agent" if option["origin"] == "agent" else "source")


def study_part(study: StudyService, block: StudyBlock, citation: CitationFn) -> KbStudyPart:
    """What the block shows now (cards re-read from the deck page, states from the database)."""
    cards: list[KbStudyCard] = []
    questions: list[KbStudyQuestion] = []
    held_back = int(block.payload.get("held_back") or 0)
    if block.kind == "deck":
        rows = study.card_view(block)
        cards = [_card(row, citation) for row in rows]
        groups = study.groups(rows)
        total = len(cards)
    else:
        attempt = study.attempt(block)
        items = (attempt.answers.get("items") if attempt else None) or {}
        by_id = {q.id: q for q in study.questions(block)}
        order = [item_id for item_id in study._test_order(block) if item_id in by_id]
        for item_id in order:
            question = by_id[item_id]
            given = items.get(item_id)
            response = KbStudyResponse(
                choices=list(given.get("choices") or []), text=given.get("text"),
                checked=bool(given.get("checked")),
                score=given.get("score"), verdict=given.get("verdict"), missing=given.get("missing"),
                comment=given.get("comment"), checking=bool(given.get("checking")), error=given.get("error"),
            ) if given else None
            questions.append(KbStudyQuestion(
                id=question.id, type=question.type, question=question.question,
                options=[_option(option) for option in study.options(block, question)],
                answers=list(question.answers),
                citations=[citation(c.material_id, c.seg, c.quote) for c in question.cites],
                explanation=question.explanation, response=response))
        groups = {"new": 0, "learning": 0, "known": 0, "hard": 0}
        total = len(questions)
    result = study.result(block) if block.kind == "test" else None
    return KbStudyPart(
        type="study", id=block.id, kind=block.kind, title=block.title, engine=block.engine,
        origin=block.origin,
        mode=block.mode if block.mode in ("due", "new", "hard", "quick10", "all") else "due",  # type: ignore[arg-type]
        place=block.place, position=min(block.position, total), side=block.side, total=total, cards=cards,
        questions=questions, groups=KbStudyGroups(**groups), held_back=held_back,
        save=KbStudySave(status=block.save_status, path=study.proposed_path(block), page_id=block.page_id),
        result=KbStudyResult(correct=result["correct"], total=result["total"], mistakes=result["mistakes"],
                             partly=result["partly"],
                             rows=[KbStudyResultRow(**row) for row in result["rows"]]) if result else None,
        chat_id=block.chat_id, message_id=block.message_id,
    )


def _presenter(request: Request) -> CitationFn:
    from .chats import Presenter

    return Presenter(request.app.state.runtime.kb).citation


async def _view(study: StudyService, request: Request, block: StudyBlock) -> KbStudyPart:
    citation = _presenter(request)
    return await disk_call(study_part, study, block, citation)


@router.get("/settings")
async def read_study_settings(study: StudyDep) -> KbStudySettings:
    return KbStudySettings(new_per_day=await disk_call(study.new_per_day))


@router.patch("/settings")
async def change_study_settings(body: KbStudySettingsPatch, study: StudyDep) -> KbStudySettings:
    try:
        return KbStudySettings(new_per_day=await disk_call(study.set_new_per_day, body.new_per_day))
    except KnowledgeError as error:
        raise _http(error) from error


@router.get("/decks/{page_id}")
async def read_deck(page_id: str, study: StudyDep, request: Request) -> KbDeckView:
    try:
        deck = await disk_call(study.deck, page_id)
    except KnowledgeError as error:
        raise _http(error) from error
    citation = _presenter(request)
    cards = await disk_call(lambda: [_card(row, citation) for row in deck["cards"]])
    return KbDeckView(page_id=deck["page_id"], title=deck["title"], cards=cards,
                      groups=KbStudyGroups(**deck["groups"]), due=deck["due"])


@router.post("/decks/{page_id}/marks")
async def mark_deck_cards(page_id: str, body: KbStudyMarkIn, study: StudyDep, request: Request) -> KbDeckView:
    try:
        await disk_call(study.mark, None, body.item_ids, body.mark, page_id=page_id)
    except KnowledgeError as error:
        raise _http(error) from error
    return await read_deck(page_id, study, request)


@router.post("/decks/{page_id}/study")
async def study_deck(page_id: str, body: KbDeckStudy, study: StudyDep, chats: ChatsDep,
                     request: Request) -> KbDeckStudyResult:
    """"Study" on the deck page (S12, W1): a block in the chat (or a new chat) opened beside the chat."""
    try:
        chat_id, block = await chats.study_from_deck(study, page_id, body.mode, body.card_ids, body.chat_id)
        block = await disk_call(study.move, block.id, place="panel")
    except KnowledgeError as error:
        raise _http(error) from error
    return KbDeckStudyResult(chat_id=chat_id, study=await _view(study, request, block))


@router.get("/{block_id}")
async def read_block(block_id: str, study: StudyDep, request: Request) -> KbStudyPart:
    try:
        block = await disk_call(study.get, block_id)
    except KnowledgeError as error:
        raise _http(error) from error
    return await _view(study, request, block)


async def _act(request: Request, study: StudyService, call: Callable[[], StudyBlock]) -> KbStudyPart:
    try:
        block = await disk_call(call)
    except KnowledgeError as error:
        raise _http(error) from error
    return await _view(study, request, block)


@router.patch("/{block_id}")
async def move_block(block_id: str, body: KbStudyMove, study: StudyDep, request: Request) -> KbStudyPart:
    return await _act(request, study, lambda: study.move(block_id, place=body.place, position=body.position,
                                                         side=body.side))


@router.post("/{block_id}/grade")
async def grade_card(block_id: str, body: KbStudyGradeIn, study: StudyDep, request: Request) -> KbStudyPart:
    return await _act(request, study, lambda: study.grade(block_id, body.item_id, body.grade))


@router.post("/{block_id}/mark")
async def mark_cards(block_id: str, body: KbStudyMarkIn, study: StudyDep, request: Request) -> KbStudyPart:
    def run() -> StudyBlock:
        study.mark(block_id, body.item_ids, body.mark)
        return study.get(block_id)

    return await _act(request, study, run)


@router.post("/{block_id}/answer")
async def answer_question(block_id: str, body: KbStudyAnswerIn, study: StudyDep,
                          request: Request) -> KbStudyPart:
    return await _act(request, study, lambda: study.answer(block_id, body.item_id, choices=body.choices,
                                                           text=body.text))


@router.post("/{block_id}/check-open")
async def check_open_answer(block_id: str, body: KbStudyAnswerIn, study: StudyDep,
                            request: Request) -> KbStudyPart:
    try:
        block = await study.check_open(block_id, body.item_id, body.text or "")
    except KnowledgeError as error:
        raise _http(error) from error
    return await _view(study, request, block)


@router.post("/{block_id}/finish")
async def finish_test(block_id: str, study: StudyDep, request: Request) -> KbStudyPart:
    return await _act(request, study, lambda: study.finish(block_id))


@router.post("/{block_id}/retake")
async def retake_test(block_id: str, body: KbStudyRetake, study: StudyDep, request: Request) -> KbStudyPart:
    return await _act(request, study, lambda: study.retake(block_id, mistakes_only=body.mistakes_only))


@router.post("/{block_id}/save")
async def save_block(block_id: str, body: KbStudySaveIn, study: StudyDep, request: Request) -> KbStudyPart:
    return await _act(request, study, lambda: study.save(block_id, body.decision))
