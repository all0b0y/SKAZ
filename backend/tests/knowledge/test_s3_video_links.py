"""S3: video links from the four hosts become speech materials; failures raise ``link_failed``.

yt-dlp/ffmpeg and the Soniox file API are scripted fakes at the external
edge: this proves the plumbing (routing, statuses, refusals, notification
actions), never that real sites or recognition work.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz import media_tools
from skaz.app import create_app
from skaz.config import AppConfig
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.notifications.actions import ActionSpec
from skaz.knowledge.sources.fetch import SafeFetcher
from skaz.knowledge.speech.link_failures import LINK_FAILED
from skaz.media_source import video_source
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp

from .speech_support import AsyncSoniox

TITLES = {"youtube": "YouTube talk", "vk": "VK talk", "rutube": "RuTube talk", "vimeo": "Vimeo talk"}


class FakeMedia:
    """``media_tools`` at the process edge: metadata per URL, a download that can be told to fail."""

    def __init__(self) -> None:
        self.refuse: dict[str, str] = {}
        self.download_error: str | None = None
        self.downloads: list[str] = []

    async def metadata(self, url: str) -> dict[str, Any]:
        source = video_source(url)
        if source.url in self.refuse:
            raise media_tools.MediaError(self.refuse[source.url])
        return {
            "url": source.url,
            "video_id": source.video_id,
            "platform": source.platform,
            "title": TITLES[source.platform],
            "duration_ms": 2500,
        }

    async def download(self, url: str, directory: Path) -> Path:
        self.downloads.append(url)
        if self.download_error:
            raise media_tools.MediaError(self.download_error)
        path = directory / "download.m4a"
        path.write_bytes(b"fixture audio")
        return path


@pytest.fixture
def media(monkeypatch: pytest.MonkeyPatch) -> FakeMedia:
    fake = FakeMedia()
    monkeypatch.setattr("skaz.import_service.POLL_SCHEDULE", (0.01,))

    async def extract(source: Path, directory: Path) -> Path:
        path = directory / "audio.m4a"
        path.write_bytes(source.read_bytes())
        return path

    monkeypatch.setattr(media_tools, "video_metadata", fake.metadata)
    monkeypatch.setattr(media_tools, "youtube_metadata", fake.metadata)
    monkeypatch.setattr(media_tools, "download_audio", fake.download)
    monkeypatch.setattr(media_tools, "extract_audio", extract)
    return fake


@pytest.fixture
def cloud() -> FakeHttp:
    return FakeHttp()


@pytest.fixture
def soniox(cloud: FakeHttp) -> AsyncSoniox:
    return AsyncSoniox(cloud)


@pytest.fixture
def app(kb_config: AppConfig, cloud: FakeHttp, media: FakeMedia) -> Iterator[Any]:
    secrets = MemorySecretStore()
    secrets.set("soniox", "fixture-key-not-real")
    application = create_app(kb_config, secret_store=secrets, http_client=cloud.client())
    yield application
    application.state.runtime.close()


@pytest.fixture
async def api(app: Any, soniox: AsyncSoniox) -> AsyncIterator[httpx.AsyncClient]:
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert (await client.post("/kb/library", json={})).json()["state"] == "ready"
    assert (await client.put("/settings", json={"cloud_consent": True})).status_code == 200
    try:
        yield client
    finally:
        # No lifespan: close the automatic wiki job and its engine before the loop ends (as shutdown does).
        await app.state.runtime.kb_ingest.close()
        await app.state.runtime.kb_codex.close()
        await app.state.runtime.imports.close()
        await app.state.runtime.kb_speech.close()
        await client.aclose()


async def until(api: httpx.AsyncClient, material_id: str, **expected: object) -> dict[str, Any]:
    view: dict[str, Any] = {}
    for _ in range(500):
        view = (await api.get(f"/kb/imports/{material_id}")).json()
        if all(view.get(key) == value for key, value in expected.items()):
            return view
        await asyncio.sleep(0.01)
    raise AssertionError(f"{material_id} never reached {expected}: {view}")


def use_pages(app: Any, pages: dict[str, str]) -> None:
    async def public(_host: str) -> list[str]:
        return ["93.184.216.34"]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/html; charset=utf-8"}, text=pages[request.url.path]
        )

    app.state.runtime.kb_sources.fetcher = SafeFetcher(
        transport=httpx.MockTransport(handler), resolver=public
    )


@pytest.mark.parametrize(
    ("url", "platform"),
    [
        ("https://youtu.be/dQw4w9WgXcQ", "youtube"),
        ("https://vk.com/video-12345_456239017", "vk"),
        ("https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/", "rutube"),
        ("https://vimeo.com/76979871", "vimeo"),
    ],
)
async def test_video_links_from_all_four_hosts_become_video_link_materials(
    api: httpx.AsyncClient,
    media: FakeMedia,
    url: str,
    platform: str,
) -> None:
    added = await api.post("/kb/materials/link", json={"url": url, "folder_id": INBOX_ID, "language": "en"})
    assert added.status_code == 201, added.text
    body = added.json()
    material = body["material"]
    assert (material["kind"], material["status"], material["title"]) == (
        "video_link",
        "processing",
        TITLES[platform],
    )
    assert material["folder_name"] == "Inbox" and body["video"] is None
    done = await until(api, material["id"], status="ready")
    assert done["import_state"] == "completed"
    detail = (await api.get(f"/kb/materials/{material['id']}")).json()
    assert detail["origin"]["url"] == video_source(url).url and detail["languages"] == ["en"]
    assert media.downloads == [video_source(url).url]


async def test_imports_accept_the_four_hosts_too(api: httpx.AsyncClient) -> None:
    created = await api.post("/kb/imports", json={"url": "https://vimeo.com/76979871"})
    assert created.status_code == 201, created.text
    assert (created.json()["kind"], created.json()["title"]) == ("video_link", "Vimeo talk")
    duplicate = await api.post("/kb/imports", json={"url": "https://vimeo.com/76979871", "title": "Again"})
    assert duplicate.status_code == 409 and "already has a session" in duplicate.json()["detail"]


async def test_unacceptable_links_are_refused_with_the_reason_and_nothing_is_created(
    api: httpx.AsyncClient,
    media: FakeMedia,
) -> None:
    media.refuse["https://vimeo.com/76979871"] = media_tools.PRIVATE
    cases = {
        "https://vimeo.com/76979871": media_tools.PRIVATE,
        "https://vimeo.com/showcase/12": media_tools.PLAYLIST,
        "https://www.youtube.com/playlist?list=PL1": media_tools.PLAYLIST,
        "https://rutube.ru/live/video/c6cc4d620b1d4338901770a44b3e82f4/": media_tools.LIVE,
    }
    for url, reason in cases.items():
        response = await api.post("/kb/materials/link", json={"url": url, "folder_id": INBOX_ID})
        assert response.status_code == 422, (url, response.text)
        assert response.json()["detail"] == reason, url
    assert (await api.get("/kb/materials")).json() == []
    assert (await api.get("/kb/imports/active")).json() == []


async def test_article_with_an_embedded_video_text_video_or_both(app: Any, api: httpx.AsyncClient) -> None:
    page = (
        "<html><head><title>Heat engines</title></head><body><article><h1>Heat engines</h1>"
        "<p>A heat engine converts thermal energy into mechanical work through a cycle.</p>"
        "<p>The Carnot cycle sets the upper limit on the efficiency of any heat engine.</p>"
        "<iframe src='https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0'></iframe>"
        "</article></body></html>"
    )
    plain = (
        "<html><head><title>No video</title></head><body><article><h1>No video</h1>"
        "<p>Entropy measures how many microscopic states fit one macroscopic state.</p>"
        "</article></body></html>"
    )
    talk = (
        "<html><head><title>Talk</title><meta property='og:video' "
        "content='https://player.vimeo.com/video/76979871?h=abc123'></head><body><p>x</p></body></html>"
    )
    use_pages(app, {"/heat": page, "/plain": plain, "/talk": talk})
    preview = (await api.post("/kb/links/classify", json={"url": "https://blog.example/heat"})).json()
    assert preview["kind"] == "site" and preview["embedded_video"]["platform"] == "youtube"
    assert preview["embedded_video"]["url"] == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert preview["embedded_video"]["embedded_video"] is None

    text_only = await api.post(
        "/kb/materials/link", json={"url": "https://blog.example/heat", "folder_id": INBOX_ID}
    )
    assert text_only.status_code == 201 and text_only.json()["material"]["kind"] == "web"

    folder = (await api.post("/kb/folders", json={"name": "Physics"})).json()["id"]
    both = await api.post(
        "/kb/materials/link", json={"url": "https://blog.example/heat", "folder_id": folder, "mode": "both"}
    )
    assert both.status_code == 201, both.text
    result = both.json()
    assert result["material"]["kind"] == "web" and result["video"]["kind"] == "video_link"
    assert result["video"]["folder_id"] == folder and result["video_failure_reason"] is None

    second = (await api.post("/kb/folders", json={"name": "Other"})).json()["id"]
    again = await api.post(
        "/kb/materials/link", json={"url": "https://blog.example/heat", "folder_id": second, "mode": "video"}
    )
    assert again.status_code == 409 and "already has a session" in again.json()["detail"]
    video = await api.post(
        "/kb/materials/link",
        json={
            "url": "https://blog.example/talk",
            "folder_id": second,
            "mode": "video",
            "title": "Engines on video",
        },
    )
    assert video.status_code == 201, video.text
    assert video.json()["material"]["kind"] == "video_link"
    assert video.json()["material"]["title"] == "Engines on video"
    detail = (await api.get(f"/kb/materials/{video.json()['material']['id']}")).json()
    assert detail["origin"]["url"] == "https://vimeo.com/76979871/abc123"

    none = await api.post(
        "/kb/materials/link",
        json={"url": "https://blog.example/plain", "folder_id": INBOX_ID, "mode": "video"},
    )
    assert none.status_code == 422 and "no video" in none.json()["detail"]


async def test_a_failed_download_raises_one_link_failed_card_with_working_actions(
    app: Any,
    api: httpx.AsyncClient,
    media: FakeMedia,
) -> None:
    kb = app.state.runtime.kb
    media.download_error = media_tools.UNAVAILABLE
    added = (
        await api.post(
            "/kb/materials/link", json={"url": "https://vimeo.com/76979871", "folder_id": INBOX_ID}
        )
    ).json()["material"]
    failed = await until(api, added["id"], status="failed")
    assert failed["error"] == media_tools.UNAVAILABLE
    cards = [item for item in kb.notifications() if item.kind == LINK_FAILED]
    assert len(cards) == 1
    card = cards[0]
    assert card.requires_action
    assert card.payload == {
        "material_id": added["id"],
        "material_title": "Vimeo talk",
        "url": "https://vimeo.com/76979871",
        "reason": media_tools.UNAVAILABLE,
    }
    assert [action.id for action in kb.notification_actions.actions(card)] == [
        "retry",
        "fix_url",
        "delete_material",
    ]
    assert kb.notification_actions.actions(card)[1] == ActionSpec("fix_url", "Fix the link", needs_text=True)
    handler = kb.notification_actions.handler(LINK_FAILED)

    # Retry: the same link again; it fails again → one new card for the new failure.
    await handler(kb, card, "retry", None)
    await until(api, added["id"], status="failed", import_state="failed")
    for _ in range(100):
        if len([item for item in kb.notifications() if item.kind == LINK_FAILED]) == 2:
            break
        await asyncio.sleep(0.01)
    cards = [item for item in kb.notifications() if item.kind == LINK_FAILED]
    assert len(cards) == 2

    # Fix the link: a wrong address changes nothing; a good one replaces the failed material.
    with pytest.raises(Exception, match="single video"):
        await handler(kb, cards[0], "fix_url", "https://example.com/v")
    assert kb.material_repo.get(added["id"]) is not None
    media.download_error = None
    await handler(kb, cards[0], "fix_url", "https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/")
    assert kb.material_repo.get(added["id"]) is None
    materials = (await api.get("/kb/materials")).json()
    assert [(item["title"], item["kind"]) for item in materials] == [("RuTube talk", "video_link")]
    await until(api, materials[0]["id"], status="ready")


async def test_delete_material_removes_only_a_failed_empty_import(
    app: Any,
    api: httpx.AsyncClient,
    media: FakeMedia,
    tmp_path: Path,
) -> None:
    kb = app.state.runtime.kb
    media.download_error = media_tools.UNAVAILABLE
    added = (
        await api.post(
            "/kb/materials/link", json={"url": "https://vimeo.com/76979871", "folder_id": INBOX_ID}
        )
    ).json()["material"]
    await until(api, added["id"], status="failed")
    card = next(item for item in kb.notifications() if item.kind == LINK_FAILED)
    folder = Path((await api.get("/kb/library")).json()["root"]) / "Materials" / "Inbox" / "Vimeo talk"
    assert folder.is_dir()
    await kb.notification_actions.handler(LINK_FAILED)(kb, card, "delete_material", None)
    assert not folder.exists() and kb.material_repo.get(added["id"]) is None
    assert (await api.get(f"/kb/imports/{added['id']}")).status_code == 404
    # The same title can be used again right away.
    media.download_error = None
    again = await api.post(
        "/kb/materials/link",
        json={"url": "https://vimeo.com/76979871", "folder_id": INBOX_ID, "title": "Vimeo talk"},
    )
    assert again.status_code == 201, again.text


#: The title from the user's report (7-title.png): yt-dlp gives it with "?", which a name can't hold.
REPORTED = "Почему фондовый рынок США стал ПОМОЙКОЙ?"


async def test_a_video_title_skaz_reads_is_cleaned_not_refused(
    api: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(TITLES, "youtube", REPORTED)
    monkeypatch.setitem(TITLES, "vimeo", 'Part 1/2: "why?" <draft> #1')
    # The Add material dialog sends a plain video link to the speech import without a title.
    imported = await api.post("/kb/imports", json={"url": "https://youtu.be/dQw4w9WgXcQ"})
    assert imported.status_code == 201, imported.text
    assert imported.json()["title"] == "Почему фондовый рынок США стал ПОМОЙКОЙ"
    vimeo = {"url": "https://vimeo.com/76979871", "folder_id": INBOX_ID}
    linked = await api.post("/kb/materials/link", json=vimeo)
    assert linked.status_code == 201, linked.text
    assert linked.json()["material"]["title"] == "Part 1-2 - 'why' draft 1"


async def test_a_video_title_the_user_typed_is_still_refused_with_the_reason(api: httpx.AsyncClient) -> None:
    typed = await api.post("/kb/imports", json={"url": "https://youtu.be/dQw4w9WgXcQ", "title": "Why?"})
    assert typed.status_code == 422 and "can't contain ?" in typed.json()["detail"]
    linked = await api.post(
        "/kb/materials/link",
        json={"url": "https://vimeo.com/76979871", "folder_id": INBOX_ID, "title": "A|B"},
    )
    assert linked.status_code == 422 and "can't contain |" in linked.json()["detail"]
    assert (await api.get("/kb/materials")).json() == []


async def test_a_corrected_link_takes_the_cleaned_video_title(
    app: Any, api: httpx.AsyncClient, media: FakeMedia, monkeypatch: pytest.MonkeyPatch,
) -> None:
    kb = app.state.runtime.kb
    media.download_error = media_tools.UNAVAILABLE
    vimeo = {"url": "https://vimeo.com/76979871", "folder_id": INBOX_ID}
    added = (await api.post("/kb/materials/link", json=vimeo)).json()["material"]
    await until(api, added["id"], status="failed")
    card = next(item for item in kb.notifications() if item.kind == LINK_FAILED)
    media.download_error = None
    monkeypatch.setitem(TITLES, "rutube", REPORTED)
    handler = kb.notification_actions.handler(LINK_FAILED)
    await handler(kb, card, "fix_url", "https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/")
    titles = [item["title"] for item in (await api.get("/kb/materials")).json()]
    assert titles == ["Почему фондовый рынок США стал ПОМОЙКОЙ"]
