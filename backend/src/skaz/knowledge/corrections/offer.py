"""One-time offer of automatic recognition fixes at the first speech material (user decision X2-8).

Without a decision layer every proposed fix stays "doubtful" (highlighted in the
material only). When the first speech material is finished — a live recording or
an imported audio/video file or video link (X5) — and no decision provider is
chosen, SKAZ posts one notification offering the local decision model:

* **Download** starts the existing local-model download (``decisions/local.py``)
  and selects the ``local`` provider once the model is there;
* **Not now** remembers the answer; the offer never comes back.

Either way the offer is posted once (``decisions.local_offer`` in the knowledge
settings). Settings → Decisions keeps offering the download later.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Literal, Protocol

from ...native_io import disk_call
from ..logsafe import error_note
from ..notifications.actions import ActionSpec
from ..speech.carriers import CarrierKind

if TYPE_CHECKING:
    from ..decisions.local import LocalModel, LocalStatus
    from ..service import KnowledgeService
    from ..store.records import NotificationRecord

logger = logging.getLogger(__name__)

OFFER_KIND = "auto_fixes_offer"
#: ``shown`` (posted, unanswered), ``dismissed`` (Not now) or ``accepted`` (Download).
OFFER_KEY = "decisions.local_offer"
OfferState = Literal["shown", "dismissed", "accepted"]
DOWNLOAD = ActionSpec("download", "Download", primary=True)
NOT_NOW = ActionSpec("not_now", "Not now")
#: Materials whose text is recognised speech: the ones automatic fixes work on.
SPEECH_KINDS: tuple[CarrierKind, ...] = ("recording", "audio", "video", "video_link")


class _Manager(Protocol):
    @property
    def model(self) -> LocalModel: ...

    def installed(self) -> bool: ...

    def download(self) -> LocalStatus: ...

    async def wait_download(self) -> LocalStatus: ...


class _Decisions(Protocol):
    """What the offer needs of ``DecisionService``."""

    @property
    def manager(self) -> _Manager: ...

    def provider(self) -> str: ...

    def configure(self, provider: Literal["off", "openrouter_jev", "local"],
                  cloud_consent: bool | None = None) -> None: ...


def size_label(size: int) -> str:
    """Decimal gigabytes with one digit (``2_740_937_888`` → ``2.7 GB``), like Finder."""
    if size >= 1_000_000_000:
        return f"{size / 1_000_000_000:.1f} GB"
    return f"{max(1, round(size / 1_000_000))} MB"


class AutoFixesOffer:
    def __init__(self, kb: KnowledgeService, decisions: _Decisions) -> None:
        self.kb = kb
        self.decisions = decisions
        self._tasks: set[asyncio.Task[None]] = set()

    def register(self) -> None:
        self.kb.notification_actions.register(OFFER_KIND, lambda _record: (DOWNLOAD, NOT_NOW), self.resolve)

    def state(self) -> OfferState | None:
        value = self.kb.settings.get(OFFER_KEY)
        return value if value in ("shown", "dismissed", "accepted") else None

    # -- trigger --------------------------------------------------------------

    def material_finished(self, material_id: str) -> None:
        """Speech ``on_finished`` listener (on the loop): the check runs off it, in a kept task."""
        self._keep(asyncio.get_running_loop().create_task(self._consider(material_id)))

    async def _consider(self, material_id: str) -> None:
        try:
            await disk_call(self.offer_once, material_id)
        except Exception as error:  # never let the offer break finishing a recording
            logger.error("The automatic fixes offer for %s failed: %s", material_id, error_note(error))

    def offer_once(self, material_id: str) -> bool:
        """Offer it for the first finished speech material, unless asked before or a provider is chosen."""
        if self.state() is not None or self.decisions.provider() != "off":
            return False
        material = self.kb.material_repo.get(material_id)
        if material is None or material.kind not in SPEECH_KINDS:
            return False
        size = size_label(self.decisions.manager.model.asset.size)
        self.kb.settings.set(OFFER_KEY, "shown")
        self.kb.notify(
            OFFER_KIND,
            "Turn on automatic fixes",
            body=(f"Download a {size} local model so SKAZ can fix misheard words in recordings and imported "
                  "audio and video by itself. "
                  "Without it, doubtful fixes are only highlighted in the material. "
                  "You can also do this later in Settings → Decisions."),
            payload={"bytes": self.decisions.manager.model.asset.size},
            requires_action=True,
        )
        return True

    # -- actions --------------------------------------------------------------

    async def resolve(self, _kb: KnowledgeService, _record: NotificationRecord, action: str,
                      _text: str | None) -> None:
        if action == NOT_NOW.id:
            await disk_call(self.kb.settings.set, OFFER_KEY, "dismissed")
            return
        if action == DOWNLOAD.id:
            await disk_call(self.kb.settings.set, OFFER_KEY, "accepted")
            self.decisions.manager.download()
            self._keep(asyncio.get_running_loop().create_task(self._select_when_ready()))

    async def _select_when_ready(self) -> None:
        """Choose ``local`` once the download finished — unless the user chose a provider meanwhile."""
        await self.decisions.manager.wait_download()
        if await disk_call(self.decisions.manager.installed) and \
                await disk_call(self.decisions.provider) == "off":
            await disk_call(self.decisions.configure, "local")

    def _keep(self, task: asyncio.Task[None]) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def settle(self) -> None:
        """Wait for started work (tests; the app does not wait — closing cancels the download)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
