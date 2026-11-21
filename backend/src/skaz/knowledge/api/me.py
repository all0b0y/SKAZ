"""``/kb/me``: the user's «Я» (Me) — skills, versions, restore and Undo of an agent's edit (N6).

Route contract: ``.dev/docs/backlog-2026-10-26/N6-ME-API.md``. Errors are the knowledge API shape
(``{"detail": "…", "code": "…"}``): 404 ``not_found``, 422 ``limit_exceeded`` / ``invalid``, 409
``builtin`` (rename / delete a built-in) and ``already_undone``. Texts never go to logs.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Callable, Coroutine
from typing import Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from ...native_io import disk_call
from ..chats.service import ChatService
from ..errors import KnowledgeError
from ..logsafe import error_note
from ..me import DESCRIPTION_MAX, SKILL_CAP, TITLE_MAX, MeError, MeNotFound, MeSkill, MeVersion
from ..me.access import legacy_retired, me_store
from ..me.graph import Area, EntryKind, GraphEntry, GraphState, GraphUnavailable, MeGraphStore, Origin
from ..me.observations import SHARED_CHAT, Family, Hypothesis
from ..me.policy import applies, classify, conflicting_instructions
from ..me.store import MeStore
from ..me.tools import mark_undone

log = logging.getLogger(__name__)

KbMeKind = Literal["profile", "how_to_work", "search", "skill"]
KbMeSource = Literal["agent", "user", "restore"]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KbMeSkill(BaseModel):
    #: ``profile`` | ``how-to-work`` | ``search`` | a user/agent slug (``^[a-z0-9-]{1,48}$``).
    id: str
    kind: KbMeKind
    builtin: bool
    title: str
    #: One line; shown in the agent's skill index.
    description: str
    enabled: bool
    #: Profile and How to work with me: in every chat prompt when enabled.
    always_on: bool
    chars: int
    #: 1400 profile, 2200 how-to-work, null otherwise.
    limit: int | None
    #: Current version (1-based; 0 = never written).
    version: int
    updated_at: str | None


class KbMe(BaseModel):
    #: Master switch: off = nothing of «Я» goes to any agent and its tools refuse.
    enabled: bool
    #: Built-ins first (profile, how-to-work, search), then the others by title.
    skills: list[KbMeSkill]


class KbMeSkillDetail(KbMeSkill):
    text: str


class KbMeVersion(BaseModel):
    version: int
    created_at: str
    source: KbMeSource
    #: Set when the agent wrote it in a chat.
    chat_id: str | None
    summary: str
    chars: int


class KbMeVersions(BaseModel):
    #: Newest first.
    versions: list[KbMeVersion]


class KbMeUpdate(_Request):
    enabled: bool | None = None
    title: str | None = Field(default=None, min_length=1, max_length=TITLE_MAX)
    description: str | None = Field(default=None, max_length=DESCRIPTION_MAX)
    text: str | None = Field(default=None, max_length=SKILL_CAP)


class KbMeCreate(_Request):
    title: str = Field(min_length=1, max_length=TITLE_MAX)
    description: str = Field(max_length=DESCRIPTION_MAX)
    text: str = Field(max_length=SKILL_CAP)


class KbMeSwitch(_Request):
    enabled: bool
    expected_revision: int | None = Field(default=None, ge=0)


class KbGraphMe(BaseModel):
    schema_version: Literal[2]
    status: Literal["ready", "migrating", "recovery_required"]
    revision: int
    enabled: bool
    personal: bool
    study: bool
    chat: bool


class KbGraphEntry(BaseModel):
    id: str
    revision: int
    text: str
    title: str | None
    description: str | None
    area: Area
    kind: EntryKind | Literal["observed"]
    origin: Origin | Literal["observed"]
    scoped: bool
    enabled: bool
    status: Literal["ready", "not_used", "needs_context", "shadow", "conflict"]
    created_at: str | None
    why: str


class KbGraphEntries(BaseModel):
    entries: list[KbGraphEntry]
    next_offset: int | None


class KbGraphHistory(BaseModel):
    versions: list[KbGraphEntry]


class KbGraphRevision(_Request):
    expected_revision: int = Field(ge=0)


class KbGraphCreate(KbGraphRevision):
    text: str = Field(min_length=1, max_length=SKILL_CAP)
    area: Area


class KbGraphUpdate(KbGraphRevision):
    text: str | None = Field(default=None, min_length=1, max_length=SKILL_CAP)
    area: Area | None = None
    enabled: bool | None = None


class KbGraphRestore(KbGraphRevision):
    revision: int = Field(ge=0)


class KbGraphLearning(KbGraphRevision):
    study: bool | None = None
    chat: bool | None = None
    personal: bool | None = None


class MeRoute(APIRoute):
    """«Я» errors become ``{"detail", "code"}`` JSON with their status."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def guarded(request: Request) -> Response:
            try:
                return await handler(request)
            except MeError as error:
                return JSONResponse(status_code=error.status_code,
                                    content={"detail": error.message, "code": error.code})
            except KnowledgeError as error:
                return JSONResponse(status_code=error.status_code, content={"detail": error.message})

        return guarded


