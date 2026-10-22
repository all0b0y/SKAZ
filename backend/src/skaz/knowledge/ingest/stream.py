"""Finished items of a streamed JSON answer, as soon as each one closes (C1-f).

The wiki answers are one JSON object with one array of items — ``{"sections": [...], "more": …}``
or ``{"concepts": [...], …}``. ``ItemStream`` follows the text as it arrives and returns the raw
JSON of every item of that array whose closing brace has arrived; anything before the first ``{``
(a code fence) is skipped. It never validates the item: the caller parses it as usual.
"""
from __future__ import annotations


class ItemStream:
    def __init__(self, key: str) -> None:
        self._key = key
        self._depth = 0
        self._in_string = False
        self._escape = False
        self._string: list[str] = []
        #: The last string closed at the top level, and the key it became after a ``:``.
        self._last_string: str | None = None
        self._key_now: str | None = None
        #: The wanted array is open: its objects (at depth 3) are the items.
        self._items_open = False
        self._item: list[str] | None = None

    def feed(self, text: str) -> list[str]:
        done: list[str] = []
        for char in text:
            item = self._item
            if item is not None:
                item.append(char)
            if self._in_string:
                if self._escape:
                    self._escape = False
                elif char == "\\":
                    self._escape = True
                elif char == '"':
                    self._in_string = False
                    if self._depth == 1:
                        self._last_string = "".join(self._string)
                elif self._depth == 1:
                    self._string.append(char)
                continue
            if char == '"':
                self._in_string = True
                self._string = []
            elif char in "{[":
                if self._depth == 0 and char != "{":
                    continue
                self._depth += 1
                if char == "[" and self._depth == 2 and self._key_now == self._key:
                    self._items_open = True
                elif char == "{" and self._depth == 3 and self._items_open and item is None:
                    self._item = ["{"]
            elif char in "}]":
                if self._depth == 0:
                    continue
                self._depth -= 1
                if char == "}" and self._depth == 2 and item is not None:
                    done.append("".join(item))
                    self._item = None
                elif char == "]" and self._depth == 1:
                    self._items_open = False
            elif char == ":" and self._depth == 1:
                self._key_now = self._last_string
            elif char == "," and self._depth == 1:
                self._key_now = None
        return done
