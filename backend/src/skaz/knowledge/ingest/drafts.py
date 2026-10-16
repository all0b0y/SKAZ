"""Checked, not yet written results of one ingest run."""
from __future__ import annotations

from dataclasses import dataclass, field

from ..library.names import FORBIDDEN_CHARACTERS
from .checks import CheckedBlock
from .pages import match_key


@dataclass
class DraftSection:
    title: str
    blocks: list[CheckedBlock] = field(default_factory=list)


@dataclass
class ConceptDraft:
    #: The name in the wiki language, as the source's term is translated (never "corrected").
    title: str
    #: The source's own term when it differs (another language/notation).
    original: str | None
    aliases: list[str] = field(default_factory=list)
    blocks: list[CheckedBlock] = field(default_factory=list)
    related: list[str] = field(default_factory=list)

    @property
    def display_title(self) -> str:
        """``перевод (original)`` (decision 9), or just the title when both are the same."""
        if self.original and match_key(self.original) != match_key(self.title):
            return f"{self.title} ({self.original})"
        return self.title

    def keys(self) -> set[str]:
        names = [self.title, self.display_title, *(self.aliases)]
        if self.original:
            names.append(self.original)
        return {match_key(name) for name in names if name.strip()}

    def all_aliases(self) -> list[str]:
        """Aliases for the page: the wiki-language title, the original and every synonym."""
        names = [self.title, *([self.original] if self.original else []), *self.aliases]
        unique: dict[str, str] = {}
        for name in names:
            key = match_key(name)
            if key and key not in unique:
                unique[key] = name
        return list(unique.values())

    def absorb(self, other: ConceptDraft) -> None:
        """The same concept listed again for a later part: union of names, statements in order."""
        if not self.original and other.original:
            self.original = other.original
        known = {match_key(alias) for alias in self.aliases}
        for alias in other.aliases:
            if match_key(alias) not in known:
                known.add(match_key(alias))
                self.aliases.append(alias)
        self.blocks.extend(other.blocks)
        for title in other.related:
            if title not in self.related:
                self.related.append(title)


def file_name(title: str) -> str:
    """A page file name from a concept title: characters a name can't hold become spaces."""
    cleaned = "".join(" " if char in FORBIDDEN_CHARACTERS else char for char in title)
    return " ".join(cleaned.split()).lstrip(".").strip()