router = APIRouter(prefix="/kb/me", tags=["kb"], route_class=MeRoute)


def get_me(request: Request) -> MeStore:
    runtime = request.app.state.runtime
    if runtime.kb_me_graph is not None or legacy_retired(runtime.kb):
        raise MeNotFound("This Me skill is no longer available.")
    return me_store(request.app.state.runtime.kb)


def get_chats(request: Request) -> ChatService:
    return cast(ChatService, request.app.state.runtime.kb_chats)


MeDep = Annotated[MeStore, Depends(get_me)]
ChatsDep = Annotated[ChatService, Depends(get_chats)]


def _graph(request: Request) -> MeGraphStore:
    graph = cast(MeGraphStore | None, request.app.state.runtime.kb_me_graph)
    if graph is None:
        raise MeNotFound("Me entries are not available for this profile.")
    return graph


GraphDep = Annotated[MeGraphStore, Depends(_graph)]


def _settings(state: GraphState) -> KbGraphMe:
    controls = state.controls
    return KbGraphMe(schema_version=2, status="ready", revision=state.revision, enabled=controls.enabled,
                     study=controls.study, chat=controls.chat, personal=controls.personal)


def _unready(status: Literal["migrating", "recovery_required"]) -> KbGraphMe:
    return KbGraphMe(schema_version=2, status=status, revision=0, enabled=False,
                     study=False, chat=False, personal=False)


async def _migrate(graph: MeGraphStore) -> bool:
    try:
        await disk_call(graph.open)
    except GraphUnavailable:
        return False
    return True


def _graph_entry(state: GraphState, entry: GraphEntry,
                 conflicts: dict[str, GraphEntry] | None = None) -> KbGraphEntry:
    status: Literal["ready", "not_used", "needs_context", "conflict"] = "ready"
    hidden_fact = entry.area == "personal" and not state.controls.personal
    if not state.controls.enabled or not entry.enabled or hidden_fact:
        status = "not_used"
    elif classify(entry) is None:
        status = "needs_context"
    if entry.origin == "agent" or entry.kind in ("procedure", "legacy_import"):
        why = "Imported from your previous Me."
    elif entry.source_ref is not None:
        why = "You gave this lasting instruction or fact in a chat."
    else:
        why = "You added this entry in Me."
    if status == "ready" and entry.kind == "instruction":
        other = (conflicting_instructions(state) if conflicts is None else conflicts).get(entry.id)
        if other is not None:
            status = "conflict"
            why += f" This conflicts with “{other.text}” in the same situation. Edit or disable either entry."
    if status == "needs_context":
        why += " SKAZ could not match this entry to a supported situation."
    return KbGraphEntry(
        id=entry.id, revision=entry.revision, text=entry.text, title=entry.title,
        description=entry.description,
        area=entry.area, kind=entry.kind, origin=entry.origin, scoped=entry.scope is not None,
        enabled=entry.enabled, status=status, created_at=entry.created_at, why=why,
    )


def _graph_pattern(state: GraphState, item: Hypothesis, admitted: frozenset[Family]) -> KbGraphEntry:
    study = item.family == "study_revision"
    enabled = item.id not in state.ledger.suppressed
    allowed = state.controls.enabled and (state.controls.study if study else state.controls.chat)
    text = ("Choosing an independent attempt during revision." if study
            else "Returning to a discussion’s original goal.")
    count = item.positive + item.negative
    if not count:
        why = "SKAZ hasn’t observed a comparable choice yet."
    elif study:
        why = (f"In {item.positive} of {count} observed choices you tried first "
               "when both options were available.")
    else:
        why = f"In {item.positive} of {count} observed turns you returned to the original question."
    why += f" Based on {item.sessions} separate discussions or sessions. {item.unknown} outcomes are unknown."
    status: Literal["ready", "not_used", "shadow"] = "not_used"
    if allowed and enabled:
        status = "ready" if applies(state, item, admitted) else "shadow"
    return KbGraphEntry(
        id=item.id, text=text, revision=item.revision, area="practice" if study else "chat",
        kind="observed", origin="observed", scoped=item.scope != SHARED_CHAT, enabled=enabled,
        status=status, created_at=None, why=why,
        title=None, description=None,
    )


