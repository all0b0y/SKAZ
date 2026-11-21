"""Replay a frozen synthetic SKAZ probe with one explicitly selected, signed-in CLI.

Run after exporting test_me_experience.py with SKAZ_ME_TEST_EXPORT. No tools are needed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from collections import Counter
from pathlib import Path

MODELS = {
    "codex": "gpt-6-luna",
    "opencode": "opencode-go/deepseek-v4.1-flash",
    "glm": "opencode-go/glm-5.3-flash",
    "mimo": "opencode-go/mimo-v2.6-flash",
    "hy4": "opencode-go/hy4-flash-free",
    "qwen": "opencode-go/qwen3.8-flash",
}
CASES = ("table", "steps", "code", "override", "unrelated", "cold")
NUMERIC = ("numeric_table", "numeric_steps", "numeric_code")
INSTRUCTIONS = ("Ответь непосредственно пользователю SKAZ на русском языке. Инструменты не требуются. "
                "Опыт в блоке SKAZ относится только к этой реплике. Учитывай текущую просьбу первой.")

HOLDOUT = ("stack_code", "stack_plain")


def grade(case: str, answer: str) -> dict[str, bool]:
    if case in HOLDOUT:
        low = answer.lower().replace("⟦knowledge⟧", "").strip()
        fenced = re.search(r"(?ms)^`{3}(?!text\b)\w+\s*\n[^\n]+.*?^`{3}", low)
        plain = not re.search(r"`{3}|(?m:^\s*(?:[-*]|\d+[.)])\s)|\n\s*\n|\|", low)
        return {"topic_screen": "стек" in low and "очеред" in low and "a" in low and "b" in low,
                "requested_or_learned_format": bool(fenced) if case == "stack_code" else plain,
                "no_private_marker": "PERSONAL-CANARY" not in answer}
    numeric = case.startswith("numeric_")
    case = case.removeprefix("numeric_")
    low = answer.lower()
    facts = (("медиан" in low and "средн" in low and
              any(w in low for w in ("серед", "цент", "пополам", "средин", "median", "50%", "половин",
                                      "посред", "среднег", "средних", "крайн", "выброс", "устойчив")))
             if case != "unrelated" else "базилик" in low)
    table = bool(re.search(r"(?m)^\s*\|?\s*:?-{2,}.*\|", answer))
    steps = len(re.findall(r"(?m)^\s*\d+[.)]\s+", answer)) >= 2
    code = bool(re.search(r"```(?:python|py)?\s*\n.*?\b(?:statistics|median|sorted|mean)\b", low, re.S))
    if case == "override":
        shape = not (table or steps or code) and len(re.findall(r"[.!?](?:\s|$)", answer.strip())) <= 1
    else:
        shape = {"table": table, "steps": steps, "code": code}.get(case, True)
    if numeric:
        facts = ("медиан" in low and "средн" in low and
                 all(re.search(rf"(?<!\d){n}(?!\d)", low) for n in (4, 6)))
    return {"topic_screen": facts, "requested_or_learned_format": shape,
            "no_private_marker": "PERSONAL-CANARY" not in answer}

def run(
    folder: Path, engine: str, case: str, work: Path, *,
    fixture_note: str = "This synthetic session has no tools or library sources. Answer from general knowledge.",
    grade_me_cases: bool = True,
) -> None:
    task = json.loads((folder / f"{case}.json").read_text())
    prompt = "\n\n".join(filter(None, (INSTRUCTIONS, task["memory"], task["prompt"])))
    env = dict(os.environ)
    system = task.get("instructions", "")
    if system:
        # Replay the two ChatService roles in separate CLI channels, with no library or tools.
        system += "\n\n" + fixture_note
        prompt = task["message"]
    if engine == "codex":
        cmd = ["codex", "--no-daemon", "exec", "--ignore-user-config", "--skip-git-repo-check", "--ephemeral",
               "--sandbox", "read-only", "--json", "-m", MODELS[engine], "-"]
        if system:
            path = work / "instructions.txt"
            path.write_text(system)
            cmd[3:3] = ["-c", "model_instructions_file=" + json.dumps(str(path))]
    else:
        config = {"permission": {"*": "deny"}, "mcp": {}, "share": "disabled"}
        if system:
            config["agent"] = {
                "skaz-eval": {"description": "SKAZ synthetic reply", "mode": "primary", "prompt": system,
                              "tools": {"*": False}, "permission": {"*": "deny"}},
                "title": {"disable": True}, "summary": {"disable": True},
            }
        env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
        cmd = ["opencode", "run", "--standalone", "--archived", "--format", "json", "-m", MODELS[engine], prompt]
        if system:
            cmd[2:2] = ["--agent", "skaz-eval"]
    start = time.monotonic()
    try:
        result = subprocess.run(cmd, cwd=work, env=env, capture_output=True, timeout=120, text=True,
                                input=prompt if engine == "codex" else None)
        events = []
        for line in result.stdout.splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
        parts = []
        errors = []
        tools_used = []
        usage: Counter[str] = Counter()
        for event in events:
            kind, item, part = event.get("type"), event.get("item", {}), event.get("part", {})
            if kind == "turn.completed":
                tokens = event.get("usage", {})
                usage.update({key: tokens[key] for key in ("input_tokens", "cached_input_tokens", "output_tokens")
                              if isinstance(tokens.get(key), int)})
            if kind == "step_finish" and isinstance(part.get("tokens"), dict):
                tokens = part["tokens"]
                cache = tokens.get("cache") or {}
                if isinstance(cache.get("read"), int):
                    usage["cached_input_tokens"] += cache["read"]
                if isinstance(cache.get("write"), int):
                    usage["cache_write_tokens"] += cache["write"]
                for key in ("input", "output"):
                    if isinstance(tokens.get(key), int):
                        usage["provider_" + key] += tokens[key]
            if kind == "item.completed" and item.get("type") == "agent_message":
                parts.append(item["text"])
            elif kind == "text" and part.get("text"):
                parts.append(part["text"])
            if kind in {"error", "turn.failed"}:
                errors.append(str(event.get("error", event.get("message", "")))[:500])
            if kind == "tool_use" or item.get("type") in {"command_execution", "mcp_tool_call"}:
                tools_used.append(str(part.get("tool") or item.get("type")))
        response = "\n".join(parts).strip()
        trusted = bool(response and not tools_used and result.returncode == 0 and not errors)
        record = {"exit": result.returncode, "usage": dict(usage), "errors": errors, "tools": tools_used, "answer": response,
                  "score": grade(case, response) if trusted and grade_me_cases else None}
        if not trusted and not errors:
            record["diagnostic"] = (result.stderr or result.stdout)[-1300:]
    except subprocess.TimeoutExpired:
        record = {"error": "CLI timed out after 120 s", "score": None}
    record.update(case=case, model=MODELS[engine], seconds=round(time.monotonic()-start, 2),
                  input_sha256=hashlib.sha256(json.dumps([system, prompt], ensure_ascii=False).encode()).hexdigest())
    (folder / f"{engine}-{case}.json").write_text(json.dumps(record, ensure_ascii=False, indent=2))
    print(case, record.get("score"), record.get("errors"), flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("engine", choices=MODELS)
    parser.add_argument("cases", nargs="*")
    args = parser.parse_args()
    selected = args.cases or CASES
    if not args.cases and any((args.folder / f"{name}.json").exists() for name in NUMERIC):
        selected = (*CASES, *NUMERIC)
    with tempfile.TemporaryDirectory(prefix="skaz-synthetic-model-") as sandbox:
        for name in selected:
            if name not in (*CASES, *NUMERIC, *HOLDOUT):
                parser.error("Unknown synthetic case")
            run(args.folder, args.engine, name, Path(sandbox))
