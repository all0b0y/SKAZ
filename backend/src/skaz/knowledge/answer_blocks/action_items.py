"""``action_items``: what was agreed to be done — the task, who does it, by when, and where it was said."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from . import md
from .base import BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, envelope

MAX_TASKS = 20


class TaskIn(ItemIn):
    task: str = Field(min_length=1, max_length=300, description="What is to be done.")
    owner: str | None = Field(
        default=None, min_length=1, max_length=60,
        description="Who does it, as named in the source; left out when no one is named.")
    owner_is_you: bool = Field(default=False, description="true when it is the user's own task.")
    due: str | None = Field(
        default=None, min_length=1, max_length=40,
        description="When it is due, as said (\"by 3 November\"); left out when not said.")


class ActionItemsEnvelope(BlockIn):
    type: Literal["action_items"]
    tasks: list[Any] = Field(min_length=1, max_length=MAX_TASKS)


class ActionItemsIn(ActionItemsEnvelope):
    tasks: list[TaskIn] = Field(min_length=1, max_length=MAX_TASKS,
                                description="The tasks, each citing where in the recording it was agreed.")


class KbActionItem(KbBlockItem):
    task: str
    owner: str | None
    owner_is_you: bool
    due: str | None


class KbActionItemsBlock(BaseModel):
    kind: Literal["action_items"]
    title: str | None
    tasks: list[KbActionItem]


def build(data: dict[str, Any], items: Items) -> KbActionItemsBlock:
    block = envelope(ActionItemsEnvelope, data)
    tasks = [KbActionItem(**ids.out(), task=task.task, owner=task.owner, owner_is_you=task.owner_is_you,
                          due=task.due) for ids, task in items.many(TaskIn, block.tasks, "t")]
    return KbActionItemsBlock(kind="action_items", title=block.title, tasks=tasks)


def markdown(block: KbActionItemsBlock, refs: md.Refs) -> list[str]:
    lines = md.title(block.title)
    for task in block.tasks:
        owner = "You" if task.owner_is_you else md.text(task.owner) if task.owner else None
        meta = ", ".join(filter(None, [owner, f"due {md.text(task.due)}" if task.due else None]))
        lines.append(f"- [ ] {md.text(task.task)}" + (f" ({meta})" if meta else "") + refs.of(task))
    return lines


SPEC = BlockSpec(
    name="action_items",
    when="what was agreed to be done (meetings, seminars): task, who, by when, where it was said",
    schema=ActionItemsIn,
    example={
        "type": "action_items",
        "tasks": [
            {"task": "Implement leader election in the course Raft", "owner": "Anna", "due": "by 3 November",
             "cite": "m:mat-7c8d9e:12"},
            {"task": "Read the Raft paper", "owner_is_you": True, "due": "before seminar 4",
             "cite": "m:mat-7c8d9e:15"},
            {"task": "Prepare a split-vote test", "cite": "m:mat-7c8d9e:17"},
        ],
    },
    build=build,
    markdown=markdown,
)