def _reply_patterns(state: GraphState) -> dict[str, tuple[str, KbGraphEntry]]:
    rows = {}
    for name, counts in state.replies.counts().items():
        if not sum(counts[k] for k in ("confirmed", "continued", "corrected")):
            continue
        identity = "reply-" + hashlib.sha256(name.encode()).hexdigest()[:32]
        enabled = name not in state.replies.disabled
        active = enabled and state.controls.learning_epoch("chat") is not None
        retained = sum(state.replies.retained.get(name, {}).values())
        why = (f"Confirmed {counts['confirmed']}, continued without correction {counts['continued']}, "
               f"corrected {counts['corrected']}, unknown {counts['unknown']}. "
               "Continuation applies to the response as a whole.")
        if retained:
            why += f" {retained} anonymous outcomes from removed chats are included in these totals."
        searchable = any(name in item.outcomes() for item in state.replies.attempts.values())
        row = KbGraphEntry(id=identity, revision=state.revision, text=f"Responses using {name}.",
                           title=None, description=None, area="chat", kind="observed", origin="observed",
                           scoped=False, enabled=enabled,
                           status="ready" if active and searchable else "not_used",
                           created_at=None, why=why)
        rows[identity] = (name, row)
    return rows


def _skill(skill: MeSkill) -> KbMeSkill:
    return KbMeSkill(id=skill.id, kind=skill.kind, builtin=skill.builtin, title=skill.title,
                     description=skill.description, enabled=skill.enabled, always_on=skill.always_on,
                     chars=skill.chars, limit=skill.limit, version=skill.version, updated_at=skill.updated_at)


def _detail(skill: MeSkill) -> KbMeSkillDetail:
    return KbMeSkillDetail(**_skill(skill).model_dump(), text=skill.text)


def _version(item: MeVersion) -> KbMeVersion:
    return KbMeVersion(version=item.version, created_at=item.created_at, source=item.source,
                       chat_id=item.chat_id, summary=item.summary, chars=item.chars)


async def _sessions_follow(chats: ChatService) -> None:
    """Live agent sessions that hold a Profile / How to work with me the user just switched off or
    cleared (or «Я» itself) are dropped at once (decision 6); never fails the user's change."""
    try:
        await chats.drop_me_sessions()
    except Exception as error:
        log.error("Dropping the agent sessions that hold Me failed: %s", error_note(error))


async def _me(store: MeStore) -> KbMe:
    def read() -> KbMe:
        return KbMe(enabled=store.enabled(), skills=[_skill(skill) for skill in store.skills()])

    return await disk_call(read)


@router.get("")
async def read_me(request: Request) -> KbMe | KbGraphMe:
    runtime = request.app.state.runtime
    graph = cast(MeGraphStore | None, runtime.kb_me_graph)
    if graph is None:
        if legacy_retired(runtime.kb):
            return _unready("recovery_required")
        return await _me(get_me(request))
    migration = cast(asyncio.Task[bool] | None, runtime.kb_me_migration)
    if migration is not None and not migration.done():
        return _unready("migrating")
    if migration is None and await disk_call(graph.needs_migration):
        runtime.kb_me_migration = asyncio.create_task(_migrate(graph), name="me-graph-migration")
        return _unready("migrating")
    try:
        return _settings(await disk_call(graph.open))
    except GraphUnavailable:
        return _unready("recovery_required")


@router.put("")
async def switch_me(body: KbMeSwitch, request: Request, chats: ChatsDep) -> KbMe | KbGraphMe:
    """The master switch: applies from the next answer (a live session gets a note; one that holds the
    profile or How to work with me is dropped at once and the next answer seeds a new one)."""
    graph = cast(MeGraphStore | None, request.app.state.runtime.kb_me_graph)
    if graph is not None:
        if body.expected_revision is None:
            raise MeError("A Me revision is required.")
        state = await disk_call(graph.set_controls, body.expected_revision, enabled=body.enabled)
        await chats.drop_graph_sessions()
        return _settings(state)
    store = get_me(request)
    await disk_call(store.set_enabled, body.enabled)
    await _sessions_follow(chats)
    return await _me(store)


