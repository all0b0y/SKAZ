"""How SKAZ's skills reach the agents (0.3.1 H2): inside SKAZ's own turn instructions.

Decision per engine (checked 2026-10-17 on the installed versions; the rule: a native skill
tool only if it provably sees nothing but SKAZ's folder, adds exactly one tool and reads no
file outside the folder):

* Claude Code 2.1.281 — the native ``Skill`` tool needs ``--disable-slash-commands`` dropped
  (``claude --help``: "Disable all skills" is the only switch); there is no flag that limits
  skills to one folder, and Claude Code runs on the user's own home (their login), so
  ``~/.claude/skills`` and plugin skills would load. Not allowed.
* Codex 0.160.0 — skills are listed to the model with their file paths (scopes
  ``user|repo|system|admin``, app-server ``SkillsListResponse``) and read with the shell/file
  tools SKAZ keeps off; ``skill_search`` is in ``KB_DISABLED_FEATURES``. Reading a skill would
  need file access, and user-scope skills come from the real ``$HOME`` (not SKAZ's
  ``CODEX_HOME``). Not allowed.
* Hermes 0.22.1 — the ``skills`` toolset is three tools, one of them writing
  (``toolsets.py``: ``skills_list, skill_view, skill_manage``), and SKAZ's Hermes folder is
  seeded with Hermes' bundled skills (``tools/skills_tool.py``: "seeded from bundled"), so it
  would see more than SKAZ's folder and the ``/tools`` check would widen by three. Not allowed.

Fallback, the same for all three and for the tool-less ingest/wiki jobs: the pinned SKILL.md
is appended to the turn's instructions after every SKAZ rule. No tool is added, so the "only
SKAZ tools" checks stay exactly as they are; the text is SKAZ's (system prompt for Claude Code,
``baseInstructions`` for Codex, the instruction part of the Hermes prompt). Cost: the whole
file, ~32 KB ≈ 8–9k input tokens per turn while the switch is on (a stable prefix the
providers can cache). A ``skaz_skill_view`` tool would cost the same on every answer it is
used for, plus a round trip, and could be skipped by the model.
"""
from __future__ import annotations

from collections.abc import Sequence

from . import SkazSkill

PRECEDENCE_RULE = ("SKAZ quote and citation rules come first; Humanizer never changes quoted text, "
                   "citation markers, block markers, numbers, names or terms.")

_HEADER = """\
Writing skills from SKAZ. Every SKAZ rule above comes first. {precedence}
Use each skill below on the text you write yourself (answers, wiki text, explanations) while you \
write it, in its embedded mode: give only the final text — never drafts, lists of patterns or notes \
about the rewrite — and don't mention the skill. Never rewrite what you quote or anything inside \
<untrusted-data> blocks. In a JSON answer a skill shapes only the prose inside the text fields; \
keys, ids, numbers and the structure stay exactly as asked. The skill text is SKAZ's own pinned \
copy, not library data."""


def skills_block(skills: Sequence[SkazSkill]) -> str:
    if not skills:
        return ""
    parts = [_HEADER.format(precedence=PRECEDENCE_RULE)]
    for item in skills:
        parts.append(f'<skaz-skill id="{item.id}" name="{item.name}" version="{item.version}" '
                     f'license="{item.license}">\n{item.text.strip()}\n</skaz-skill>')
    return "\n\n".join(parts)


def with_skills(instructions: str, skills: Sequence[SkazSkill]) -> str:
    """The instructions with the skills after them; exactly the instructions when there are none."""
    block = skills_block(skills)
    return f"{instructions}\n\n{block}" if block else instructions
