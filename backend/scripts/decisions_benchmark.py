#!/usr/bin/env python3
"""D1 spike gate: measure local decision models on the authored decision set (not part of pytest).

Runs every item of ``tests/knowledge/fixtures/decisions/{tune,heldout}.jsonl``
through the same code the product uses (``LlamaClient`` → ``llama-server``),
writes per-item results, then reports: thresholds chosen on the *tune* split
only, and on the *held-out* split accuracy on answered items, coverage, ECE
and latency p50/p95, per model × language × decision type.

Usage (from ``backend/``)::

    .venv/bin/python scripts/decisions_benchmark.py run --server <llama-server> \\
        --model <file.gguf> --mode labels|native --name <id> --out <results.json>
    .venv/bin/python scripts/decisions_benchmark.py report <results.json> [...]

Latency numbers depend on what else the machine is doing; they are only
comparable between runs made under the same load.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import platform
import socket
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from skaz.knowledge.agents.prompting import untrusted_block  # noqa: E402
from skaz.knowledge.decisions.labels import LETTERS  # noqa: E402
from skaz.knowledge.decisions.llama import LlamaClient  # noqa: E402
from skaz.knowledge.decisions.policy import top_probability  # noqa: E402
from skaz.knowledge.decisions.protocol import (  # noqa: E402
    ChoiceAnswer,
    ChoiceQuestion,
    Question,
    Undecided,
    YesNoAnswer,
    YesNoQuestion,
)

FIXTURES = ROOT / "tests" / "knowledge" / "fixtures" / "decisions"
TARGET_ACCURACY = 0.85
TARGET_COVERAGE = 0.60


def load_items() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for split in ("tune", "heldout"):
        with open(FIXTURES / f"{split}.jsonl", encoding="utf-8") as handle:
            items.extend(json.loads(line) for line in handle if line.strip())
    return items


def to_question(item: dict[str, Any]) -> Question:
    state = untrusted_block("material", item["state"])
    if item["primitive"] == "choice":
        return ChoiceQuestion(state=state, question=item["question"], options=tuple(item["options"]))
    return YesNoQuestion(state=state, question=item["question"])


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


async def wait_health(client: httpx.AsyncClient, base: str, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SystemExit(f"llama-server exited with {process.returncode}")
        try:
            if (await client.get(f"{base}/health", timeout=2)).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        await asyncio.sleep(0.5)
    raise SystemExit("llama-server did not become healthy")


async def check_labels(client: httpx.AsyncClient, base: str) -> dict[str, Any]:
    """Each label must be exactly one token for this model's tokenizer (with and without a leading space)."""
    report: dict[str, Any] = {}
    for label in [*LETTERS[:6], "yes", "no", *"0123456789"]:
        for text in (label, f" {label}"):
            body = (await client.post(f"{base}/tokenize", json={"content": text, "add_special": False,
                                                                  "with_pieces": True})).json()
            report[repr(text)] = len(body.get("tokens", []))
    return report


async def run(args: argparse.Namespace) -> None:
    items = load_items()
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    command = [args.server, "-m", args.model, "--host", "127.0.0.1", "--port", str(port), "--no-webui",
               "-np", "1", "-c", str(args.ctx), "-ngl", "999"]
    log = open(args.out + ".server.log", "wb")  # noqa: SIM115
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    results: list[dict[str, Any]] = []
    try:
        async with httpx.AsyncClient() as http:
            started = time.monotonic()
            await wait_health(http, base, process)
            load_s = time.monotonic() - started
            labels = await check_labels(http, base) if args.mode == "labels" else {}
            client = LlamaClient(http, timeout_s=120)
            # One warm-up question (not scored) so the first latency is not the Metal shader compile.
            await client.answer(base, [to_question(items[0])], mode=args.mode)
            for item in items:
                question = to_question(item)
                t0 = time.monotonic()
                answer = (await client.answer(base, [question], mode=args.mode))[0]
                latency_ms = (time.monotonic() - t0) * 1000
                results.append(score_item(item, answer, latency_ms))
                print(f"{item['id']:<14} {results[-1]['predicted']!s:<8} ok={results[-1]['correct']} "
                      f"p={results[-1]['p_top']} {latency_ms:.0f}ms", flush=True)
    finally:
        process.terminate()
        try:
            process.wait(10)
        except subprocess.TimeoutExpired:
            process.kill()
        log.close()
    payload = {
        "name": args.name, "model_file": Path(args.model).name, "mode": args.mode,
        "server": args.server, "machine": platform.machine(), "load_avg": os.getloadavg(),
        "load_s": round(load_s, 1), "label_tokens": labels, "results": results,
    }
    Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {args.out}")


def score_item(item: dict[str, Any], answer: Any, latency_ms: float) -> dict[str, Any]:
    row: dict[str, Any] = {key: item[key] for key in ("id", "split", "lang", "type", "primitive")}
    row["latency_ms"] = round(latency_ms, 1)
    if isinstance(answer, Undecided):
        row.update(predicted=None, correct=False, p_top=None, reason=answer.reason)
        return row
    p_top = top_probability(answer)
    if isinstance(answer, ChoiceAnswer):
        predicted: Any = item["options"].index(answer.option)
        correct = answer.option == item["answer"]
    else:
        assert isinstance(answer, YesNoAnswer)
        predicted = answer.p_yes >= 0.5
        correct = predicted == item["answer"]
        row["p_yes"] = round(answer.p_yes, 4)
    row.update(predicted=predicted, correct=correct, p_top=None if p_top is None else round(p_top, 4))
    return row


