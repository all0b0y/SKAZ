"""Opt-in real-data page benchmark; emits sizes/timings, never transcript text.

Run with backend/.venv/bin/python scripts/bench_native_event_pages.py --database
/path/to/an/already-made/copy.sqlite3. Makes its own SQLite backups in .runtime;
never mutates the input. Scale points are event-prefix fractions, not measured
historical wall-clock snapshots. Drafts are cleared (not recoverable historically).
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import statistics
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

from skaz.db import Database
from skaz.live_store import LiveStore
from skaz.native_event_pages import read_event_page
from skaz.native_page_projection import read_projected_page
from skaz.routes.sessions import _live_view


def measure(read: Callable[[], dict[str, Any]], repeats: int) -> dict[str, Any]:
    durations = []
    body = b""
    for _ in range(repeats):
        started = time.perf_counter()
        value = read()
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        durations.append((time.perf_counter() - started) * 1000)
    return {"bytes": len(body), "read_and_json_ms_median": round(statistics.median(durations), 3)}


def verify_history(db: Database, sid: str, store: LiveStore) -> dict[str, int | bool]:
    full = store.snapshot(sid)
    projection = full["live_translation_projection"]
    expected_original = {identity: turn["id"] for turn in projection["monologues"] for identity in turn["original_token_ids"]}
    expected_display = {identity: turn["id"] for turn in projection["monologues"] for identity in turn["display_token_ids"]}
    original, display = {}, {}
    pages = 0
    for connection in full["connections"]:
        cursor = -1
        while True:
            page = read_projected_page(db, sid, connection_id=connection["id"], after=cursor, limit=128)
            pages += 1
            for event in page["events"]:
                original.update({identity: owner["id"] for identity, owner in event["projection"]["owners"].items()})
                if not page["projection"]["available"]:
                    continue
                for ref in event["order"] or []:
                    if ref["translation_status"] == "none":
                        display[ref["id"]] = event["projection"]["owners"][ref["id"]]["id"]
                    elif ref["translation_status"] == "translation":
                        owner = page["projection"]["groups"][event["projection"]["translations"][ref["id"]]]
                        if owner:
                            display[ref["id"]] = owner["id"]
            if not page["has_newer"]:
                break
            assert page["next_after"] > cursor, "Page cursor did not advance"
            cursor = page["next_after"]
    assert original == expected_original, "Original ownership differs from full projection"
    assert display == expected_display, "Display ownership differs from full projection"
    return {"equivalent": True, "pages": pages, "original_tokens": len(original), "display_tokens": len(display)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = sqlite3.connect(f"{args.database.resolve().as_uri()}?mode=ro", uri=True)
    sessions = source.execute(
        "SELECT r.session_id,r.recording_mode,COUNT(*) FROM native_recordings r "
        "JOIN asr_connections c ON c.session_id=r.session_id "
        "JOIN native_asr_events e ON e.connection_id=c.id GROUP BY r.session_id HAVING COUNT(*)>1000"
    ).fetchall()
    if not sessions:
        raise SystemExit("No real long-recording fixtures found; no benchmark results produced.")
    scratch = Path(__file__).resolve().parents[1] / ".runtime"
    scratch.mkdir(exist_ok=True)
    results = []
    for sid, mode, total in sessions:
        for fraction in (1 / 6, .5, 1):
            keep = max(1, int(total * fraction))
            with tempfile.TemporaryDirectory(prefix="event-pages-", dir=scratch) as directory:
                path = Path(directory) / "copy.sqlite3"
                with sqlite3.connect(path) as destination:
                    source.backup(destination)
                db = Database(path)
                try:
                    with db.write() as c:
                        # Preparation only. The timed API does no OFFSET/whole-history scan.
                        c.execute("CREATE TEMP TABLE kept_events(connection_id TEXT,ordinal INTEGER)")
                        c.execute(
                            "INSERT INTO kept_events SELECT e.connection_id,e.ordinal "
                            "FROM native_asr_events e JOIN asr_connections c ON c.id=e.connection_id "
                            "WHERE c.session_id=? ORDER BY c.rowid,e.ordinal LIMIT ?", (sid, keep),
                        )
                        c.execute(
                            "DELETE FROM native_asr_events WHERE connection_id IN "
                            "(SELECT id FROM asr_connections WHERE session_id=?) AND "
                            "(connection_id,ordinal) NOT IN (SELECT * FROM kept_events)", (sid,),
                        )
                        c.execute(
                            "DELETE FROM asr_connections WHERE session_id=? AND id NOT IN "
                            "(SELECT connection_id FROM kept_events)", (sid,),
                        )
                        c.execute(
                            "UPDATE asr_connections SET next_event=(SELECT COALESCE(MAX(ordinal),-1)+1 "
                            "FROM native_asr_events WHERE connection_id=asr_connections.id),"
                            "draft_json='[]',translation_draft_json='[]',stream_draft_json='[]' "
                            "WHERE session_id=?", (sid,),
                        )
                    with db.write() as c:
                        for table in ("native_page_state", "native_page_groups", "native_page_events"):
                            c.execute(f"DELETE FROM {table} WHERE connection_id IN "
                                      "(SELECT id FROM asr_connections WHERE session_id=?)", (sid,))
                    cold_start = time.perf_counter()
                    read_projected_page(db, sid)
                    cold_ms = (time.perf_counter() - cold_start) * 1000
                    latest = read_event_page(db, sid)
                    cid, through = latest["connection"]["id"], latest["through"]
                    store = LiveStore(db, Path(directory) / "unused-audio")
                    result = {
                        "mode": mode, "event_prefix": keep, "fraction": round(fraction, 4),
                        "projection_cold_ms": round(cold_ms, 3),
                        "projected_latest_64": measure(lambda: read_projected_page(db, sid), 15),
                        "projected_delta_4": measure(lambda: read_projected_page(
                            db, sid, connection_id=cid, after=max(-1, through - 4)), 15),
                        "projected_unchanged": measure(lambda: read_projected_page(
                            db, sid, connection_id=cid, after=through), 15),
                        "legacy_full": measure(lambda: _live_view(store.snapshot(sid)), 3),
                        "latest_64": measure(lambda: read_event_page(db, sid), 15),
                        "delta_4": measure(lambda: read_event_page(
                            db, sid, connection_id=cid, after=max(-1, through - 4)), 15),
                        "unchanged": measure(lambda: read_event_page(
                            db, sid, connection_id=cid, after=through), 15),
                    }
                    result["history_verification"] = verify_history(db, sid, store)
                    results.append(result)
                    # Persist every scale point so a failed later run loses no evidence.
                    args.output.parent.mkdir(parents=True, exist_ok=True)
                    args.output.write_text(json.dumps(results, indent=2) + "\n")
                    print(json.dumps(result), flush=True)
                finally:
                    db.close()
    source.close()


if __name__ == "__main__":
    main()
