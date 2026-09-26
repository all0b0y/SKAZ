"""Incremental, disposable ownership index; never rewrites ASR or source text.

The reducer is the streaming equivalent of native_translation's groupby pass.
Only group summaries can change, so a page can resolve ownership on both sides
without loading a whole original/translation chunk or a long speaker turn.
"""
from __future__ import annotations

import copy
import json
import sqlite3
from typing import Any

from .db import Database
from .live_store import LiveConflict
from .native_event_pages import MAX_PAGE_BYTES, EventPageTooLarge, _size, read_event_page


def advance(
    state: dict[str, Any], originals: list[dict[str, Any]], translations: list[dict[str, Any]],
    order: list[dict[str, Any]], seed: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    owners: dict[str, Any] = {}
    for token in originals:
        turn = state.get("turn")
        if turn is None or turn["speaker_number"] != token["speaker_number"]:
            turn = {key: token[key] for key in ("id", "connection_id", "speaker_number", "start_sample")}
            state["turn"] = turn
        owners[token["id"]] = turn
    state["available"] &= [t["id"] for t in order if t["translation_status"] != "translation"] == [
        t["id"] for t in originals
    ] and [t["id"] for t in order if t["translation_status"] == "translation"] == [
        t["id"] for t in translations
    ]
    translated = {t["id"]: t for t in translations}
    references: dict[str, str] = {}
    passthrough = []
    changed: dict[str, Any] = {}
    for index, ref in enumerate(order):
        status, identity = ref["translation_status"], ref["id"]
        group = state.get("group")
        if group is None or group["status"] != status:
            target = (
                group["target"]
                if group and group["status"] == "original" and status == "translation"
                else None
            )
            group = {"id": f"{seed}:{index}", "status": status, "target": target, "seen": False}
            state["group"] = group
        if status == "original" and identity in owners:
            target = owners[identity]
            if not group["seen"]:
                group["target"] = target
            elif group["target"] != target:
                group["target"] = None
        elif status == "none":
            passthrough.append(identity)
        elif status == "translation" and identity in translated:
            target = group["target"]
            if (
                target is None
                or target["speaker_number"] is None
                or target["speaker_number"] != translated[identity]["speaker_number"]
            ):
                group["target"] = None
            references[identity] = group["id"]
        group["seen"] = True
        changed[group["id"]] = group["target"]
    return {"owners": owners, "translations": references, "passthrough": passthrough}, changed


def _state(c: sqlite3.Connection, cid: str) -> dict[str, Any]:
    row = c.execute("SELECT doc FROM native_page_state WHERE connection_id=?", (cid,)).fetchone()
    return json.loads(row["doc"]) if row else {"through": -1, "available": True, "turn": None, "group": None}


def ensure_index(db: Database, cid: str, through: int) -> None:
    # Old recordings backfill once, in bounded transactions. New reads process
    # only unseen committed events; they do not rescan a completed prefix.
    while True:
        with db.write() as c:
            state = _state(c, cid)
            if state["through"] >= through:
                return
            rows = c.execute(
                "SELECT e.ordinal,e.segment_ids,o.tokens_json AS originals,"
                "t.tokens_json AS translations,s.tokens_json AS stream "
                "FROM native_asr_events e LEFT JOIN native_token_events o USING(connection_id,ordinal) "
                "LEFT JOIN native_translation_events t USING(connection_id,ordinal) "
                "LEFT JOIN native_stream_events s USING(connection_id,ordinal) "
                "WHERE e.connection_id=? AND e.ordinal>? AND e.ordinal<=? ORDER BY e.ordinal LIMIT 256",
                (cid, state["through"], through),
            ).fetchall()
            if not rows:
                raise ValueError("Incomplete native event prefix.")
            for row in rows:
                originals = json.loads(row["originals"] or "[]")
                archived = []
                if row["originals"] is None:
                    state["available"] = False
                    rate = c.execute(
                        "SELECT r.sample_rate FROM native_recordings r JOIN asr_connections a "
                        "ON a.session_id=r.session_id WHERE a.id=?",
                        (cid,),
                    ).fetchone()[0]
                    for identity in json.loads(row["segment_ids"]):
                        segment = c.execute(
                            "SELECT id,text,start_ms,end_ms FROM segments WHERE id=?", (identity,)
                        ).fetchone()
                        if segment:
                            archived.append(
                                {
                                    "id": segment["id"],
                                    "segment_id": segment["id"],
                                    "connection_id": cid,
                                    "speaker_number": None,
                                    "text": segment["text"],
                                    "start_sample": round(segment["start_ms"] * rate / 1000),
                                    "end_sample": round(segment["end_ms"] * rate / 1000),
                                }
                            )
                    originals = archived
                translations = json.loads(row["translations"] or "[]")
                stream = json.loads(row["stream"] or "[]")
                meta, groups = advance(state, originals, translations, stream, f"{cid}:{row['ordinal']}")
                if archived:
                    meta["archive_originals"] = archived
                c.execute(
                    "INSERT INTO native_page_events VALUES (?,?,?)", (cid, row["ordinal"], json.dumps(meta))
                )
                for identity, target in groups.items():
                    c.execute(
                        "INSERT OR REPLACE INTO native_page_groups VALUES (?,?,?)",
                        (cid, identity, json.dumps(target)),
                    )
                state["through"] = row["ordinal"]
            c.execute("INSERT OR REPLACE INTO native_page_state VALUES (?,?)", (cid, json.dumps(state)))


def _tail(page: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    tail, connection = page["tail"], page["connection"]
    if not tail or not connection:
        return [], [], []
    cid, rate = connection["id"], page["sample_rate"]
    originals = [{**t, "connection_id": cid} for t in tail["originals"]]
    translations = tail["translations"]
    stream = tail["stream"]
    available = [
        {k: v for k, v in t.items() if k != "translation_status"}
        for t in stream
        if t["translation_status"] != "translation"
    ] == originals and [
        {k: v for k, v in t.items() if k != "translation_status"}
        for t in stream
        if t["translation_status"] == "translation"
    ] == translations
    originals = [
        {
            **t,
            "id": f"{cid}:tail:original:{i}",
            "segment_id": None,
            "start_sample": connection["start_sample"] + t["start_ms"] * rate // 1000,
            "end_sample": connection["start_sample"] + (t["end_ms"] * rate + 999) // 1000,
        }
        for i, t in enumerate(originals)
    ]
    translations = [{**t, "id": f"{cid}:tail:translation:{i}"} for i, t in enumerate(translations)]
    ordered = []
    if available:
        iterators = {False: iter(originals), True: iter(translations)}
        for token in stream:
            status = token["translation_status"]
            ordered.append(
                {"id": next(iterators[status == "translation"])["id"], "translation_status": status}
            )
    return originals, translations, ordered


def read_projected_page(db: Database, session_id: str, **query: Any) -> dict[str, Any]:
    source = query.pop("segment_id", None)
    if source is not None:
        # Explicit citation lookup only, not a polling path. JSON membership is
        # exact and scoped to the session; it never loads transcript text.
        with db.read() as c:
            location = c.execute(
                "SELECT e.connection_id,e.ordinal FROM asr_connections c "
                "JOIN native_asr_events e ON e.connection_id=c.id WHERE c.session_id=? "
                "AND EXISTS (SELECT 1 FROM json_each(e.segment_ids) WHERE value=?) LIMIT 1",
                (session_id, source),
            ).fetchone()
        if location is None:
            raise LiveConflict("Citation source is not present in this recording.")
        query.update(connection_id=location["connection_id"],
                     after=location["ordinal"] - 1, before=None)
    while True:
        page = read_event_page(db, session_id, **query)
        if not page["connection"]:
            page["projection"] = {"available": True, "groups": {}, "tail": None}
            return page
        cid = page["connection"]["id"]
        ensure_index(db, cid, page["through"])
        with db.read() as c:
            # Retry if ingestion advanced between the index and the page read.
            page = read_event_page(db, session_id, **query)
            if not page["connection"] or page["connection"]["id"] != cid:
                continue
            state = _state(c, cid)
            if state["through"] < page["through"]:
                continue
            groups: dict[str, Any] = {}
            for event in page["events"]:
                meta = c.execute(
                    "SELECT doc FROM native_page_events WHERE connection_id=? AND ordinal=?",
                    (cid, event["ordinal"]),
                ).fetchone()
                event["projection"] = json.loads(meta["doc"])
                if not event["originals_available"]:
                    event["originals"] = event["projection"].pop("archive_originals", [])
                for identity in event["projection"]["translations"].values():
                    if identity not in groups:
                        row = c.execute(
                            "SELECT target FROM native_page_groups WHERE connection_id=? AND id=?",
                            (cid, identity),
                        ).fetchone()
                        groups[identity] = json.loads(row["target"])
            # Publish the current group's final target even with zero new tokens:
            # the client may have it cached from an earlier page or draft.
            if state["group"]:
                groups[state["group"]["id"]] = state["group"]["target"]
            tail = None
            live_edge = read_event_page(db, session_id, connection_id=cid, after=page["through"])
            originals, translations, order = _tail(live_edge)
            state = copy.deepcopy(state)
            meta, changes = advance(state, originals, translations, order, f"{cid}:tail")
            if page["tail"] is not None:
                tail = {
                    "originals": originals,
                    "translations": translations,
                    "order": order,
                    "projection": meta,
                }
            page["projection"] = {
                "available": state["available"],
                "groups": groups,
                "tail_groups": changes,
                "tail": tail,
            }
            if _size(page) <= MAX_PAGE_BYTES - 128:
                return page
        # Ownership metadata counts against the same wire bound as the text.
        limit = query.get("limit", 64)
        if limit <= 1:
            raise EventPageTooLarge("Projected event exceeds the event-page byte limit.")
        query["limit"] = max(1, limit // 2)
