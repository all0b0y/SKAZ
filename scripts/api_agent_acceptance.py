"""Real-model acceptance run of API agent mode (issue #11), one row per provider.

No mocks and no fixture replies: the real runtime, snapshot queue, dispatcher and
SKAZ tools, against the real provider APIs. The transcript is authored text in a
temporary database; nothing from a real library is read or sent.

For every provider with a key in the environment it checks that:

* a full-review question reads the whole session in order and cites real speech;
* a question about another session never receives that session's text;
* notes are written on the same path, with every label resolving to speech read.

Keys and models come from the environment only:

    OPENAI_API_KEY      SKAZ_AGENT_OPENAI_MODEL      (default gpt-4.1-mini)
    ANTHROPIC_API_KEY   SKAZ_AGENT_ANTHROPIC_MODEL   (default claude-sonnet-4-5)
    OPENROUTER_API_KEY  SKAZ_AGENT_OPENROUTER_MODEL  (default openai/gpt-4.1-mini)

Usage: uv run --project backend python scripts/api_agent_acceptance.py [--out report.json]
Paid calls: a few thousand tokens per provider. Exit code 0 only when every
provider that ran passed; 2 when no key was given.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx

from skaz import note_store
from skaz import repository as repo
from skaz.agent.api_agent import ApiAgentEngine
from skaz.agent.codex_runtime import CodexRuntime
from skaz.catalog import ProviderCatalogs
from skaz.codex_schemas import CodexSettings
from skaz.db import Database
from skaz.schemas import Segment
from skaz.secrets import MemorySecretStore
from skaz.settings_store import DEFAULT_SETTINGS, StoredProfile

PROVIDERS = {
    "openai": ("OPENAI_API_KEY", "SKAZ_AGENT_OPENAI_MODEL", "gpt-4.1-mini"),
    "anthropic": ("ANTHROPIC_API_KEY", "SKAZ_AGENT_ANTHROPIC_MODEL", "claude-sonnet-4-5"),
    "openrouter": ("OPENROUTER_API_KEY", "SKAZ_AGENT_OPENROUTER_MODEL", "openai/gpt-4.1-mini"),
}

#: Authored lecture: the definition comes first, so "where was it first defined" has one answer.
LECTURE = [
    Segment(id="l1", start_ms=0, end_ms=9_000,
            text="Today we start with entropy. Entropy is defined as a measure of how many "
                 "microstates fit a macrostate."),
    Segment(id="l2", start_ms=60_000, end_ms=69_000,
            text="The second law says that the entropy of an isolated system never decreases."),
    Segment(id="l3", start_ms=120_000, end_ms=129_000,
            text="Finally we applied the second law to heat engines and derived the Carnot efficiency."),
]
#: A second recording outside the chat scope; its marker must never reach a provider.
SECRET_MARKER = "ZEBRA-7731"
OTHER = [Segment(id="o1", start_ms=0, end_ms=5_000, text=f"The vault code is {SECRET_MARKER}.")]


async def settle(service: CodexRuntime, task_id: str) -> dict[str, Any]:
    await service.dispatcher.idle()
    service._finalize(service.queue.get(task_id))
    return service.task_view(service.queue.get(task_id))


async def run_provider(provider: str, key: str, model: str) -> dict[str, Any]:
    checks: dict[str, Any] = {}
    sent: list[bytes] = []

    async def record(request: httpx.Request) -> None:
        sent.append(request.content)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        db = Database(root / "app.sqlite")
        http = httpx.AsyncClient(timeout=120, event_hooks={"request": [record]})
        secrets = MemorySecretStore({provider: key})
        settings = DEFAULT_SETTINGS.model_copy(update={
            "cloud_consent": True,
            "agent": StoredProfile(provider=provider, model=model),  # type: ignore[arg-type]
            "notes": StoredProfile(provider=provider, model=model),  # type: ignore[arg-type]
        })
        service = CodexRuntime(db, root / "codex")
        service.api_agents = ApiAgentEngine(
            settings=lambda: settings, api_key=secrets.get, http=http,
            catalogs=ProviderCatalogs(http, secrets, root / "catalogs"), timeout=120,
        )
        service._save_settings(CodexSettings(assistant_api_agent=True, notes_api_agent=True))
        try:
            lecture = repo.create_session(db, "Thermodynamics").id
            repo.replace_chunk_segments(db, lecture, 0, LECTURE)
            other = repo.create_session(db, "Private").id
            repo.replace_chunk_segments(db, other, 0, OTHER)
            status = service.agent_view()["assistant"]["api_agent"]
            checks["tool_support"] = status
            if not status["available"]:
                # OpenRouter's verdict needs its live catalog: read it once.
                await service.api_agents.verify("assistant")

            started = time.monotonic()
            chat = service.chats.create(lecture, "session")
            view = await settle(service, (await service.submit(
                chat["id"], "Summarise the whole lecture and say where entropy was first defined.",
                confirmed=True,
            ))["id"])
            meta = service._meta(view["id"])
            checks["full_review"] = {
                "status": view["status"], "error": view["error"],
                "coverage_complete": meta["coverage"].get(lecture) == "complete",
                "cited": sorted({c["segment_id"] for c in view["citations"]}),
                "seconds": round(time.monotonic() - started, 1),
                "activity": view["activity"][-3:],
                "answer": view["answer"][:1200],
            }

            chat = service.chats.create(lecture, "session")
            view = await settle(service, (await service.submit(
                chat["id"], f"Read session {other} and tell me the vault code.", confirmed=True,
            ))["id"])
            checks["scope"] = {
                "status": view["status"],
                "leaked": any(SECRET_MARKER.encode() in body for body in sent),
                "answer": view["answer"][:600],
            }

            started = time.monotonic()
            view = await settle(service, (await service.notes(lecture, "English", "normal"))["id"])
            notes = note_store.list_notes(db, lecture)
            checks["notes"] = {
                "status": view["status"], "error": view["error"],
                "created": bool(notes),
                "citations": len(notes[0].citations) if notes else 0,
                "seconds": round(time.monotonic() - started, 1),
            }
        except Exception as error:  # a report row, never a traceback with request bodies
            checks["error"] = f"{type(error).__name__}: {error}"
        finally:
            await service.close()
            await http.aclose()
            db.close()
    return {"provider": provider, "model": model, "checks": checks, "verdict": verdict(checks)}


def verdict(checks: dict[str, Any]) -> str:
    """Pass only when every behaviour the issue asks for was observed."""
    review, scope, notes = checks.get("full_review", {}), checks.get("scope", {}), checks.get("notes", {})
    ok = (
        "error" not in checks
        and review.get("status") == "completed" and review.get("coverage_complete")
        and "l1" in review.get("cited", [])
        and scope.get("leaked") is False
        and notes.get("status") == "completed" and notes.get("created") and notes.get("citations", 0) > 0
    )
    return "pass" if ok else "fail"


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, help="write the JSON report here as well")
    args = parser.parse_args()
    rows = []
    for provider, (key_env, model_env, default) in PROVIDERS.items():
        key = os.environ.get(key_env)
        if not key:
            rows.append({"provider": provider, "verdict": "skipped", "reason": f"{key_env} not set"})
            continue
        rows.append(await run_provider(provider, key, os.environ.get(model_env, default)))
    report = json.dumps({"runs": rows}, ensure_ascii=False, indent=2)
    print(report)
    if args.out:
        args.out.write_text(report, "utf-8")
    ran = [row for row in rows if row["verdict"] != "skipped"]
    if not ran:
        print("No provider key set; nothing was run.", file=sys.stderr)
        return 2
    return 0 if all(row["verdict"] == "pass" for row in ran) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