@router.get("/skills/{skill_id}")
async def read_skill(skill_id: str, store: MeDep) -> KbMeSkillDetail:
    return _detail(await disk_call(store.skill, skill_id))


@router.put("/skills/{skill_id}")
async def update_skill(skill_id: str, body: KbMeUpdate, store: MeDep, chats: ChatsDep) -> KbMeSkillDetail:
    """A text change is a new version (source ``user``); built-ins keep their titles (409)."""
    skill = await disk_call(store.update, skill_id, enabled=body.enabled, title=body.title,
                            description=body.description, text=body.text)
    await _sessions_follow(chats)
    return _detail(skill)


@router.post("/skills", status_code=201)
async def create_skill(body: KbMeCreate, store: MeDep) -> KbMeSkillDetail:
    return _detail(await disk_call(store.create, body.title, body.description, body.text))


@router.delete("/skills/{skill_id}", status_code=204)
async def delete_skill(skill_id: str, store: MeDep) -> Response:
    await disk_call(store.delete, skill_id)
    return Response(status_code=204)


@router.get("/skills/{skill_id}/versions")
async def read_versions(skill_id: str, store: MeDep) -> KbMeVersions:
    return KbMeVersions(versions=[_version(item) for item in await disk_call(store.versions, skill_id)])


@router.post("/skills/{skill_id}/versions/{version}/restore")
async def restore_version(skill_id: str, version: int, store: MeDep, chats: ChatsDep) -> KbMeSkillDetail:
    skill = await disk_call(store.restore, skill_id, version)
    await _sessions_follow(chats)
    return _detail(skill)


@router.post("/edits/{edit_id}/undo")
async def undo_edit(edit_id: str, request: Request, chats: ChatsDep) -> KbMeSkillDetail | KbGraphEntry:
    """Undo an agent's change: the skill goes back to the version before it; the chat chip says Undone."""
    graph = cast(MeGraphStore | None, request.app.state.runtime.kb_me_graph)
    if graph is not None:
        item = await disk_call(graph.undo, edit_id)
        state = await disk_call(graph.open)
        location = state.edits.get(edit_id)
        if location is not None:
            await chats.mark_graph_edit_undone(edit_id, location)
        await chats.drop_graph_sessions()
        return _graph_entry(state, item)
    skill, edit = await disk_call(get_me(request).undo, edit_id)
    await mark_undone(chats, edit)
    await _sessions_follow(chats)  # the session holds what the agent wrote: a cleared profile drops it
    return _detail(skill)


@router.get("/entries")
async def graph_entries(graph: GraphDep, offset: Annotated[int, Query(ge=0)] = 0,
                        limit: Annotated[int, Query(ge=1, le=100)] = 50) -> KbGraphEntries:
    state = await disk_call(graph.open)
    entries: list[GraphEntry | Hypothesis | KbGraphEntry] = [
        rows[-1] for rows in state.entries.values() if rows[-1].text and not rows[-1].deleted
    ]
    entries.extend(state.ledger.patterns.values())
    entries.extend(row for _, row in _reply_patterns(state).values())
    window = entries[offset:offset + limit]
    next_offset = offset + limit if offset + limit < len(entries) else None
    conflicts = conflicting_instructions(state)
    return KbGraphEntries(
        entries=[_graph_entry(state, item, conflicts) if isinstance(item, GraphEntry)
                 else _graph_pattern(state, item, graph.admitted) if isinstance(item, Hypothesis) else item
                 for item in window],
        next_offset=next_offset,
    )


@router.get("/entries/{entry_id}")
async def read_graph_entry(entry_id: str, graph: GraphDep) -> KbGraphEntry:
    state = await disk_call(graph.open)
    if entry_id.startswith("reply-") and (row := _reply_patterns(state).get(entry_id)):
        return row[1]
    if entry_id in state.ledger.patterns:
        return _graph_pattern(state, state.ledger.patterns[entry_id], graph.admitted)
    return _graph_entry(state, graph.current(state, entry_id))


@router.post("/entries", status_code=201)
async def create_graph_entry(body: KbGraphCreate, graph: GraphDep) -> KbGraphEntry:
    item = await disk_call(
        graph.create, text=body.text, area=body.area, expected_revision=body.expected_revision,
    )
    return _graph_entry(await disk_call(graph.open), item)


