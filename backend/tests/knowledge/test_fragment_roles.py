"""Display roles of fragments (user bug 1016-5): headings, list items, quotes and code survive extraction.

The role is set by the extractor, kept in the manifest and the index, and returned by the material
API. It never changes the fragment text (quotes are matched against the text).
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx

from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.markdown.source import (
    FragmentInput,
    FragmentMeta,
    Origin,
    number_fragments,
    read_source,
    render_source,
)
from skaz.knowledge.sources.fetch import SafeFetcher
from skaz.knowledge.sources.html import extract_article
from skaz.knowledge.sources.intake import prepare_text_file
from skaz.knowledge.sources.pdf import extract_pdf
from skaz.knowledge.store.schema import apply_schemas, core
from tests.knowledge.pdf_fixtures import line, make_pdf
from tests.knowledge.source_corpus import CLEAN_EN

LEAD = (
    "The heat equation describes how temperature spreads through a material over time. "
    "It is a partial differential equation of parabolic type, first studied by Fourier."
)
MIDDLE = (
    "Its solutions smooth out irregularities: sharp temperature differences fade, and the "
    "distribution approaches equilibrium as time goes on."
)
QUOTE = "Heat, like gravity, penetrates every substance of the universe; its rays occupy all parts of space."
CODE = "def step(u):\n    return u + k * laplacian(u)"

ARTICLE = (
    "<html><head><title>Heat equation</title></head><body><nav><a href='/'>Home</a></nav><article>"
    "<h1>Heat equation</h1>"
    f"<p>{LEAD}</p>"
    "<h2>Possible elements of an MVP:</h2>"
    "<ul><li>Project register</li><li>Risk <b>matrix</b> with owners</li></ul>"
    f"<blockquote><p>{QUOTE}</p></blockquote>"
    f"<h3>Numerical scheme</h3><p>{MIDDLE}</p>"
    f"<pre><code>{CODE}</code></pre>"
    "</article><footer>Copyright</footer></body></html>"
)
EXPECTED = [
    ("Heat equation", "heading", 1),
    (LEAD, "paragraph", None),
    ("Possible elements of an MVP:", "heading", 2),
    ("Project register", "list_item", None),
    ("Risk matrix with owners", "list_item", None),
    (QUOTE, "quote", None),
    ("Numerical scheme", "heading", 3),
    (MIDDLE, "paragraph", None),
    (CODE, "code", None),
]


def test_the_html_extractor_sets_roles_and_keeps_the_text() -> None:
    extraction = extract_article(ARTICLE)
    assert [(p.text, p.role, p.level) for p in extraction.paragraphs] == EXPECTED


def test_pdf_headings_by_size_and_bullets_as_list_items() -> None:
    content = (
        line("Study Objectives", 740, size=24)
        + line(CLEAN_EN[0], 700)
        + line("Overview", 660, size=18)
        + line("\u2022 Challenge traditional financial management primacy", 630)
        + line("\u2022 Deconstruct complex value tensions", 610)
        + line(CLEAN_EN[1], 560)
    )
    extraction = extract_pdf(make_pdf([content]))
    assert [(p.text, p.role, p.level) for p in extraction.paragraphs] == [
        ("Study Objectives", "heading", 1),
        (CLEAN_EN[0], "paragraph", None),
        ("Overview", "heading", 2),
        ("\u2022 Challenge traditional financial management primacy", "list_item", None),
        ("\u2022 Deconstruct complex value tensions", "list_item", None),
        (CLEAN_EN[1], "paragraph", None),
    ]


def test_roles_round_trip_through_the_manifest_and_old_manifests_read_as_paragraphs() -> None:
    fragments = number_fragments(
        [],
        [
            FragmentInput("Title", role="heading", level=2),
            FragmentInput("Body text."),
            FragmentInput("An item", role="list_item"),
        ],
    )
    metas = [FragmentMeta.of(fragment) for fragment in fragments]
    dumped = [meta.model_dump() for meta in metas]
    assert dumped[0]["role"] == "heading" and dumped[0]["level"] == 2
    assert "role" not in dumped[1] and "level" not in dumped[1]  # a paragraph's entry is as before
    assert dumped[2]["role"] == "list_item" and "level" not in dumped[2]
    reloaded = [FragmentMeta.model_validate(json.loads(json.dumps(item))) for item in dumped]
    text = render_source("mat-1", "web", fragments)
    assert [(f.text, f.role, f.level) for f in read_source(text, reloaded)] == [
        ("Title", "heading", 2),
        ("Body text.", "paragraph", None),
        ("An item", "list_item", None),
    ]
    old = FragmentMeta.model_validate({"id": "seg-1", "index": 0})
    assert [f.role for f in read_source(text, [old])] == ["paragraph"]


def test_an_index_before_roles_upgrades_and_its_rows_are_paragraphs(tmp_path: Path) -> None:
    connection = sqlite3.connect(tmp_path / "knowledge.sqlite3")
    v3 = SimpleNamespace(NAME="core", VERSION=3, SQL=core.SQL.replace(core.ROLE_COLUMNS, ""))
    apply_schemas(connection, [v3])
    connection.executescript(
        """
        INSERT INTO folders(id, name, rel_path, created_at) VALUES ('fld-1', 'Inbox', 'Inbox', 'now');
        INSERT INTO materials(id, folder_id, kind, status, title, rel_dir, source_file, created_at)
            VALUES ('mat-1', 'fld-1', 'web', 'ready', 'T', 'Inbox/T', 'Inbox/T/T.md', 'now');
        INSERT INTO fragments(material_id, seg, ordinal, text) VALUES ('mat-1', 1, 1, 'alpha');
        """
    )
    connection.commit()
    apply_schemas(connection, [core])
    connection.commit()
    assert connection.execute("SELECT text, role, level FROM fragments").fetchall() == [
        ("alpha", "paragraph", None)
    ]
    connection.close()


async def test_the_material_api_returns_the_roles(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})

    async def public(_host: str) -> list[str]:
        return ["93.184.216.34"]

    kb_app.state.runtime.kb_sources.fetcher = SafeFetcher(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, headers={"content-type": "text/html"}, text=ARTICLE)
        ),
        resolver=public,
    )
    created = await kb_client.post(
        "/kb/materials/link", json={"url": "https://blog.example/heat", "folder_id": INBOX_ID}
    )
    assert created.status_code == 201, created.text
    detail = (await kb_client.get(f"/kb/materials/{created.json()['material']['id']}")).json()
    assert [[f["text"], f["role"], f["level"]] for f in detail["fragments"]] == [
        list(item) for item in EXPECTED
    ]


LECTURE_MD = """# Thermodynamics lecture

