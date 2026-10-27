"""P3-a: the review of an open answer — key ideas kept on the question, SKAZ's own score, checked quotes,
«I did say this» and «counted by you».

The judge is a fake at the agent seam (``StudyService.judge``): these tests prove SKAZ's side — what is
asked, what is kept, what is dropped and how the score is counted — never the quality of a model.
"""
from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

import httpx
import pytest

from skaz.knowledge.errors import KnowledgeError
from skaz.knowledge.study.review import JudgeCall, is_mistake, share_of, status_of
from tests.knowledge.test_s_study import ENTROPY, _cite, _questions, _tool, world  # noqa: F401

GROWS = "она растёт в изолированной системе"
SUMMARY = "энтропия и необратимость связаны"


def _open_with_ideas(library: Any) -> dict[str, Any]:
    return {
        "type": "open",
        "question": "Что такое энтропия и как она меняется?",
        "answers": ["Мера беспорядка; растёт в изолированной системе."],
        "citations": [_cite(library, 1, ENTROPY)],
        "ideas": [
            {"text": "Энтропия — мера беспорядка.", "citations": [_cite(library, 1, ENTROPY)]},
            {"text": "В изолированной системе она растёт.", "citations": [_cite(library, 1, GROWS)]},
            {"text": "Она связана с необратимостью.", "citations": [_cite(library, 3, SUMMARY)]},
            {"text": "Выдумка без цитаты.", "citations": [_cite(library, 1, "этого нет в лекции вообще")]},
        ],
    }


async def _made(runtime: Any, library: Any, question: dict[str, Any]) -> tuple[Any, str]:
    made = await _tool(runtime, "skaz_study_make_test", {"title": "Энтропия", "questions": [question]})
    block = runtime.kb_study.get(made["study_id"])
    return block, runtime.kb_study.questions(block)[0].id


class FakeJudge:
    """Answers each call with the next scripted JSON; remembers what SKAZ asked."""

    def __init__(self, *answers: Mapping[str, Any]) -> None:
        self.answers = list(answers)
        self.calls: list[JudgeCall] = []

    async def __call__(self, call: JudgeCall) -> Mapping[str, Any]:
        self.calls.append(call)
        return {**self.answers.pop(0), "checked_by": "Codex · Test"}


def _point(idea: int, status: str, **extra: Any) -> dict[str, Any]:
    empty = {"yours": "", "why": "", "basis": "agent", "source": 0, "quote": ""}
    return {"idea": idea, "status": status, **empty, **extra}


REVIEW = {
    "ideas": [],
    "points": [
        _point(1, "covered"),
        # «why» from the source with a quote that checks out (fragment 1 of the prompt)
        _point(2, "partial", yours="она растёт", why="Так устроена изолированная система.", basis="source",
               source=1, quote=GROWS),
        # a «source» note whose quote isn't in the fragment is the agent's own knowledge
        _point(3, "missing", yours="этого не было в ответе", why="Это объясняет стрелу времени.",
               basis="source", source=1, quote="стрела времени необратима всегда"),
    ],
    "model_answer": [
        {"text": "Энтропия — мера беспорядка, она растёт.", "from": "user", "idea": 0},
        {"text": "Рост энтропии связан с необратимостью.", "from": "added", "idea": 3},
        {"text": "А ещё она пахнет розами.", "from": "added", "idea": 0},
    ],
    "also_right": [
        {"text": "Беспорядок системы — то же, что хаос молекул.", "basis": "agent", "source": 0, "quote": ""},
        {"text": "Это мера беспорядка системы.", "basis": "source", "source": 1, "quote": ENTROPY},
    ],
    # the model may say anything about a score: SKAZ never reads it
    "comment": "Хорошее начало: беспорядок назван верно. Добавьте про необратимость.",
    "score": 1.0,
    "verdict": "right",
}
ANSWER = "Энтропия — это мера беспорядка, и она растёт со временем."