# ---------------------------------------------------------------------------------- report

def answered(rows: list[dict[str, Any]], threshold: float) -> list[dict[str, Any]]:
    return [row for row in rows if row["p_top"] is not None and row["p_top"] >= threshold]


def accuracy(rows: list[dict[str, Any]]) -> float | None:
    return sum(row["correct"] for row in rows) / len(rows) if rows else None


def ece(rows: list[dict[str, Any]], bins: int = 10) -> float | None:
    scored = [row for row in rows if row["p_top"] is not None]
    if not scored:
        return None
    total = 0.0
    for b in range(bins):
        low, high = b / bins, (b + 1) / bins
        in_bin = [r for r in scored if low <= r["p_top"] < high or (b == bins - 1 and r["p_top"] == 1.0)]
        if in_bin:
            confidence = statistics.fmean(r["p_top"] for r in in_bin)
            hit = statistics.fmean(1.0 if r["correct"] else 0.0 for r in in_bin)
            total += len(in_bin) / len(scored) * abs(confidence - hit)
    return total


def choose_threshold(rows: list[dict[str, Any]]) -> float | None:
    """Smallest threshold whose tune accuracy on answered items reaches the target (None = never)."""
    for step in range(0, 100):
        threshold = 0.5 + step * 0.005
        kept = answered(rows, threshold)
        if len(kept) >= 3 and (accuracy(kept) or 0) >= TARGET_ACCURACY:
            return round(threshold, 3)
    return None


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(q * len(ordered)) - 1))
    return ordered[index]


def fmt(value: float | None, pct: bool = True) -> str:
    if value is None:
        return "—"
    return f"{value * 100:.0f}%" if pct else f"{value:.3f}"


def report(paths: list[str]) -> None:
    for path in paths:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        rows = data["results"]
        tune = [r for r in rows if r["split"] == "tune"]
        held = [r for r in rows if r["split"] == "heldout"]
        print(f"\n## {data['name']} ({data['model_file']}, mode={data['mode']}, load_avg={data['load_avg']})")
        bad_labels = {k: v for k, v in data.get("label_tokens", {}).items() if v != 1}
        if data.get("label_tokens"):
            print(f"label tokens != 1: {bad_labels or 'none'}")
        thresholds = {prim: choose_threshold([r for r in tune if r["primitive"] == prim])
                      for prim in ("choice", "noul")}
        print(f"thresholds chosen on tune (target {TARGET_ACCURACY:.0%}): {thresholds}")
        print("| slice | n | acc@all | thr | coverage | acc@answered | ECE |")
        print("|---|---|---|---|---|---|---|")
        slices: list[tuple[str, list[dict[str, Any]]]] = [("held-out ALL", held)]
        for lang in ("ru", "en"):
            slices.append((f"held-out {lang}", [r for r in held if r["lang"] == lang]))
        for kind in ("place", "read", "merge", "link"):
            slices.append((f"held-out {kind}", [r for r in held if r["type"] == kind]))
        for lang in ("ru", "en"):
            for kind in ("place", "read", "merge", "link"):
                subset = [r for r in held if r["type"] == kind and r["lang"] == lang]
                slices.append((f"held-out {kind}/{lang}", subset))
        slices.append(("tune ALL", tune))
        for name, subset in slices:
            kept = [r for r in subset if thresholds[r["primitive"]] is not None
                    and r["p_top"] is not None and r["p_top"] >= thresholds[r["primitive"]]]
            coverage = len(kept) / len(subset) if subset else None
            thr = "/".join(str(thresholds[p]) for p in sorted({r["primitive"] for r in subset}))
            print(f"| {name} | {len(subset)} | {fmt(accuracy(subset))} | {thr} | {fmt(coverage)} | "
                  f"{fmt(accuracy(kept))} | {fmt(ece(subset), pct=False)} |")
        latencies = [r["latency_ms"] for r in rows]
        print(f"latency ms (all {len(latencies)} items, machine under parallel load — NOT comparable): "
              f"p50={percentile(latencies, 0.5):.0f} p95={percentile(latencies, 0.95):.0f}")
        undecided = [r for r in rows if r["predicted"] is None]
        if undecided:
            reasons = sorted({r["reason"] for r in undecided})
            print(f"undecided by the model itself: {len(undecided)} — {reasons}")
        # Held-out coverage/accuracy curve for transparency (not used to pick thresholds).
        for prim in ("choice", "noul"):
            subset = [r for r in held if r["primitive"] == prim]
            curve = []
            for threshold in (0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99):
                kept = answered(subset, threshold)
                curve.append(f"{threshold}:{fmt(len(kept) / len(subset))}/{fmt(accuracy(kept))}")
            print(f"held-out curve {prim} (thr:coverage/acc): " + "  ".join(curve))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--server", required=True)
    run_parser.add_argument("--model", required=True)
    run_parser.add_argument("--mode", choices=("labels", "native"), required=True)
    run_parser.add_argument("--name", required=True)
    run_parser.add_argument("--out", required=True)
    run_parser.add_argument("--ctx", type=int, default=4096)
    report_parser = sub.add_parser("report")
    report_parser.add_argument("paths", nargs="+")
    args = parser.parse_args()
    if args.command == "run":
        asyncio.run(run(args))
    else:
        report(args.paths)


if __name__ == "__main__":
    main()