Energy is conserved
in an isolated system, see [the notes](https://example.org/n).

## Terms

- heat
- **work**
- internal energy
  that a body holds

1. first law
2. second law

> The energy of the universe is constant.
> The entropy of the universe tends to a maximum.

```python
def q(m, c, dt):
    return m * c * dt

print(q(1, 2, 3))
```

| Quantity | Unit |
|---|:-:|
| Heat | J |
| Temperature | K |

---

The end.
"""


def test_a_markdown_file_gets_the_same_roles(tmp_path: Path) -> None:
    """QA B3: a ``.md`` material shows headings, list items, quotes, code and tables, not raw Markdown."""
    origin = Origin(type="file", file_name="lecture.md")
    prepared = prepare_text_file(LECTURE_MD.encode(), "lecture.md", origin=origin)
    got = [(item.text, item.role, item.level) for item in prepared.fragments]
    assert got == [
        ("Thermodynamics lecture", "heading", 1),
        ("Energy is conserved in an isolated system, see the notes.", "paragraph", None),
        ("Terms", "heading", 2),
        ("heat", "list_item", None),
        ("work", "list_item", None),
        ("internal energy that a body holds", "list_item", None),
        ("1. first law", "list_item", None),
        ("2. second law", "list_item", None),
        ("The energy of the universe is constant. The entropy of the universe tends to a maximum.",
         "quote", None),
        ("def q(m, c, dt):\n    return m * c * dt", "code", None),
        ("print(q(1, 2, 3))", "code", None),
        ("| Quantity | Unit |\n|---|:-:|\n| Heat | J |\n| Temperature | K |", "table", None),
        ("The end.", "paragraph", None),
    ]
    assert prepared.title == "Thermodynamics lecture"
    assert [item.index for item in prepared.fragments] == list(range(13))
    rendered = render_source("mat-1", "text", number_fragments([], prepared.fragments))
    metas = [FragmentMeta.of(item) for item in number_fragments([], prepared.fragments)]
    assert [item.role for item in read_source(rendered, metas)] == [item.role for item in prepared.fragments]


def test_a_text_file_stays_paragraphs() -> None:
    prepared = prepare_text_file(b"# not a heading\n\n- not a list", "a.txt", origin=Origin(type="file"))
    assert [(item.text, item.role) for item in prepared.fragments] == [
        ("# not a heading", "paragraph"), ("- not a list", "paragraph")]
