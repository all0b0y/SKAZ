"""User decision X2-8: no "doubtful corrections" notification without a decision layer; a one-time
offer of the local decision model at the first finished recording.

The writing agent and the decision layer are fakes (``ScriptedWiki``, ``FakeDecisions``) and the
local model manager is a stand-in: no download, no model — this proves the plumbing only.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx

from skaz.knowledge.corrections.offer import OFFER_KEY, OFFER_KIND, AutoFixesOffer, size_label
from skaz.knowledge.decisions.local import LOCAL_MODEL
from skaz.knowledge.decisions.service import DecisionService
from skaz.knowledge.markdown.source import MaterialKind
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiring import CurrentDecisions

from .ingest_support import FakeDecisions, ScriptedWiki, add_material
from .test_corrections import CHECK, CONCEPTS, NOTES, SPEECH, decide
from .wiki_support import RECOGNITION, ingest_done, settle_wiki, wired


def doubtful_notices(kb: KnowledgeService) -> list[Any]:
    return [item for item in kb.notifications() if item.kind == "doubtful_corrections"]


async def check_with(kb: KnowledgeService, decisions: Any) -> list[str]:
    """Run the recognition check of one recording with ``decisions`` as the layer; the corrections' states."""
    material_id = add_material(kb, "Физика", "Лекция 8", SPEECH)
    wiki = ScriptedWiki(notes=[NOTES], concepts=[CONCEPTS], answers={RECOGNITION: [CHECK]})
    ingest, service = wired(kb, wiki)
    ingest.decisions = decisions
    await ingest_done(ingest, material_id)
    await settle_wiki(service, ingest)
    return sorted(entry.state for entry in service.store.read_or_empty(material_id).corrections)


async def test_without_a_decision_layer_doubtful_fixes_post_no_notification(ready: KnowledgeService) -> None:
    assert await check_with(ready, None) == ["doubtful", "doubtful"]
    assert doubtful_notices(ready) == []  # still highlighted in the material, nothing in the feed


async def test_provider_off_or_model_missing_counts_as_no_layer(ready: KnowledgeService) -> None:
    assert await check_with(ready, CurrentDecisions(lambda: None)) == ["doubtful", "doubtful"]
    assert doubtful_notices(ready) == []


async def test_a_chosen_but_not_downloaded_local_model_posts_nothing(ready: KnowledgeService) -> None:
    layer = CurrentDecisions(lambda: FakeDecisions(decide), ready=lambda: False)  # type: ignore[arg-type,return-value]
    await check_with(ready, layer)
    assert doubtful_notices(ready) == []


async def test_with_a_layer_set_up_the_notification_stays(ready: KnowledgeService) -> None:
    layer = CurrentDecisions(lambda: FakeDecisions(decide), ready=lambda: True)  # type: ignore[arg-type,return-value]
    assert await check_with(ready, layer) == ["applied", "doubtful"]
    assert len(doubtful_notices(ready)) == 1


# -- the one-time offer ------------------------------------------------------------


class StandInManager:
    """The local model manager's surface the offer uses; the download "finishes" when told to."""

    def __init__(self, decisions_root: Path) -> None:
        self.model = LOCAL_MODEL  # the app's pinned model asset
        self.downloads = 0
        self.done = asyncio.Event()
        self._installed = False
        self.root = decisions_root

    def installed(self) -> bool:
        return self._installed

    def download(self) -> Any:
        self.downloads += 1
        return None

    async def wait_download(self) -> Any:
        await self.done.wait()
        self._installed = True
        return None

    def finish(self) -> None:
        self.done.set()


def offer_for(kb: KnowledgeService, tmp_path: Path,
              register: bool = True) -> tuple[AutoFixesOffer, DecisionService, StandInManager]:
    manager = StandInManager(tmp_path / "decisions")
    decisions = DecisionService(kb.db, kb.settings, data_dir=tmp_path, http=httpx.AsyncClient(),
                                api_key=lambda: None, manager=manager)  # type: ignore[arg-type]
    offer = AutoFixesOffer(kb, decisions)
    if register:
        offer.register()
    return offer, decisions, manager


def offers(kb: KnowledgeService) -> list[Any]:
    return [item for item in kb.notifications() if item.kind == OFFER_KIND]


