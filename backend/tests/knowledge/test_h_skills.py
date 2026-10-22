"""SKAZ's own skills folder (0.3.1 H): the pinned Humanizer copy, its catalog and its packaging.

Only files inside ``skaz/knowledge/skills`` count; a personal skill in a fake
home (``~/.claude/skills``, ``~/.codex/skills``, ``~/.hermes/skills``) is never seen.
"""
from __future__ import annotations

import hashlib
import os
import sys
import types
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge import skills

#: sha256 of ``SKILL.md`` / ``LICENSE`` of github.com/blader/humanizer tag v3.1.0
#: (commit 225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8), computed from the downloaded files.
PINNED_SKILL_SHA256 = "0612f1dfb1672b0ea9b97e139bf1f06cabe98d8b27424fe8ff01e1fb4cc99cad"
PINNED_LICENSE_SHA256 = "4ac4810254ab36d45419141aeb8e69bf50652cfafe5b2dab947d06d44e5cbf96"
PINNED_COMMIT = "225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8"
BACKEND = Path(__file__).resolve().parents[2]


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_the_catalog_holds_exactly_the_pinned_humanizer() -> None:
    catalog = skills.catalog()
    assert [skill.id for skill in catalog] == ["humanizer"]
    humanizer = skills.skill("humanizer")
    assert (humanizer.name, humanizer.version, humanizer.license) == ("Humanizer", "3.1.0", "MIT")
    assert humanizer.source_url == "https://github.com/blader/humanizer"
    assert humanizer.commit == PINNED_COMMIT
    assert humanizer.path == skills.SKILLS_DIR / "humanizer" / "SKILL.md"
    assert humanizer.path.is_file()


def test_the_vendored_files_are_the_pinned_ones_unchanged() -> None:
    folder = skills.SKILLS_DIR / "humanizer"
    assert _sha256(folder / "SKILL.md") == PINNED_SKILL_SHA256
    assert _sha256(folder / "LICENSE") == PINNED_LICENSE_SHA256
    assert "Copyright (c) 2025 Siqi Chen" in (folder / "LICENSE").read_text(encoding="utf-8")
    assert skills.skill("humanizer").text == (folder / "SKILL.md").read_text(encoding="utf-8")


def test_the_notice_names_source_tag_commit_and_license() -> None:
    notice = (skills.SKILLS_DIR / "humanizer" / "NOTICE").read_text(encoding="utf-8")
    for needle in ("https://github.com/blader/humanizer", "v3.1.0", PINNED_COMMIT, "MIT", "Siqi Chen"):
        assert needle in notice


def test_the_skill_file_agrees_with_the_catalog() -> None:
    """The front matter of the pinned file says the same name, version and license as the catalog."""
    head = skills.skill("humanizer").text.split("---", 2)[1]
    assert "name: humanizer" in head
    assert "license: MIT" in head
    assert 'version: "3.1.0"' in head


def test_an_unknown_skill_is_refused() -> None:
    with pytest.raises(skills.UnknownSkill):
        skills.skill("../humanizer")
    with pytest.raises(skills.UnknownSkill):
        skills.skill("personal")


def test_personal_skills_in_a_fake_home_are_invisible(tmp_path: Path,
                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    for folder in (".claude/skills", ".codex/skills", ".hermes/skills", ".agents/skills"):
        personal = home / folder / "humanizer"
        personal.mkdir(parents=True)
        (personal / "SKILL.md").write_text("---\nname: humanizer\n---\nPERSONAL SKILL TEXT\n",
                                           encoding="utf-8")
        other = home / folder / "personal-notes"
        other.mkdir(parents=True)
        (other / "SKILL.md").write_text("---\nname: personal-notes\n---\nPERSONAL\n", encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CODEX_HOME", str(home / ".codex"))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    skills.catalog.cache_clear()
    try:
        catalog = skills.catalog()
        assert [skill.id for skill in catalog] == ["humanizer"]
        assert "PERSONAL" not in catalog[0].text
        assert skills.SKILLS_DIR.resolve() in catalog[0].path.resolve().parents
    finally:
        skills.catalog.cache_clear()


# -- packaging --------------------------------------------------------------------------------


def _spec_datas(monkeypatch: pytest.MonkeyPatch, cwd: Path) -> list[tuple[str, str]]:
    """Run ``skaz-backend.spec`` with PyInstaller's names stubbed and return what it hands to ``Analysis``."""
    hooks = types.ModuleType("PyInstaller.utils.hooks")
    hooks.collect_data_files = lambda *a, **k: []  # type: ignore[attr-defined]
    hooks.collect_dynamic_libs = lambda *a, **k: []  # type: ignore[attr-defined]
    hooks.collect_submodules = lambda *a, **k: []  # type: ignore[attr-defined]
    for name in ("PyInstaller", "PyInstaller.utils"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "PyInstaller.utils.hooks", hooks)
    seen: dict[str, Any] = {}

    def analysis(*_args: Any, **kwargs: Any) -> Any:
        seen.update(kwargs)
        return types.SimpleNamespace(pure=[], scripts=[], binaries=[], datas=[])

    stub = lambda *a, **k: types.SimpleNamespace()  # noqa: E731
    namespace: dict[str, Any] = {"Analysis": analysis, "PYZ": stub, "EXE": stub, "COLLECT": stub,
                                 "SPECPATH": str(BACKEND), "__file__": str(BACKEND / "skaz-backend.spec")}
    monkeypatch.chdir(cwd)  # ``npm run build:backend`` runs from the repository root, not backend/
    code = (BACKEND / "skaz-backend.spec").read_text(encoding="utf-8")
    exec(compile(code, "skaz-backend.spec", "exec"), namespace)  # the repo's own build file
    return [(str(src), str(dest)) for src, dest in seen["datas"]]


def test_the_backend_build_ships_the_skill_files(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    datas = _spec_datas(monkeypatch, tmp_path)
    shipped = {(Path(src).resolve(), dest) for src, dest in datas}
    dest = os.path.join("skaz", "knowledge", "skills", "humanizer")
    for name in ("SKILL.md", "LICENSE", "NOTICE"):
        source = (skills.SKILLS_DIR / "humanizer" / name).resolve()
        assert (source, dest) in shipped, name
    # Every non-code file of the skills folder ships (a new skill can't be forgotten in the DMG).
    data_files = {path.resolve() for path in skills.SKILLS_DIR.rglob("*")
                  if path.is_file() and path.suffix not in (".py", ".pyc")
                  and "__pycache__" not in path.parts}
    assert data_files <= {src for src, _dest in shipped}
