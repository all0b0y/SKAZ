"""Frozen-binary entry point for the shipped backend.

PyInstaller runs the analysed script as ``__main__``, which breaks the relative
imports inside ``audiohelper/__main__.py``. Importing the package properly here
keeps the module layout untouched while giving PyInstaller a valid top-level
script.
"""

from __future__ import annotations

import multiprocessing
import sys

from audiohelper.__main__ import main

if __name__ == "__main__":
    # Frozen macOS builds must install the spawn guard before anything forks.
    multiprocessing.freeze_support()
    sys.exit(main())