async def test_the_offer_comes_once_at_the_first_recording_with_the_pinned_size(
        ready: KnowledgeService, tmp_path: Path) -> None:
    offer, decisions, manager = offer_for(ready, tmp_path)
    article = add_material(ready, "Физика", "Статья", SPEECH, kind="text")
    assert not offer.offer_once(article)  # not a recording
    first = add_material(ready, "Физика", "Лекция 1", SPEECH)
    offer.material_finished(first)
    await offer.settle()
    [notice] = offers(ready)
    size = size_label(manager.model.asset.size)
    assert size == "2.7 GB" and size in notice.body and notice.title == "Turn on automatic fixes"
    assert notice.requires_action
    assert [spec.id for spec in ready.notification_actions.actions(notice)] == ["download", "not_now"]
    assert ready.settings.get(OFFER_KEY) == "shown"

    second = add_material(ready, "Физика", "Лекция 2", SPEECH)
    assert not offer.offer_once(second)
    assert len(offers(ready)) == 1
    assert decisions.provider() == "off"


async def test_not_now_is_remembered_and_a_chosen_provider_gets_no_offer(
        ready: KnowledgeService, tmp_path: Path) -> None:
    from skaz.knowledge.notifications.feed import NotificationFeed

    offer, decisions, _manager = offer_for(ready, tmp_path)
    assert offer.offer_once(add_material(ready, "Физика", "Лекция 1", SPEECH))
    [notice] = offers(ready)
    await NotificationFeed(ready).resolve(notice.id, "not_now", None)
    assert ready.settings.get(OFFER_KEY) == "dismissed"
    assert decisions.provider() == "off"
    # A new offer service (next app start) still remembers.
    again, _, _ = offer_for(ready, tmp_path / "next", register=False)
    assert not again.offer_once(add_material(ready, "Физика", "Лекция 2", SPEECH))
    assert len(offers(ready)) == 1

    ready.settings.set(OFFER_KEY, None)
    decisions.configure("local")
    assert not again.offer_once(add_material(ready, "Физика", "Лекция 3", SPEECH))  # a provider is chosen


async def test_download_starts_the_model_download_and_selects_local_when_done(
        ready: KnowledgeService, tmp_path: Path) -> None:
    from skaz.knowledge.notifications.feed import NotificationFeed

    offer, decisions, manager = offer_for(ready, tmp_path)
    assert offer.offer_once(add_material(ready, "Физика", "Лекция 1", SPEECH))
    [notice] = offers(ready)
    resolved = await NotificationFeed(ready).resolve(notice.id, "download", None)
    assert resolved.resolution == "download" and manager.downloads == 1
    assert decisions.provider() == "off"  # not before the model is there
    manager.finish()
    await offer.settle()
    assert decisions.provider() == "local" and decisions.ready()
    assert ready.settings.get(OFFER_KEY) == "accepted"


async def test_imported_speech_also_brings_the_offer_once_in_total(
        ready: KnowledgeService, tmp_path: Path) -> None:
    """X5 (X2 Q2): the first finished imported audio/video/link offers it too — once in total."""
    speech: tuple[MaterialKind, ...] = ("audio", "video", "video_link")
    for kind in speech:
        ready.settings.set(OFFER_KEY, None)
        offer, _decisions, _manager = offer_for(ready, tmp_path / kind, register=False)
        imported = add_material(ready, "Физика", f"Импорт {kind}", SPEECH, kind=kind)
        assert offer.offer_once(imported), kind
        assert ready.settings.get(OFFER_KEY) == "shown"
        # After an import offered it, neither a recording nor another import offers it again.
        assert not offer.offer_once(add_material(ready, "Физика", f"Лекция после {kind}", SPEECH))
        assert not offer.offer_once(add_material(ready, "Физика", f"Ещё импорт {kind}", SPEECH, kind=kind))
    assert len(offers(ready)) == 3  # one per reset above, never two in a row
    documents: tuple[MaterialKind, ...] = ("text", "pdf", "web")
    for kind in documents:
        ready.settings.set(OFFER_KEY, None)
        offer, _decisions, _manager = offer_for(ready, tmp_path / kind, register=False)
        document = add_material(ready, "Физика", f"Документ {kind}", SPEECH, kind=kind)
        assert not offer.offer_once(document), kind


def test_size_label() -> None:
    assert size_label(2_740_937_888) == "2.7 GB"
    assert size_label(12_166_187) == "12 MB"
