"""Prepare synthetic ChatService replays, execute named subscription CLIs, and grade frozen responses.

Capture templates with the existing chat integration fixtures and SKAZ_CHAT_PROMPT_EXPORT /
SKAZ_ME_TEST_EXPORT. Keep the case manifest and its SHA-256 fixed throughout a comparison.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import tempfile
from pathlib import Path

from me_response_eval import MODELS, run

MANIFEST = Path(__file__).parent / "fixtures" / "chat-prompt-cases.json"
NOTICE = "⟦knowledge⟧"
NOTE = "No tools are connected in this synthetic session. The current message can include material fragments."
REF = re.compile(r"⟦m:([^:|⟧]+):(\d+)\|([^⟧]+)⟧")
SOURCE_ID = "mat-e7ab551de001"


def read(path):
    return json.loads(path.read_text())


def save(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


MATERIAL_ID = re.compile(r"mat-[0-9a-f]{12}")


def canonical(message):
    """Ignore only known changes to app framing when pairing old and new fixtures."""
    old = "A recording is in progress now; use skaz_recent_speech with its id for what was just said:"
    new = (
        "Background recording availability. Optional tool for a request about its "
        "recent speech: skaz_recent_speech."
    )
    message = message.replace(old, new)
    message = re.sub(r"<reply_check>.*?</reply_check>\n\n", "", message, flags=re.S)
    return re.sub(r"(?m)^Citation: ⟦m:[^\n]+⟧\n", "", message)


def pair_material_ids(current, original):
    def unique_ids(message):
        return dict.fromkeys(MATERIAL_ID.findall(canonical(message)))

    ids = dict(zip(unique_ids(current), unique_ids(original), strict=True))
    return MATERIAL_ID.sub(lambda match: ids[match[0]], current)


def prepare(templates, dest, cases, original):
    from skaz.knowledge.agents.prompting import untrusted_block
    from skaz.knowledge.chats.context import _fragment_line

    dest.mkdir(parents=True, exist_ok=True)
    for case in cases:
        key = case["id"]
        template = read(templates / (case.get("template", "knowledge") + ".json"))
        task = dict(template, case=key)
        if case.get("bare"):
            if template["message"] != template["prompt"] and template.get("case") == "bare":
                raise ValueError("Expected an unwrapped ChatService message")
            task.update(prompt=case["request"], message=case["request"], memory="")
        elif case["request"] is not None:
            prefix, label, _ = template["message"].rpartition("The user's message:\n")
            if not label:
                raise ValueError("Template must contain the application's user-message boundary")
            if fragments := case.get("fragments"):
                body = f"Material “Синтетический журнал” (id {SOURCE_ID}, kind text, status ready)\n"
                current_rendering = "<reply_check>" in prefix
                lines = [
                    _fragment_line(SOURCE_ID, i, None, None, None, text)
                    if current_rendering
                    else f"[{SOURCE_ID}:{i}] {text}"
                    for i, text in enumerate(fragments, 1)
                ]
                body += "\n".join(lines)
                context, boundary, reminder = prefix.partition("<reply_check>")
                prefix = (
                    context
                    + "The user attached this material to the question:\n"
                    + untrusted_block("attached material", body)
                    + "\n\n"
                    + boundary
                    + reminder
                )
                task["material"] = SOURCE_ID
            task.update(prompt=case["request"], message=prefix + label + case["request"])
        if original:
            first = read(original / (key + ".json"))
            paired = pair_material_ids(task["message"], first["message"])
            if (
                canonical(paired) != canonical(first["message"])
                or first["prompt"] != task["prompt"]
                or first["memory"] != task["memory"]
            ):
                raise ValueError(f"Unpaired evidence for {key}")
            task["message"] = paired
            if "material" in first:
                task["material"] = first["material"]
        target = dest / (key + ".json")
        if target.exists() and read(target) != task:
            raise ValueError(f"Different fixture already exists at {target}")
        save(target, task)
    print("Prepared", len(cases), "fixtures")


def matches(pattern, text):
    return re.search(pattern, text, re.I) is not None


def table_present(body, expected):
    cells = []
    for line in body.splitlines():
        if "|" in line and not re.fullmatch(r"[|:\s-]+", line):
            cells.append([c.strip() for c in line.strip().strip("|").split("|")])
    if len(cells) < 2 or not re.search(r"(?m)^\s*\|?\s*:?-{2,}[^\n]*\|", body):
        return False
    axes = cells + list(zip(*cells, strict=False))
    return all(
        any(all(any(matches(p, cell) for cell in row) for p in pair) for row in axes) for pair in expected
    )


def source_map(message):
    fragments = {}
    for line in message.splitlines():
        found = re.match(r"\[(mat-[\w-]+):(\d+)[^\]]*\]\s*(.*)", line)
        if found:
            fragments[found[1], int(found[2])] = found[3]
    return fragments


def assess(case, task, result):
    c = case["checks"]
    raw = result.get("answer", "").strip()
    body = raw.replace(NOTICE, "").strip()
    out = {
        "response": bool(
            body and result.get("exit") == 0 and not result.get("errors") and not result.get("tools")
        ),
        "no_internal_text": not re.search(
            r"PERSONAL-CANARY|</?(?:response_contract|me_reply_format|turn_context|answer_delivery)>", raw
        ),
    }
    if c.get("marker") == "first":
        out["notice"] = raw.startswith(NOTICE) and raw.count(NOTICE) == 1
    if "exact" in c:
        out["exact"] = body == c["exact"]
    if "json" in c:
        try:
            value = json.loads(body)
            out["json"] = json.dumps(value, sort_keys=True) == json.dumps(c["json"], sort_keys=True)
        except ValueError:
            out["json"] = False
    if c.get("paragraph") or c.get("one_sentence"):
        out["paragraph"] = not re.search(r"`{3}|(?m:^\s*(?:[-*]|\d+[.)])\s)|\n\s*\n|\|", body)
    if c.get("one_sentence"):
        out["sentence"] = len(re.findall(r"[.!?](?:\s|$)", body)) <= 1
    if pairs := c.get("table_rows"):
        out["table"] = table_present(body, pairs)
    if patterns := c.get("patterns"):
        out["content"] = all(matches(p, body) for p in patterns)
    if forbidden := c.get("forbid"):
        out["exclusions"] = not any(matches(p, body) for p in forbidden)
    if c.get("gap"):
        out["missing"] = (
            matches(r"не\s|нет\b|отсутств|неизвест|невозмож|недостат|не\s*указ", body) and NOTICE not in raw
        )
    refs = REF.findall(body)
    fragments = source_map(task["message"])
    if refs or "source" in c:
        cited = {(key, int(idx)) for key, idx, _ in refs}
        out["citation_integrity"] = len(refs) == body.count("⟦m:") and all(
            (key, int(idx)) in fragments
            and len(quote.strip()) >= 12
            and quote.strip() in fragments[key, int(idx)]
            for key, idx, quote in refs
        )
        if "source" in c:
            out["required_sources"] = NOTICE not in raw and cited == {
                (task["material"], idx) for idx in c["source"]
            }
    if "list_n" in c:
        items = re.findall(r"(?m)^\s*(\d+)[.)]\s+(.+)$", body)
        out["ordered"] = [int(i) for i, _ in items] == list(range(1, c["list_n"] + 1)) and all(
            matches(pattern, content) for pattern, (_, content) in zip(c["ordered"], items, strict=False)
        )
    if c.get("program"):
        blocks = re.findall(r"(?ms)^`{3}(\w+)\s*\n(.+?)^`{3}", body)

        def code_block(lang, code):
            if lang.lower() in ("text", "plaintext", "output", "markdown"):
                return False
            if lang.lower() in ("py", "python", "python3"):
                try:
                    return any(isinstance(n, ast.Call) for n in ast.walk(ast.parse(code)))
                except SyntaxError:
                    return False
            return bool(re.search(r"[\w.]+\s*\(", code))

        out["program"] = any(code_block(lang, code) for lang, code in blocks)
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "run", "score"])
    parser.add_argument("folder", type=Path)
    parser.add_argument("--templates", type=Path)
    parser.add_argument("--messages-from", type=Path)
    parser.add_argument("--model", choices=MODELS)
    parser.add_argument("--split", choices=["development", "qualification"])
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    args = parser.parse_args()
    cases = [c for c in read(args.manifest) if not args.split or c["split"] == args.split]
    if args.action == "prepare":
        if not args.templates:
            parser.error("prepare requires --templates")
        prepare(args.templates, args.folder, cases, args.messages_from)
        return
    if not args.model:
        parser.error("run and score require --model")
    results = []
    for c in cases:
        key = c["id"]
        target = args.folder / f"{args.model}-{key}.json"
        if args.action == "run" and not target.exists():
            with tempfile.TemporaryDirectory(prefix="skaz-universal-") as td:
                run(args.folder, args.model, key, Path(td), fixture_note=NOTE, grade_me_cases=False)
        if not target.exists():
            results.append({"id": key, "level": c["level"], "pass": False, "miss": ["missing"]})
            continue
        task, record = read(args.folder / (key + ".json")), read(target)
        expected_digest = hashlib.sha256(
            json.dumps([task["instructions"] + "\n\n" + NOTE, task["message"]], ensure_ascii=False).encode()
        ).hexdigest()
        checks = assess(c, task, record)
        checks["matching_input"] = (
            record.get("input_sha256") == expected_digest and record.get("model") == MODELS[args.model]
        )
        results.append(
            {
                "id": key,
                "level": c["level"],
                "pass": all(checks.values()),
                "miss": [k for k, v in checks.items() if not v],
            }
        )
    report = {
        "model": MODELS[args.model],
        "manifest_sha256": hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
        "cases": results,
    }
    name = f"scores-{args.model}-{args.split or 'all'}.json"
    save(args.folder / name, report)
    for level in ("simple", "complex"):
        group = [r for r in results if r["level"] == level]
        print(level, sum(r["pass"] for r in group), "/", len(group))


if __name__ == "__main__":
    main()