async def test_key_ideas_are_made_with_the_test_and_kept_on_the_question(world: Any) -> None:  # noqa: F811
    runtime, library, _ref = world
    block, item_id = await _made(runtime, library, _open_with_ideas(library))
    ideas = runtime.kb_study.ideas(item_id)
    # the idea without a verbatim quote is dropped; the rest keep their checked citations
    assert [idea["text"] for idea in ideas] == [
        "Энтропия — мера беспорядка.", "В изолированной системе она растёт.", "Она связана с необратимостью."]
    assert ideas[1]["cites"][0]["quote"] == GROWS
    # a saved test keeps the same ideas: they live on the item, keyed by its block id
    saved = await asyncio.to_thread(runtime.kb_study.save, block.id, "allow")
    assert runtime.kb_study.items.one(item_id).page_id == saved.page_id
    assert runtime.kb_study.ideas(item_id) == ideas


async def test_fewer_than_two_checked_ideas_are_built_at_the_first_check_instead(world: Any) -> None:  # noqa: F811
    runtime, library, _ref = world
    question = _open_with_ideas(library)
    question["ideas"] = question["ideas"][:1]
    _block, item_id = await _made(runtime, library, question)
    assert runtime.kb_study.ideas(item_id) is None


async def test_skaz_counts_the_score_from_the_checklist_and_keeps_only_checked_quotes(
    world: Any,  # noqa: F811
) -> None:
    runtime, library, _ref = world
    study = runtime.kb_study
    block, item_id = await _made(runtime, library, _open_with_ideas(library))
    judge = FakeJudge(REVIEW)
    study.judge = judge
    await study.check_open(block.id, item_id, ANSWER)
    await study.settle()

    (call,) = judge.calls
    assert call.kind == "check" and "<untrusted-data" in call.data and ANSWER in call.data
    assert "1. Энтропия — мера беспорядка." in call.data and "No key ideas" not in call.instructions
    assert "never write \"wrong\"" in call.instructions.replace("Never", "never")

    entry = study.attempt(study.get(block.id)).answers["items"][item_id]
    # (1 + ½ + 0) / 3 = 0.5 → «Almost there», whatever the model said about the score
    assert (entry["score"], entry["status"], entry["verdict"]) == (0.5, "almost", "partly")
    ideas = entry["review"]["ideas"]
    assert [i["status"] for i in ideas] == ["covered", "partial", "missing"]
    assert ideas[1]["yours"] == "она растёт" and ideas[1]["why_basis"] == "source"
    assert ideas[1]["why_cites"][0]["quote"] == GROWS
    assert ideas[2]["yours"] is None  # not words of the answer
    assert ideas[2]["why_basis"] == "agent" and ideas[2]["why_cites"] == []  # its quote didn't check out
    model = entry["review"]["model"]
    assert [p["text"] for p in model] == ["Энтропия — мера беспорядка, она растёт.",
                                          "Рост энтропии связан с необратимостью."]  # no idea → dropped
    assert model[1] == {"text": "Рост энтропии связан с необратимостью.", "idea": ideas[2]["id"],
                        "added": True}
    assert [(a["basis"], len(a["cites"])) for a in entry["review"]["also"]] == [("agent", 0), ("source", 1)]
    assert entry["checked_by"] == "Codex · Test"


async def test_an_old_test_builds_its_ideas_once_and_a_reopen_never_asks_again(
    world: Any, kb_client: httpx.AsyncClient  # noqa: F811
) -> None:
    runtime, library, _ref = world
    study = runtime.kb_study
    made = await _tool(runtime, "skaz_study_make_test", {"title": "Старый", "questions": _questions(library)})
    block = study.get(made["study_id"])
    item_id = study.questions(block)[3].id
    assert study.ideas(item_id) is None
    built = {"ideas": [{"text": "Мера беспорядка.", "source": 1, "quote": ENTROPY},
                       {"text": "Плохая цитата.", "source": 1, "quote": "совсем не из лекции эти слова"},
                       {"text": "Растёт в изолированной.", "source": 1, "quote": GROWS}],
             "points": [_point(1, "covered"), _point(2, "covered")],
             "model_answer": [], "also_right": [], "comment": "Хорошо."}
    judge = FakeJudge(built, {**built, "ideas": [], "points": [_point(1, "covered")]})
    study.judge = judge
    await study.check_open(block.id, item_id, "Беспорядок, и растёт.")
    await study.settle()
    assert "No key ideas were set" in judge.calls[0].instructions
    ideas = study.ideas(item_id)
    assert [i["text"] for i in ideas] == ["Мера беспорядка.", "Растёт в изолированной."]
    assert study.attempt(study.get(block.id)).answers["items"][item_id]["status"] == "got"

    for _ in range(2):  # reopening the block reads the stored review; the agent isn't called
        part = (await kb_client.get(f"/kb/study/{block.id}")).json()
        review = part["questions"][3]["response"]["review"]
        assert [i["status"] for i in review["ideas"]] == ["covered", "covered"]
        assert review["ideas"][0]["citations"][0]["quote"] == ENTROPY
    assert len(judge.calls) == 1

    await study.check_open(block.id, item_id, "Только беспорядок.")  # a new check: the same ideas
    await study.settle()
    assert "No key ideas were set" not in judge.calls[1].instructions
    assert "2. Растёт в изолированной." in judge.calls[1].data
    assert study.attempt(study.get(block.id)).answers["items"][item_id]["score"] == 0.5


