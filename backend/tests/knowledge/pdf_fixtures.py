"""Small PDFs built in tests: raw content streams, a Helvetica font, optional images and metadata."""

from __future__ import annotations

from io import BytesIO

from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    TextStringObject,
)


def _image(writer: PdfWriter) -> object:
    image = DecodedStreamObject()
    image.set_data(b"\x80")
    image.update(
        {
            NameObject("/Type"): NameObject("/XObject"),
            NameObject("/Subtype"): NameObject("/Image"),
            NameObject("/Width"): NumberObject(1),
            NameObject("/Height"): NumberObject(1),
            NameObject("/ColorSpace"): NameObject("/DeviceGray"),
            NameObject("/BitsPerComponent"): NumberObject(8),
        }
    )
    return writer._add_object(image)


def make_pdf(
    pages: list[bytes],
    *,
    title: str | None = None,
    image: bool = False,
    forms: dict[str, bytes] | None = None,
) -> bytes:
    """One page per content stream. ``image`` adds ``/Im1`` (a 1×1 image) to every page's resources.
    """
    writer = PdfWriter()
    font = writer._add_object(
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
                NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
            }
        )
    )
    fonts = DictionaryObject({NameObject("/F1"): font})
    for content in pages:
        page = writer.add_blank_page(612, 792)
        xobjects = DictionaryObject()
        if image:
            xobjects[NameObject("/Im1")] = _image(writer)
        for name, form_content in (forms or {}).items():
            form = DecodedStreamObject()
            form.set_data(form_content)
            form.update(
                {
                    NameObject("/Type"): NameObject("/XObject"),
                    NameObject("/Subtype"): NameObject("/Form"),
                    NameObject("/BBox"): ArrayObject(
                        [NumberObject(0), NumberObject(0), NumberObject(612), NumberObject(792)]
                    ),
                    NameObject("/Resources"): DictionaryObject({NameObject("/Font"): fonts}),
                }
            )
            xobjects[NameObject(f"/{name}")] = writer._add_object(form)
        resources = DictionaryObject({NameObject("/Font"): fonts})
        if xobjects:
            resources[NameObject("/XObject")] = xobjects
        page[NameObject("/Resources")] = resources
        stream = DecodedStreamObject()
        stream.set_data(content)
        page[NameObject("/Contents")] = writer._add_object(stream)
    if title is not None:
        writer.add_metadata({"/Title": TextStringObject(title)})
    buffer = BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def line(text: str, y: int, *, size: int = 12, prefix: str = "", x: int = 72) -> bytes:
    """One text line; a ``prefix`` (state operators) is scoped with ``q … Q`` like real producers do."""
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    shown = f"BT /F1 {size} Tf {prefix} {x} {y} Td ({escaped}) Tj ET"
    return (f"q {shown} Q\n" if prefix else f"{shown}\n").encode("cp1252")



def word_by_word(blocks: list[tuple[int, list[str]]], *, spaces: bool = True, top: float = 72) -> bytes:
    """A page the way Google Docs / Chrome (Skia) write it: under a flipped (y-down) page matrix,
    each line is ``q … cm … Q`` and every word — and every space — is its own ``BT … ET`` with
    ``Tm`` + an absolute ``Td`` (user bug 1016-3: pypdf printed one word per line).

    ``blocks`` is ``(font size, lines)``; lines of one block are 1.4 × size apart, blocks 2 × size.
    Without ``spaces`` the words carry no space glyphs: only their positions keep them apart.
    """
    out = [b"1 0 0 -1 0 792 cm\n"]
    y = top

    def show(size: int, x: float, text: str) -> bytes:
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        place = f"1 0 0 -1 0 {size * 1.2:.4f} Tm\n{x:.4f} {-size * 0.9:.4f} Td"
        return f"BT\n/F1 {size} Tf\n{place} ({escaped}) Tj\nET\n".encode("cp1252")

    for size, lines in blocks:
        for text in lines:
            out.append(f"q\n.75 0 0 .75 72 {y:.4f} cm\n0 0 0 rg\n".encode())
            x = 0.0
            words = text.split(" ")
            for index, word in enumerate(words):
                out.append(show(size, x, word))
                x += 0.7 * size * len(word)  # wider than any Helvetica letter used: the gap only grows
                if index < len(words) - 1:
                    if spaces:
                        out.append(show(size, x, " "))
                    x += 0.3 * size
            out.append(b"Q\n")
            y += 1.4 * size
        y += 0.6 * size
    return b"".join(out)
