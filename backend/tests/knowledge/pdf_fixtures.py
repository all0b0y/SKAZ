"""Small PDFs built in tests: raw content streams, a Helvetica font, optional images and metadata."""

from __future__ import annotations

from io import BytesIO

from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    FloatObject,
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


GLYPH_SHIFT = 29


def _cid_font(writer: PdfWriter, *, mapped: bool) -> object:
    descriptor = writer._add_object(
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/FontDescriptor"),
                NameObject("/FontName"): NameObject("/ABCDEF+ArialMT"),
                NameObject("/Flags"): NumberObject(4),
                NameObject("/FontBBox"): ArrayObject([NumberObject(v) for v in (-665, -325, 2000, 1040)]),
                NameObject("/ItalicAngle"): NumberObject(0),
                NameObject("/Ascent"): NumberObject(905),
                NameObject("/Descent"): NumberObject(-212),
                NameObject("/CapHeight"): NumberObject(716),
                NameObject("/StemV"): NumberObject(80),
            }
        )
    )
    descendant = writer._add_object(
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/CIDFontType2"),
                NameObject("/BaseFont"): NameObject("/ABCDEF+ArialMT"),
                NameObject("/CIDSystemInfo"): DictionaryObject(
                    {
                        NameObject("/Registry"): TextStringObject("Adobe"),
                        NameObject("/Ordering"): TextStringObject("Identity"),
                        NameObject("/Supplement"): NumberObject(0),
                    }
                ),
                NameObject("/FontDescriptor"): descriptor,
                NameObject("/CIDToGIDMap"): NameObject("/Identity"),
                NameObject("/DW"): NumberObject(556),
            }
        )
    )
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type0"),
            NameObject("/BaseFont"): NameObject("/ABCDEF+ArialMT"),
            NameObject("/Encoding"): NameObject("/Identity-H"),
            NameObject("/DescendantFonts"): ArrayObject([descendant]),
        }
    )
    if mapped:
        ranges = f"<0003> <00e2> <{0x0003 + GLYPH_SHIFT:04x}>"
        cmap = DecodedStreamObject()
        cmap.set_data(
            (
                "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
                "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
                "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
                f"0 beginbfrange\nendbfrange\n1 beginbfrange\n{ranges}\nendbfrange\n"
                "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
            ).encode()
        )
        font[NameObject("/ToUnicode")] = writer._add_object(cmap)
    return writer._add_object(font)


def glyph_line(
    text: str, y: int, *, size: int = 12, prefix: str = "", codes: list[int] | None = None
) -> bytes:
    """A line in ``/F2`` as a literal string of two-byte glyph codes (Unicode − 29, or ``codes``)."""
    numbers = codes if codes is not None else [ord(char) - GLYPH_SHIFT for char in text]
    raw = b"".join(number.to_bytes(2, "big") for number in numbers)
    literal = raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
    body = b"BT /F2 %d Tf %s 72 %d Td (" % (size, prefix.encode(), y) + literal + b") Tj ET"
    return (b"q " + body + b" Q\n") if prefix else body + b"\n"


def make_pdf(
    pages: list[bytes],
    *,
    title: str | None = None,
    image: bool = False,
    forms: dict[str, bytes] | None = None,
    cid_font: str | None = None,
    alphas: dict[str, float] | None = None,
) -> bytes:
    """One page per content stream. ``image`` adds ``/Im1`` (a 1×1 image) to every page's resources.

    ``cid_font`` adds ``/F2``, a two-byte (Identity-H) TrueType font whose codes are glyph numbers
    = Unicode − 29, like a subset Arial: ``"mapped"`` with a ToUnicode map, ``"unmapped"`` without
    one (what such a font prints without its map is the user's "+6(8QLYHUVLW\\" for "HSE University").
    ``alphas`` adds graphics states ``/<name>`` with that fill and stroke alpha (``/ca``, ``/CA``).
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
    if cid_font is not None:
        fonts[NameObject("/F2")] = _cid_font(writer, mapped=cid_font == "mapped")
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
        if alphas:
            resources[NameObject("/ExtGState")] = DictionaryObject(
                {
                    NameObject(f"/{name}"): DictionaryObject(
                        {NameObject("/ca"): FloatObject(alpha), NameObject("/CA"): FloatObject(alpha)}
                    )
                    for name, alpha in alphas.items()
                }
            )
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


def rect(
    color: str, x: float = 0, y: float = 0, width: float = 612, height: float = 792, *, prefix: str = ""
) -> bytes:
    """A filled rectangle (``color`` is a fill operator such as ``"0 0 0.3 rg"``), scoped with ``q … Q``."""
    return f"q {prefix} {color} {x} {y} {width} {height} re f Q\n".encode()


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