async def test_no_checked_idea_at_all_leaves_the_answer_unchecked_with_a_reason(world: Any) -> None:  # noqa: F811
    runtime, library, _ref = world
    study = runtime.kb_study
    made = await _tool(runtime, "skaz_study_make_test", {"title": "Т", "questions": _questions(library)})
    block = study.get(made["study_id"])
    item_id = study.questions(block)[3].id
    study.judge = FakeJudge({"ideas": [{"text": "x", "source": 1, "quote": "не из лекции эти слова вовсе"}],
                             "points": [], "model_answer": [], "also_right": [], "comment": ""})
    await study.check_open(block.id, item_id, "Хаос")
    await study.settle()
    entry = study.attempt(study.get(block.id)).answers["items"][item_id]
    assert not entry["checked"] and "key ideas" in entry["error"] and study.ideas(item_id) is None


async def test_i_did_say_this_rechecks_one_idea_and_counted_by_you_recomputes(
    world: Any, kb_client: httpx.AsyncClient  # noqa: F811
) -> None:
    runtime, library, _ref = world
    study = runtime.kb_study
    block, item_id = await _made(runtime, library, _open_with_ideas(library))
    judge = FakeJudge(REVIEW, {"status": "covered", "note": "Да, это сказано."},
                      {"status": "missing",
                       "note": "Здесь про беспорядок; про необратимость стоит добавить."})
    study.judge = judge
    await study.check_open(block.id, item_id, ANSWER)
    await study.settle()
    ideas = study.attempt(study.get(block.id)).answers["items"][item_id]["review"]["ideas"]
    partial, missing = ideas[1]["id"], ideas[2]["id"]

    with pytest.raises(KnowledgeError, match="your own answer"):
        await study.recheck_idea(block.id, item_id, partial, "слова, которых не было")
    response = await kb_client.post(f"/kb/study/{block.id}/recheck",
                                    json={"item_id": item_id, "idea_id": partial, "words": "она растёт"})
    assert response.status_code == 200, response.text
    await study.settle()
    call = judge.calls[1]
    assert call.kind == "recheck" and "В изолированной системе она растёт." in call.data
    assert "Она связана с необратимостью." not in call.data  # ONE idea only
    entry = study.attempt(study.get(block.id)).answers["items"][item_id]
    assert entry["review"]["ideas"][1]["status"] == "covered"
    assert (entry["score"], entry["status"]) == (round(2 / 3, 4), "almost")

    await study.recheck_idea(block.id, item_id, missing, "мера беспорядка")
    await study.settle()
    entry = study.attempt(study.get(block.id)).answers["items"][item_id]
    third = entry["review"]["ideas"][2]
    assert third["status"] == "missing" and third["recheck"]["note"].startswith("Здесь про беспорядок")

    counted = (await kb_client.post(f"/kb/study/{block.id}/count",
                                    json={"item_id": item_id, "idea_id": missing})).json()
    response = counted["questions"][0]["response"]
    assert response["review"]["ideas"][2]["by_user"] is True
    assert (response["score"], response["status"]) == (1.0, "got")
    back = (await kb_client.post(f"/kb/study/{block.id}/count",
                                 json={"item_id": item_id, "idea_id": missing, "counted": False})).json()
    assert back["questions"][0]["response"]["status"] == "almost"