@router.patch("/entries/{entry_id}")
async def update_graph_entry(
    entry_id: str, body: KbGraphUpdate, graph: GraphDep, chats: ChatsDep,
) -> KbGraphEntry:
    state = await disk_call(graph.open)
    if entry_id.startswith("reply-") and (row := _reply_patterns(state).get(entry_id)):
        correction = body.text is not None and body.area == "chat" and body.enabled is None
        if not correction and (body.enabled is None or body.text is not None or body.area is not None):
            raise MeError("Choose a correction or change pattern access.")
        changed = await disk_call(graph.manage_reply, row[0], body.expected_revision,
                                  enabled=body.enabled, correction=body.text)
        await chats.drop_graph_sessions()
        if correction:
            return _graph_entry(changed, next(rows[-1] for rows in changed.entries.values()
                                              if rows[-1].revision == changed.revision))
        return _reply_patterns(changed)[entry_id][1]
    if entry_id in state.ledger.patterns:
        if body.text is not None and body.area is not None and body.enabled is None:
            item = await disk_call(graph.correct_pattern, entry_id, body.expected_revision,
                                   text=body.text, area=body.area)
            await chats.drop_graph_sessions()
            return _graph_entry(await disk_call(graph.open), item)
        if body.enabled is None or body.area is not None or body.text is not None:
            raise MeError("Choose a correction or change pattern access.")
        pattern = await disk_call(graph.set_pattern_enabled, entry_id, body.expected_revision, body.enabled)
        await chats.drop_graph_sessions()
        return _graph_pattern(await disk_call(graph.open), pattern, graph.admitted)
    item = await disk_call(graph.update, entry_id, body.expected_revision,
                           text=body.text, area=body.area, enabled=body.enabled)
    await chats.drop_graph_sessions()
    return _graph_entry(await disk_call(graph.open), item)


@router.delete("/entries/{entry_id}", status_code=204)
async def forget_graph_entry(entry_id: str, expected_revision: Annotated[int, Query(ge=0)],
                             graph: GraphDep, chats: ChatsDep) -> Response:
    state = await disk_call(graph.open)
    if entry_id.startswith("reply-") and (row := _reply_patterns(state).get(entry_id)):
        await disk_call(graph.manage_reply, row[0], expected_revision)
        await chats.drop_graph_sessions()
        return Response(status_code=204)
    forget = graph.forget_pattern if entry_id in state.ledger.patterns else graph.forget
    await disk_call(forget, entry_id, expected_revision)
    await chats.drop_graph_sessions()
    return Response(status_code=204)


@router.get("/entries/{entry_id}/history")
async def graph_history(entry_id: str, graph: GraphDep) -> KbGraphHistory:
    state = await disk_call(graph.open)
    if entry_id.startswith("reply-") and (row := _reply_patterns(state).get(entry_id)):
        return KbGraphHistory(versions=[row[1]])
    if entry_id in state.ledger.patterns:
        return KbGraphHistory(versions=[_graph_pattern(state, pattern, graph.admitted)
                                       for pattern in reversed(state.ledger.history.get(entry_id, ()))])
    graph.current(state, entry_id)
    return KbGraphHistory(versions=[_graph_entry(state, item) for item in reversed(state.entries[entry_id])
                                    if not item.deleted])


@router.post("/entries/{entry_id}/restore")
async def restore_graph_entry(entry_id: str, body: KbGraphRestore,
                              graph: GraphDep, chats: ChatsDep) -> KbGraphEntry:
    item = await disk_call(graph.restore, entry_id, body.expected_revision, body.revision)
    await chats.drop_graph_sessions()
    return _graph_entry(await disk_call(graph.open), item)


@router.put("/learning")
async def graph_learning(body: KbGraphLearning, graph: GraphDep, chats: ChatsDep) -> KbGraphMe:
    change = body.model_dump(exclude={"expected_revision"}, exclude_none=True)
    state = await disk_call(graph.set_controls, body.expected_revision, **change)
    await chats.drop_graph_sessions()
    return _settings(state)


@router.delete("/data")
async def erase_graph_data(expected_revision: Annotated[int, Query(ge=0)],
                           graph: GraphDep, chats: ChatsDep) -> KbGraphMe:
    state = await disk_call(graph.erase, expected_revision)
    await chats.drop_graph_sessions()
    return _settings(state)


@router.post("/retry")
async def retry_graph(graph: GraphDep) -> KbGraphMe:
    return _settings(await disk_call(graph.retry))
