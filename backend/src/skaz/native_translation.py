"""Conservative final/live token links, not word alignment or translation completeness.

Only a contiguous original chunk belonging to one known speaker turn can own
its following translation chunk. Ambiguous and historical translations remain
unassigned rather than being zipped, timed, or attached by speaker identity.
"""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from itertools import groupby
from typing import Any


@dataclass
class Monologue:
    id: str
    connection_id: str
    speaker_number: int | None
    original_token_ids: list[str] = field(default_factory=list)
    translation_token_ids: list[str] = field(default_factory=list)
    passthrough_token_ids: list[str] = field(default_factory=list)
    display_token_ids: list[str] = field(default_factory=list)


def project_final_translation(
    originals: list[dict[str, Any]], translations: list[dict[str, Any]], stream: list[dict[str, Any]],
) -> dict[str, Any]:
    turns: list[Monologue] = []
    owners: dict[str, int] = {}
    originals_by_connection: dict[str, list[str]] = defaultdict(list)
    translations_by_connection: dict[str, list[str]] = defaultdict(list)
    stream_by_connection: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for token in originals:
        connection, speaker, identity = token["connection_id"], token["speaker_number"], token["id"]
        if not turns or turns[-1].connection_id != connection or turns[-1].speaker_number != speaker:
            turns.append(Monologue(identity, connection, speaker))
        turns[-1].original_token_ids.append(identity)
        owners[identity] = len(turns) - 1
        originals_by_connection[connection].append(identity)
    for token in translations:
        translations_by_connection[token["connection_id"]].append(token["id"])
    for token in stream:
        stream_by_connection[token["connection_id"]].append(token)

    assigned: set[str] = set()
    unavailable: list[str] = []
    for connection in dict.fromkeys([*originals_by_connection, *translations_by_connection]):
        original_ids = originals_by_connection[connection]
        ordered = stream_by_connection[connection]
        # A partial historic stream is not evidence for an entire connection.
        if ([t["id"] for t in ordered if t["translation_status"] != "translation"] != original_ids
                or [t["id"] for t in ordered if t["translation_status"] == "translation"]
                != translations_by_connection[connection]):
            unavailable.append(connection)
            continue
        candidates: set[int] = set()
        for status, group in groupby(ordered, key=lambda token: token["translation_status"]):
            chunk = list(group)
            if status == "original":
                candidates = {owners[token["id"]] for token in chunk}
            elif status == "none":
                candidates = set()
                for token in chunk:
                    turns[owners[token["id"]]].passthrough_token_ids.append(token["id"])
                    turns[owners[token["id"]]].display_token_ids.append(token["id"])
            else:
                if len(candidates) == 1:
                    turn = turns[next(iter(candidates))]
                    if turn.speaker_number is not None and all(
                        token["speaker_number"] == turn.speaker_number for token in chunk
                    ):
                        ids = [token["id"] for token in chunk]
                        turn.translation_token_ids.extend(ids)
                        turn.display_token_ids.extend(ids)
                        assigned.update(ids)
                candidates = set()
    return {
        "monologues": [asdict(turn) for turn in turns],
        "unassigned_translation_token_ids": [t["id"] for t in translations if t["id"] not in assigned],
        "order_unavailable_connection_ids": unavailable,
    }


def project_live_translation(
    originals: list[dict[str, Any]], translations: list[dict[str, Any]], stream: list[dict[str, Any]],
    connections: list[dict[str, Any]], speakers: list[dict[str, Any]], sample_rate: int,
) -> dict[str, Any]:
    """Read-only final prefix + replaceable tail per request, never new source IDs.

    Tail IDs are snapshot-local slots, not durable identities. Historical tails
    stay readable but cannot acquire mixed order by zipping independent arrays.
    """
    original_groups = _by_connection(originals)
    translation_groups = _by_connection(translations)
    stream_groups = _by_connection(stream)
    numbers = {(s["connection_id"], s["provider_id"]): s["number"] for s in speakers}
    live_originals: list[dict[str, Any]] = []
    live_translations: list[dict[str, Any]] = []
    live_stream: list[dict[str, Any]] = []
    for connection in connections:
        identity = connection["id"]
        original_tail = [{
            **token, "connection_id": identity,
            "speaker_number": numbers.get((identity, token.get("speaker"))),
        } for token in json.loads(connection["draft_json"])]
        translation_tail = json.loads(connection["translation_draft_json"])
        ordered_tail = json.loads(connection["stream_draft_json"])
        # Verify metadata as well as counts before assigning positional tail IDs.
        order_available = (
            [{k: v for k, v in token.items() if k != "translation_status"}
             for token in ordered_tail if token["translation_status"] != "translation"] == original_tail
            and [{k: v for k, v in token.items() if k != "translation_status"}
                 for token in ordered_tail if token["translation_status"] == "translation"]
            == translation_tail
        )
        projected_originals = [{
            **token, "id": f"{identity}:tail:original:{index}", "segment_id": None,
            "start_sample": connection["start_sample"] + token["start_ms"] * sample_rate // 1000,
            "end_sample": connection["start_sample"] + (token["end_ms"] * sample_rate + 999) // 1000,
        } for index, token in enumerate(original_tail)]
        projected_translations = [{
            **token, "id": f"{identity}:tail:translation:{index}",
        } for index, token in enumerate(translation_tail)]
        live_originals.extend([*original_groups[identity], *projected_originals])
        live_translations.extend([*translation_groups[identity], *projected_translations])
        live_stream.extend(stream_groups[identity])
        if order_available:
            iterators = {False: iter(projected_originals), True: iter(projected_translations)}
            for token in ordered_tail:
                status = token["translation_status"]
                live_stream.append({**next(iterators[status == "translation"]), "translation_status": status})
    return {
        **project_final_translation(live_originals, live_translations, live_stream),
        "original_tokens": live_originals, "translation_tokens": live_translations,
    }


def _by_connection(tokens: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for token in tokens:
        grouped[token["connection_id"]].append(token)
    return grouped