async def test_a_finished_result_follows_a_later_recount_and_got_it_is_not_a_tricky_one(
    world: Any,  # noqa: F811
) -> None:
    runtime, library, _ref = world
    study = runtime.kb_study
    block, item_id = await _made(runtime, library, _open_with_ideas(library))
    study.judge = FakeJudge(REVIEW)
    await study.check_open(block.id, item_id, ANSWER)
    await study.settle()
    block = await asyncio.to_thread(study.finish, block.id)
    result = study.result(block)
    assert (result["correct"], result["partly"], result["mistakes"]) == (0.5, 1, 1)
    assert result["rows"][0]["status"] == "almost"
    ideas = study.attempt(block).answers["items"][item_id]["review"]["ideas"]
    for idea in ideas[1:]:
        await asyncio.to_thread(study.count_idea, block.id, item_id, idea["id"], True)
    result = study.result(study.get(block.id))
    assert (result["correct"], result["mistakes"]) == (1.0, 0)
    with pytest.raises(KnowledgeError, match="No mistakes"):
        await asyncio.to_thread(study.retake, block.id, mistakes_only=True)


def test_the_status_thresholds_of_decision_5() -> None:
    ideas = [{"status": "covered"}] * 4 + [{"status": "missing"}]
    assert (share_of(ideas), status_of(share_of(ideas))) == (0.8, "got")
    ideas = [{"status": "covered"}] * 3 + [{"status": "partial"}] + [{"status": "missing"}]
    assert (share_of(ideas), status_of(share_of(ideas))) == (0.7, "almost")
    ideas = [{"status": "missing"}] * 5
    assert status_of(share_of(ideas)) == "not_yet"
    assert share_of([{"status": "missing", "by_user": True}, {"status": "missing"}]) == 0.5
    assert is_mistake({"status": "almost", "score": 0.7}) and not is_mistake({"status": "got", "score": 0.8})
    assert is_mistake({"score": 0.0}) and not is_mistake({"score": 1.0}) and is_mistake(None)


async def test_a_review_arriving_after_see_result_updates_the_total(world: Any) -> None:  # noqa: F811
    """Q1 p3 M1: «See result» while the agent still checks; the late review counts in the total."""
    runtime, library, _ref = world
    study = runtime.kb_study
    block, item_id = await _made(runtime, library, _open_with_ideas(library))
    release = asyncio.Event()
    inner = FakeJudge(REVIEW)

    async def slow(call: JudgeCall) -> Mapping[str, Any]:
        await release.wait()
        return await inner(call)

    study.judge = slow
    await study.check_open(block.id, item_id, ANSWER)
    await asyncio.to_thread(study.finish, block.id)
    assert study.result(study.get(block.id))["correct"] == 0.0
    release.set()
    await study.settle()
    result = study.result(study.get(block.id))
    assert result["correct"] == 0.5 and result["rows"][0]["status"] == "almost"


async def test_a_check_or_recheck_cut_off_by_a_restart_never_shows_as_running_forever(
    world: Any, kb_client: httpx.AsyncClient  # noqa: F811
) -> None:
    """Q1 p3 M3: the stored «checking» / «rechecking» flags count only while SKAZ really runs the check."""
    runtime, library, _ref = world
    study = runtime.kb_study
    block, item_id = await _made(runtime, library, _open_with_ideas(library))
    release = asyncio.Event()
    inner = FakeJudge(REVIEW)

    async def slow(call: JudgeCall) -> Mapping[str, Any]:
        await release.wait()
        return await inner(call)

    study.judge = slow
    await study.check_open(block.id, item_id, ANSWER)
    running = (await kb_client.get(f"/kb/study/{block.id}")).json()["questions"][0]["response"]
    assert running["checking"] is True and running["error"] is None  # a live check shows as running
    release.set()
    await study.settle()

    # The app quit mid-check / mid-recheck: the flags stay stored, the tasks are gone.
    ideas = study.attempt(study.get(block.id)).answers["items"][item_id]["review"]["ideas"]
    await asyncio.to_thread(study._change_answer, block.id, item_id,
                            lambda e: study._with_idea(e, ideas[1]["id"], rechecking=True))
    response = (await kb_client.get(f"/kb/study/{block.id}")).json()["questions"][0]["response"]
    assert response["review"]["ideas"][1]["rechecking"] is False
    await asyncio.to_thread(study._put_answer, study.get(block.id), item_id,
                            {"text": ANSWER, "checked": False, "score": None, "checking": True})
    response = (await kb_client.get(f"/kb/study/{block.id}")).json()["questions"][0]["response"]
    assert response["checking"] is False and "Try again" in response["error"]


