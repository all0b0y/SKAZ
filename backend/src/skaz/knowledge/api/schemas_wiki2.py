"""Pydantic models of the W2 wiki API (API-B2 §1.1, §1.3, §2). Responses have no defaults."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..store.database import MAX_DB_INT
from .schemas import KbBlockLink, KbNotification, KbPageRef
from .schemas_ingest import KbJob

KbCorrectionState = Literal["applied", "doubtful", "reverted", "kept"]
KbNodeKind = Literal["concept", "note", "analysis", "folder"]
KbEdgeKind = Literal["link", "connection"]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KbNotificationFeed(BaseModel):
    #: Newest first. With ``after``: only what was created or changed since (dismissed ones included,
    #: so the UI can drop them).
    items: list[KbNotification]
    #: Pass as ``after`` to the next request.
    cursor: int
    #: Not dismissed and not read yet (the bell counter).
    unread: int
    #: Not dismissed, needing a decision that was not made yet.
    requires_action: int


class KbResolve(_Request):
    action: str = Field(min_length=1, max_length=64)
    #: Only for actions with ``needs_text`` (own note, fixed address).
    text: str | None = Field(default=None, max_length=20_000)


class KbNotificationsRead(_Request):
    up_to_seq: int = Field(ge=0, le=MAX_DB_INT)


class KbCorrection(BaseModel):
    id: str
    material_id: str
    seg: int
    #: What the recognition produced.
    before: str
    #: What SKAZ thinks was said.
    after: str
    reason: str
    #: Probability from the decision layer that this is a recognition error; ``null`` when it didn't decide.
    confidence: float | None
    state: KbCorrectionState
    #: Applied automatically (confident) rather than by the user.
    auto: bool
    created_at: str
    decided_at: str | None


class KbCorrectionChange(BaseModel):
    correction: KbCorrection
    #: Wiki statements taken down at once because their quote is no longer verbatim.
    affected_blocks: int
    #: The ``refresh`` job that rewrites this material's statements, when one was started.
    job: KbJob | None


class KbDeletePreview(BaseModel):
    material_id: str
    title: str
    claims_removed: int
    #: Statements confirmed by other sources: they stay, without this source's citation.
    claims_kept: int
    pages_changed: list[KbPageRef]
    pages_removed: list[KbPageRef]
    connections_removed: int
    #: Your own notes on the affected pages; they are never touched.
    user_notes_kept: int


class KbMaterialUpdate(_Request):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    folder_id: str | None = Field(default=None, min_length=1, max_length=64)


class KbBlockUpdate(_Request):
    text: str = Field(min_length=1, max_length=20_000)


class KbBlockCreate(_Request):
    text: str = Field(min_length=1, max_length=20_000)
    after_block_id: str | None = Field(default=None, max_length=128)
    #: A section title of the page; ``null`` = "My notes".
    section: str | None = Field(default=None, max_length=200)


class KbRescanResult(BaseModel):
    pages_changed: int


class KbGraphNode(BaseModel):
    id: str
    kind: KbNodeKind
    title: str
    folder_ids: list[str]
    degree: int
    #: Labelled even when not selected (one of the best-connected pages).
    hub: bool


class KbGraphEdge(BaseModel):
    source: str
    target: str
    #: ``link``: a wikilink; ``connection``: an agent connection statement.
    kind: KbEdgeKind
    #: The two pages share no folder (drawn dashed).
    cross_folder: bool
    page_id: str | None
    block_id: str | None


class KbGraph(BaseModel):
    nodes: list[KbGraphNode]
    edges: list[KbGraphEdge]


KbRecognitionEngine = Literal["same_as_wiki", "off", "codex", "claude_code", "hermes"]


class KbRecognitionSettings(BaseModel):
    """Settings → Models → Recognition check (B20): ``same_as_wiki`` by default, ``off`` skips it."""

    engine: KbRecognitionEngine
    #: Only with a chosen agent; ``null`` = that agent's default.
    model: str | None
    effort: str | None


class KbRecognitionSettingsUpdate(_Request):
    """The whole choice; a model and effort go only with a chosen agent."""

    engine: KbRecognitionEngine
    model: str | None = Field(default=None, max_length=100)
    effort: str | None = Field(default=None, max_length=100)


class KbExportTarget(BaseModel):
    path: str
    #: Why this folder can't be used; ``null`` when it can (after a confirmation if ``non_empty``).
    reason: str | None
    non_empty: bool
    #: Items already in the folder.
    entries: int


class KbExportRequest(_Request):
    path: str = Field(min_length=1, max_length=4096)
    #: The user confirmed exporting into a non-empty folder (same names are replaced, others stay).
    overwrite: bool = False


class KbPageFile(BaseModel):
    #: Absolute path of the page's ``.md`` file (main process only).
    path: str


class KbWikiFile(BaseModel):
    """``Wiki/index.md`` / ``Wiki/log.md`` for the read-only view (B20)."""

    name: Literal["index", "log"]
    #: The file's Markdown; empty while the wiki has none yet.
    text: str
    #: Its wikilinks resolved to pages and materials (as for page blocks).
    links: list[KbBlockLink]
