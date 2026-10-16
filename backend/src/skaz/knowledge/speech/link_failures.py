"""Video links that failed after they were added: the ``link_failed`` notification and its actions.

A link that can't be added at all (not a video host, a playlist, private,
18+, live) is refused right away with the reason in the response; nothing is
created. Once a video link was accepted, its download and transcription run
in the background; when that import fails, the material is ``failed`` and
the feed gets one ``link_failed`` card per failure with three actions
(API-B2 §1.1): ``retry`` (the same link again), ``fix_url`` (a corrected
address replaces the failed material) and ``delete_material``.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from typing import TYPE_CHECKING

from ..errors import KnowledgeError, NotFound
from ..notifications.actions import ActionSpec
from .carriers import CarrierKind
from .legacy import IMPORT_INVALID
from .media import UnsupportedMedia, classify_video_link
from .service import ImportInput, SpeechInvalid, SpeechService

if TYPE_CHECKING:
    from ..service import KnowledgeService
    from ..store.records import NotificationRecord

logger = logging.getLogger(__name__)

LINK_FAILED = "link_failed"
#: ``kb.settings`` key per material: the open ``link_failed`` card (one card per failure).
_OPEN_KEY = "speech.link_failed."
ACTIONS: tuple[ActionSpec, ...] = (
    ActionSpec("retry", "Try again", primary=True),
    ActionSpec("fix_url", "Fix the link", needs_text=True),
    ActionSpec("delete_material", "Delete"),
)


class UnknownAction(KnowledgeError):
    status_code = 422


class LinkFailures:
    def __init__(self, kb: KnowledgeService, speech: SpeechService) -> None:
        self.kb = kb
        self.speech = speech

    def register(self) -> None:
        """Subscribe to import failures and register the card's actions (once per app)."""
        self.speech.on_import_state(self.import_state)
        self.kb.notification_actions.register(LINK_FAILED, self.actions, self.handle)

    @staticmethod
    def actions(_notification: NotificationRecord) -> Sequence[ActionSpec]:
        return ACTIONS

    # -- raising the card ----------------------------------------------------

    def import_state(self, material_id: str, kind: CarrierKind, error: str | None) -> None:
        if kind != "video_link":
            return
        key = _OPEN_KEY + material_id
        if error is None:  # running again (retry): the next failure gets a new card
            if self.kb.settings.get(key) is not None:
                self.kb.settings.set(key, None)
            return
        if self.kb.settings.get(key) is not None:
            return
        record = self.kb.material_repo.get(material_id)
        if record is None:
            return
        url = str((record.origin or {}).get("url") or "")
        notification = self.kb.notify(
            LINK_FAILED, "A video link couldn't be added",
            body=f"“{record.title}”: {error}",
            payload={"material_id": material_id, "material_title": record.title, "url": url,
                     "reason": error},
            requires_action=True,
        )
        self.kb.settings.set(key, notification.id)

    # -- actions ---------------------------------------------------------------

    async def handle(self, _kb: KnowledgeService, notification: NotificationRecord, action: str,
                     text: str | None) -> None:
        material_id = str(notification.payload.get("material_id") or "")
        if not material_id:
            raise NotFound("This notification has no material.")
        if action == "retry":
            await self.speech.retry_import(material_id)
        elif action == "fix_url":
            await self.replace_url(material_id, (text or "").strip())
        elif action == "delete_material":
            await self.speech.discard_failed_import(material_id)
            self.kb.settings.set(_OPEN_KEY + material_id, None)
        else:
            raise UnknownAction("Unknown action.")

    async def replace_url(self, material_id: str, url: str) -> None:
        """A corrected address: checked first (nothing changes if it is wrong), then it replaces the
        failed material in the same folder."""
        if not url:
            raise SpeechInvalid("Paste the corrected video link.")
        record = await asyncio.to_thread(self.kb.material_repo.get, material_id)
        if record is None:
            raise NotFound("Material not found.")
        try:
            classify_video_link(url)
        except UnsupportedMedia as error:
            raise SpeechInvalid(str(error)) from error
        try:
            metadata = await self.speech.legacy.video_metadata(url)
        except IMPORT_INVALID as error:
            raise SpeechInvalid(str(error)) from error
        await self.speech.discard_failed_import(material_id)
        self.kb.settings.set(_OPEN_KEY + material_id, None)
        await self.speech.start_import(ImportInput(
            url=url, folder_id=record.folder_id, metadata=metadata,
            language=record.languages[0] if record.languages else None,
        ))
