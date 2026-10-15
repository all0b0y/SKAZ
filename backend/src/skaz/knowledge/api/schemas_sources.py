"""Pydantic models of the source routes (area S1): adding materials, link preview, exclusions."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .schemas import KbMaterialSummary

KbLinkKind = Literal["video", "audio_file", "video_file", "pdf", "site"]
KbVideoPlatform = Literal["youtube", "vk", "rutube", "vimeo"]
KbHiddenKind = Literal[
    "unicode_tags",
    "bidi_control",
    "zero_width_run",
    "variation_selector_run",
    "interlinear_annotation",
    "hidden_html",
    "html_comment",
    "hidden_pdf_text",
]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KbAddText(_Request):
    #: Any length; long text is split into paragraph fragments.
    text: str = Field(min_length=1)
    folder_id: str = Field(min_length=1, max_length=64)
    #: ``null`` = the first words of the text (≤ 60 characters).
    title: str | None = Field(default=None, max_length=255)


class KbAddFile(_Request):
    #: The absolute path the Electron file dialog returned (PDF, .md, .txt).
    path: str = Field(min_length=1, max_length=4096)
    folder_id: str = Field(min_length=1, max_length=64)
    #: ``null`` = the document's own title, else the file name.
    title: str | None = Field(default=None, max_length=255)


KbAddLinkMode = Literal["text", "video", "both"]


class KbAddLink(_Request):
    url: str = Field(min_length=1, max_length=4096)
    folder_id: str = Field(min_length=1, max_length=64)
    #: ``null`` = the page's (video's) title, else the domain.
    title: str | None = Field(default=None, max_length=255)
    #: A page with an embedded video (``KbLinkInfo.embedded_video``): its text, the video or both
    #: (two materials). A video link itself is always imported as a video.
    mode: KbAddLinkMode = "text"
    #: Videos only: the spoken language (``null`` = the saved languages) and provider translation.
    language: str | None = Field(default=None, max_length=32)
    translate: bool = False


class KbClassifyLink(_Request):
    url: str = Field(min_length=1, max_length=4096)
    #: Ask the video tool for duration/availability (videos on supported hosts only).
    probe: bool = True


class KbMaterialAdded(BaseModel):
    material: KbMaterialSummary
    #: Fragments kept out of processing because they read like instructions for an AI.
    excluded_count: int
    #: Hidden content removed before anything was stored as text (layer 2 findings).
    hidden_count: int
    #: Why the material is ``failed`` (e.g. a scanned PDF), else ``null``.
    failure_reason: str | None
    #: Mode ``both``: the video material added beside the article (``null`` otherwise or if it failed).
    video: KbMaterialSummary | None
    #: Mode ``both``: why the video could not be added (the article was added).
    video_failure_reason: str | None


class KbLinkInfo(BaseModel):
    kind: KbLinkKind
    url: str
    domain: str
    #: "YouTube · 1:12:30", "habr.com · article".
    label: str
    platform: KbVideoPlatform | None
    video_id: str | None
    title: str | None
    duration_ms: int | None
    #: False when SKAZ can't add the link as this kind (e.g. a video on another site).
    supported: bool
    note: str | None
    #: The page embeds a video from YouTube, VK Video, RuTube or Vimeo: ask text / video / both.
    embedded_video: KbLinkInfo | None


class KbFragmentLocation(BaseModel):
    index: int | None
    page: int | None
    start_ms: int | None
    #: "paragraph 3", "page 12", "08:12".
    label: str


class KbExcludedFragment(BaseModel):
    seg: int
    #: ``seg-<n>``.
    id: str
    reason: str
    rules: list[str]
    score: float
    #: The text that triggered the detector.
    found: str
    location: KbFragmentLocation
    text_hash: str
    detected_at: str


class KbRestoredFragment(BaseModel):
    seg: int
    text_hash: str
    restored_at: str


class KbHiddenFinding(BaseModel):
    kind: KbHiddenKind
    detail: str
    #: The removed content, invisible characters spelled out as ``<U+200B>``.
    original: str
    index: int | None
    page: int | None
    element: str | None
    #: The hidden content itself reads like an instruction for an AI.
    instruction: bool


class KbMaterialGuard(BaseModel):
    material_id: str
    excluded: list[KbExcludedFragment]
    restored: list[KbRestoredFragment]
    hidden: list[KbHiddenFinding]
    failure_reason: str | None
