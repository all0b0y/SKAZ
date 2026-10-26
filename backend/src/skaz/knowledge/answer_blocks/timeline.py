"""``timeline``: events in time order — dates, or moments of a recording (its timecodes)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from . import md
from .base import BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, envelope

MAX_EVENTS = 30


class TimelineEventIn(ItemIn):
    when: str | None = Field(
        default=None, min_length=1, max_length=40,
        description=("A date or period (\"1998\", \"March 2024\"). Leave it out for a moment of a recording: "
                     "the time is then taken from the cited fragment of the recording."))
    title: str = Field(min_length=1, max_length=200, description="What happened, in a few words.")
    text: str | None = Field(default=None, min_length=1, max_length=600,
                             description="Optional one or two sentences.")


class TimelineEnvelope(BlockIn):
    type: Literal["timeline"]
    events: list[Any] = Field(min_length=1, max_length=MAX_EVENTS)


class TimelineIn(TimelineEnvelope):
    events: list[TimelineEventIn] = Field(min_length=1, max_length=MAX_EVENTS,
                                          description="The events in time order.")


class KbTimelineEvent(KbBlockItem):
    #: ``null``: a moment of a recording — its time is the start of the first source (a recording fragment).
    when: str | None
    title: str
    text: str | None


class KbTimelineBlock(BaseModel):
    kind: Literal["timeline"]
    title: str | None
    events: list[KbTimelineEvent]


def build(data: dict[str, Any], items: Items) -> KbTimelineBlock:
    block = envelope(TimelineEnvelope, data)

    def timed_first(event: TimelineEventIn, src: list[int]) -> list[int] | None:
        if event.when is not None:
            return src
        timed = [index for index in src if items.checker.timed(index)]
        if not timed:
            return None  # neither a date nor a recording moment: nothing to place it by
        return [timed[0], *(index for index in src if index != timed[0])]

    events: list[KbTimelineEvent] = []
    for n, raw in enumerate(block.events, start=1):
        checked = items.item(TimelineEventIn, raw, f"e{n}", timed_first)
        if checked is not None:
            ids, event = checked
            events.append(KbTimelineEvent(**ids.out(), when=event.when, title=event.title, text=event.text))
    return KbTimelineBlock(kind="timeline", title=block.title, events=events)


def markdown(block: KbTimelineBlock, refs: md.Refs) -> list[str]:
    lines = md.title(block.title)
    for event in block.events:
        when = event.when or refs.time(event)
        body = f"**{md.text(event.title)}**" + (f": {md.text(event.text)}" if event.text else "")
        lines.append(f"- {md.text(when)} — {body}{refs.of(event)}" if when else f"- {body}{refs.of(event)}")
    return lines


SPEC = BlockSpec(
    name="timeline",
    when="events in time order: dates, or moments of a recording with their timecodes",
    schema=TimelineIn,
    example={
        "type": "timeline",
        "events": [
            {"when": "1998", "title": "Paxos published", "text": "Lamport's “The Part-Time Parliament”",
             "cite": "m:mat-4d5e6f:2"},
            {"title": "“Raft was designed to be understandable”", "text": "The lecturer on its origins",
             "cite": "m:mat-1a2b3c:41"},
        ],
    },
    build=build,
    markdown=markdown,
)
