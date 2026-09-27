"""Session-local hybrid retrieval over an immutable original-speech snapshot.

SQLite stores only derived vectors, keyed by exact text + embedding space. No
library upload, background indexing, model selection, or silent lexical fallback.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
from dataclasses import dataclass
from decimal import Decimal
from typing import TYPE_CHECKING

from .. import monologues as mono
from ..db import Database
from ..gateways import ProviderError, ProviderNotConfigured, embedding, require_cloud_consent
from .scope import STOPWORDS

if TYPE_CHECKING:
    from ..runtime import Runtime


@dataclass(frozen=True)
class Window:
    digest: str
    text: str
    parent: int


class EmbeddingIndex:
    def __init__(self, db: Database) -> None:
        self.db = db
        with db.write() as connection:
            connection.execute("""CREATE TABLE IF NOT EXISTS ask_embeddings (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                space TEXT NOT NULL, digest TEXT NOT NULL, vector TEXT NOT NULL,
                PRIMARY KEY(session_id, space, digest)
            )""")

    def read(self, session_id: str, space: str) -> dict[str, list[float]]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT digest,vector FROM ask_embeddings WHERE session_id=? AND space=?",
                (session_id, space),
            ).fetchall()
        try:
            return {row["digest"]: embedding.normalized(json.loads(row["vector"])) for row in rows}
        except (ValueError, TypeError):
            raise ProviderError("Local embedding cache is invalid; no automatic paid rebuild.") from None

    def save(self, session_id: str, space: str, vectors: dict[str, list[float]]) -> None:
        with self.db.write() as connection:
            if not connection.execute("SELECT 1 FROM sessions WHERE id=?", (session_id,)).fetchone():
                raise ProviderNotConfigured("The session was deleted while embedding was running.")
            connection.execute("DELETE FROM ask_embeddings WHERE session_id=?", (session_id,))
            connection.executemany("INSERT INTO ask_embeddings VALUES (?,?,?,?)", [
                (session_id, space, digest, json.dumps(vector, allow_nan=False))
                for digest, vector in vectors.items()
            ])


def _windows(monologues: list[mono.Monologue]) -> list[Window]:
    # Unicode codepoints are at most four UTF-8 bytes: this is a conservative
    # input bound, not a tokenizer. Never truncate a coarse legacy monologue.
    result: list[Window] = []
    for index, monologue in enumerate(monologues):
        text = monologue.text
        for start in range(0, len(text), 1500):
            part = text[start:start + 1500]
            if part.strip():
                result.append(Window(hashlib.sha256(part.encode()).hexdigest(), part, index))
    return result


def _guard(runtime: Runtime, model: str, key: str, budget_usd: float | None) -> None:
    current = runtime.settings_store.load()
    require_cloud_consent("openrouter", current.cloud_consent, "original transcript and query for embeddings")
    if current.embedding.provider != "openrouter" or current.embedding.model != model:
        raise ProviderNotConfigured("Embedding settings changed; submit the question again.")
    if current.embedding_budget_usd != budget_usd:
        raise ProviderNotConfigured("Embedding limit changed; submit the question again.")
    if runtime.api_key("openrouter") != key:
        raise ProviderNotConfigured("OpenRouter credentials changed; submit the question again.")


async def retrieve(
    runtime: Runtime, session_id: str, monologues: list[mono.Monologue], query: str,
) -> list[mono.Monologue]:
    return await retrieve_many(runtime, {session_id: monologues}, query)


async def retrieve_many(
    runtime: Runtime, corpus: dict[str, list[mono.Monologue]], query: str,
) -> list[mono.Monologue]:
    monologues = [item for items in corpus.values() for item in items]
    settings = runtime.settings_store.load()
    budget_usd = settings.embedding_budget_usd
    model = settings.embedding.model
    key = runtime.api_key("openrouter")
    if not key:
        raise ProviderNotConfigured("Embedding requires the shared OpenRouter key in Settings.")
    _guard(runtime, model, key, budget_usd)
    if len(query.encode()) + len(embedding.QUERY_INSTRUCTION.encode()) > embedding.MAX_INPUT_BYTES:
        raise ProviderNotConfigured("Embedding query is too long; shorten the question.")
    if sum(len(item.text) for item in monologues) > 2_000_000:
        raise ProviderNotConfigured(
            "The selected scope exceeds the embedding index size limit; choose a smaller scope."
        )
    route = await embedding.endpoint(runtime.http, model, runtime.config.request_timeout_s)
    windows = _windows(monologues)
    cache = {digest: vector for sid in corpus
             for digest, vector in runtime.embedding_index.read(sid, route.space).items()}
    needed = {window.digest: window.text for window in windows if window.digest not in cache}
    upper = route.upper_bound(len(needed) + 1)
    if budget_usd is not None and Decimal(str(budget_usd)) < upper:
        raise ProviderNotConfigured(
            f"Embedding estimate is up to ${upper:f} for this question "
            f"({len(needed)} new text windows + query, model {model}, route {route.tag}). "
            "Change or disable the limit in Settings → Embedding. No transcript was sent."
        )
    # The whole operation is reserved conservatively before its FIRST text upload.
    # The optional saved limit applies per question, not cumulatively. No retries.
    entries = list(needed.items())
    for start in range(0, len(entries), embedding.BATCH_SIZE):
        _guard(runtime, model, key, budget_usd)
        batch = entries[start:start + embedding.BATCH_SIZE]
        vectors = await embedding.embed(
            runtime.http, route, [text for _, text in batch], "document", key=key,
            timeout=runtime.config.request_timeout_s,
        )
        cache.update({digest: vector for (digest, _), vector in zip(batch, vectors, strict=True)})
    _guard(runtime, model, key, budget_usd)
    active = {window.digest: cache[window.digest] for window in windows}
    if len({len(vector) for vector in active.values()}) > 1:
        raise ProviderError("Embedding dimensions changed across document batches.")
    # Keep successful indexing if the later query/answer fails: an explicit retry
    # must not pay to re-embed already validated documents.
    for sid, items in corpus.items():
        runtime.embedding_index.save(sid, route.space, {w.digest: active[w.digest] for w in _windows(items)})
    query_vector = (await embedding.embed(
        runtime.http, route, [query], "query", key=key, timeout=runtime.config.request_timeout_s,
    ))[0]
    if any(len(vector) != len(query_vector) for vector in active.values()):
        raise ProviderError("Embedding dimensions changed; refusing to mix vector spaces.")
    _guard(runtime, model, key, budget_usd)
    runtime.mark_verified("embedding", "openrouter", model, "Embedded original transcript and question")
    return await asyncio.to_thread(rank, monologues, windows, active, query_vector, query)


def rank(
    monologues: list[mono.Monologue], windows: list[Window], vectors: dict[str, list[float]],
    query_vector: list[float], query: str,
) -> list[mono.Monologue]:
    dense: dict[int, float] = {}
    for window in windows:
        score = sum(a * b for a, b in zip(vectors[window.digest], query_vector, strict=True))
        dense[window.parent] = max(dense.get(window.parent, -1.0), score)
    terms = set(re.findall(r"\w+", query.casefold())) - STOPWORDS
    lexical = {
        index: len(terms & set(re.findall(r"\w+", monologue.text.casefold())))
        for index, monologue in enumerate(monologues)
    }
    semantic = sorted(dense, key=lambda index: (-dense[index], index))
    exact = sorted((index for index in lexical if lexical[index]), key=lambda i: (-lexical[i], i))
    # Dense-first interleaving, not the equal-weight RRF that regressed the spike.
    # This candidate policy is mechanical; model relevance still needs real QA.
    selected: list[int] = []
    for position in range(max(len(semantic), len(exact))):
        for ranking in (semantic, exact):
            if position < len(ranking) and ranking[position] not in selected:
                selected.append(ranking[position])
                if len(selected) == 12:
                    return [monologues[index] for index in selected]
    return [monologues[index] for index in selected]