async def test_a_late_check_or_recheck_never_lands_on_a_newer_attempt(world: Any) -> None:  # noqa: F811
    """Q1 p3 M7: results are tied to the attempt they were asked for; a retake starts its own check."""
    runtime, library, _ref = world
    study = runtime.kb_study
    block, item_id = await _made(runtime, library, _open_with_ideas(library))
    held = asyncio.Event()
    inner = FakeJudge(REVIEW, {"status": "covered", "note": "Да."}, REVIEW)

    async def judge(call: JudgeCall) -> Mapping[str, Any]:
        answer = await inner(call)
        if call.kind == "recheck":  # the recheck of attempt 1 waits until attempt 2 is reviewed
            await held.wait()
        return answer

    study.judge = judge
    await study.check_open(block.id, item_id, ANSWER)
    await study.settle()
    ideas = study.attempt(study.get(block.id)).answers["items"][item_id]["review"]["ideas"]
    await study.recheck_idea(block.id, item_id, ideas[1]["id"], "она растёт")  # held
    for _ in range(200):
        if len(inner.calls) == 2:
            break
        await asyncio.sleep(0.01)
    await asyncio.to_thread(study.retake, block.id, mistakes_only=False)
    await study.check_open(block.id, item_id, "Хаос.")  # attempt 2: its own check
    for _ in range(300):
        if (study.attempt(study.get(block.id)).answers["items"].get(item_id) or {}).get("checked"):
            break
        await asyncio.sleep(0.01)
    assert len(inner.calls) == 3 and "Хаос." in inner.calls[2].data
    new_attempt = study.attempt(study.get(block.id)).id
    held.set()
    await study.settle()
    attempt = study.attempt(study.get(block.id))
    assert attempt.id == new_attempt
    entry = attempt.answers["items"][item_id]
    assert entry["text"] == "Хаос." and entry["checked"] is True
    ideas = entry["review"]["ideas"]
    assert all(idea.get("recheck") is None and not idea.get("rechecking") for idea in ideas)  # dropped
    assert ideas[1]["status"] == "partial"  # the old «covered» didn't land on this review


async def test_a_retake_during_a_check_starts_its_own_check_and_drops_the_old_one(world: Any) -> None:  # noqa: F811
    """Q1 p3 M7 (the open-answer check): the old answer's review never shows on the new attempt."""
    runtime, library, _ref = world
    study = runtime.kb_study
    block, item_id = await _made(runtime, library, _open_with_ideas(library))
    first = asyncio.Event()
    inner = FakeJudge(REVIEW, {**REVIEW, "points": [_point(1, "missing")]})

    async def judge(call: JudgeCall) -> Mapping[str, Any]:
        if not inner.calls:
            answer = await inner(call)
            await first.wait()
            return answer
        return await inner(call)

    study.judge = judge
    await study.check_open(block.id, item_id, ANSWER)
    await asyncio.to_thread(study.retake, block.id, mistakes_only=False)
    await study.check_open(block.id, item_id, "Хаос.")
    for _ in range(200):
        if len(inner.calls) == 2:
            break
        await asyncio.sleep(0.01)
    assert len(inner.calls) == 2 and "Хаос." in inner.calls[1].data
    await asyncio.sleep(0.05)
    first.set()
    await study.settle()
    entry = study.attempt(study.get(block.id)).answers["items"][item_id]
    assert entry["text"] == "Хаос." and entry["checked"] is True
    assert entry["review"]["ideas"][0]["status"] == "missing"  # the new review, not the old one
