"""C-17: the study service imports on its own, before anything imported ``skaz.knowledge.chats``."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "src"


def test_study_service_imports_first() -> None:
    env = {**os.environ, "PYTHONPATH": str(SRC)}
    done = subprocess.run(
        [sys.executable, "-c", "from skaz.knowledge.study.service import page_file_name"],
        env=env, capture_output=True, text=True, timeout=60, check=False)
    assert done.returncode == 0, done.stderr
