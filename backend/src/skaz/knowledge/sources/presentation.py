"""Export a verified presentation in a private directory, then discard the intermediate PDF."""

from __future__ import annotations

import io
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from pathlib import Path

from .pdf import PdfRejected

_EXPORT_KEYNOTE = """
on run argv
    set inputFile to POSIX file (item 1 of argv) as alias
    set outputFile to POSIX file (item 2 of argv)
    set stem to item 3 of argv
    tell application "Keynote"
        with timeout of 100 seconds
            set deck to open inputFile
            if deck is missing value then
                repeat 60 times
                    set matches to (every document whose name starts with stem)
                    if (count of matches) = 1 then
                        set deck to item 1 of matches
                        exit repeat
                    end if
                    delay 0.25
                end repeat
            end if
            if deck is missing value then error "Could not open the selected presentation."
            try
                export deck to outputFile as PDF with properties {export style:IndividualSlides, all stages:false, skipped slides:true}
            on error errMsg
                close deck saving no
                error errMsg
            end try
            close deck saving no
        end timeout
    end tell
end run
"""


def presentation_pdf(data: bytes, extension: str) -> bytes:
    if extension not in (".pptx", ".key"):
        raise PdfRejected("Unsupported presentation format.")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as deck:
            names = set(deck.namelist())
            valid = (
                "ppt/presentation.xml" in names
                if extension == ".pptx"
                else any(n.startswith("Index/") and n.endswith(".iwa") for n in names)
            )
            if not valid or sum(i.file_size for i in deck.infolist()) > 512 * 1024 * 1024:
                raise PdfRejected("This presentation is damaged or too large to open.")
    except zipfile.BadZipFile as err:
        raise PdfRejected("This file is not a readable presentation.") from err
    with tempfile.TemporaryDirectory(prefix="skaz-slides-") as work:
        root = Path(work)
        stem = f"SKAZ-{uuid.uuid4().hex}"
        source = root / (stem + extension)
        dest = source.with_suffix(".pdf")
        source.write_bytes(data)
        office = shutil.which("soffice") or shutil.which("libreoffice")
        if not office and Path("/Applications/LibreOffice.app/Contents/MacOS/soffice").is_file():
            office = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
        if extension == ".pptx" and office:
            command = [
                office,
                f"-env:UserInstallation={(root / 'profile').as_uri()}",
                "--headless",
                "--convert-to",
                "pdf",
                "--outdir",
                str(root),
                str(source),
            ]
        elif sys.platform == "darwin" and Path("/Applications/Keynote.app").is_dir():
            command = ["/usr/bin/osascript", "-e", _EXPORT_KEYNOTE, str(source), str(dest), stem]
        else:
            raise PdfRejected(
                "Open this presentation in Keynote or LibreOffice and export it as PDF for import."
            )
        try:
            subprocess.run(command, cwd=root, timeout=120, check=True, capture_output=True)
            if not dest.is_file() or not 0 < dest.stat().st_size <= 200 * 1024 * 1024:
                raise PdfRejected("The presentation could not be exported. Export it as PDF and try again.")
            return dest.read_bytes()
        except (subprocess.SubprocessError, OSError) as err:
            raise PdfRejected(
                "The presentation could not be exported. Export it as PDF and try again."
            ) from err
