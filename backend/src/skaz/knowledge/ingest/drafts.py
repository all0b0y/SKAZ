"""Checked, not yet written results of one ingest run.

The duplicate filter (WR3, decision 9c) lives here: it never stops a job. A statement that nearly
repeats one already kept for the same concept (or a same-titled Notes section) is not added; the kept
statement takes its source refs, so the second place in the source is not lost. A quote shared by
different concepts is no duplicate: they are different pages.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field, replace

from ..library.names import FORBIDDEN_CHARACTERS
from .checks import CheckedBlock
from .pages import match_key
from .repetition import is_short, mark, same


def merge_refs(kept: CheckedBlock, other: CheckedBlock) -> CheckedBlock:
    """``kept`` with the citations and links of its repeat ``other`` added, in order, once each."""
    return replace(kept, segs=tuple(dict.fromkeys((*kept.segs, *other.segs))),
                   links=tuple(dict.fromkeys((*kept.links, *other.links))),
                   quotes=tuple(dict.fromkeys((*kept.quotes, *other.quotes))))


def place_block(target: list[CheckedBlock], block: CheckedBlock, groups: Sequence[list[CheckedBlock]], *,
                exact_short: bool) -> bool:
    """Append ``block`` to ``target`` unless it nearly repeats a statement of the same kind in
    ``groups`` (``target`` usually among them); then that statement takes its refs. A short statement
    repeats only word for word; with ``exact_short`` false (Notes) it must also cite the same
    fragments, so a label such as "Example:" before each new example stays. ``True`` when appended."""
    short = is_short(block.text)
    marked = mark(block.text)
    if marked:
        for group in groups:
            for index, kept in enumerate(group):
                if kept.kind != block.kind or not same(marked, mark(kept.text)):
                    continue
                if short and not exact_short and (not block.segs or set(block.segs) != set(kept.segs)):
                    continue
                group[index] = merge_refs(kept, block)
                return False
    target.append(block)
    return True


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

    def add(self, block: CheckedBlock) -> bool:
        """Add a statement unless it repeats one of this concept (then only its refs are added)."""
        return place_block(self.blocks, block, [self.blocks], exact_short=True)

    def absorb(self, other: ConceptDraft) -> int:
        """The same concept listed again (a later part, or a repeat): union of names, new statements
        in order. Returns how many of ``other``'s statements were repeats merged into kept ones."""
        if not self.original and other.original:
            self.original = other.original
        known = {match_key(alias) for alias in self.aliases}
        for alias in other.aliases:
            if match_key(alias) not in known:
                known.add(match_key(alias))
                self.aliases.append(alias)
        merged = sum(1 for block in other.blocks if not self.add(block))
        for title in other.related:
            if title not in self.related:
                self.related.append(title)
        return merged


def file_name(title: str) -> str:
    """A page file name from a concept title: characters a name can't hold become spaces."""
    cleaned = "".join(" " if char in FORBIDDEN_CHARACTERS else char for char in title)
    return " ".join(cleaned.split()).lstrip(".").strip()
