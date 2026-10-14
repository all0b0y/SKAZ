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
    """One page per content stream. ``image`` adds ``/Im1`` (a 1×1 image) to every page's resources."""
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
