"""N2: how much of a material the wiki already had (``KbMaterial.overlap``, the quiet line)."""

from __future__ import annotations

from pydantic import BaseModel


class KbOverlapPage(BaseModel):
    """A concept page that already said some of the material (each repeat links to its page)."""

    id: str
    title: str
    #: How many of the material's statements this page already had.
    repeated: int


class KbMaterialOverlap(BaseModel):
    #: "About N% of this is already in your wiki": repeated / total, rounded (≥ 1 when any repeat).
    percent: int
    #: The material's statements another source had already said (merged as a second citation).
    repeated: int
    #: The material's cited statements on concept pages.
    total: int
    pages: list[KbOverlapPage]
    #: Notes sections with at least one statement the wiki didn't have ("what's new").
    new_sections: list[str]
    #: Notes sections every statement of which the wiki already had.
    repeated_sections: list[str]

