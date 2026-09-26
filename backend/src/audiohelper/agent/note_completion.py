"""Multi-response note output: transport budgets must not become document budgets."""
from __future__ import annotations

from ..gateways import ProviderError
from ..gateways.chat import ChatGateway, ChatMessage, OutputTruncated

# Per-response transport allowance, not a target length for the document.
RESPONSE_TOKENS = 4096
# Operational runaway guards. Fail explicitly, never squeeze/truncate to fit.
MAX_PARTS = 64
MAX_DOCUMENT_CHARS = 200_000  # Same limit as editable Notes.
CONTINUE_MARKER = "<!-- SKAZ_NOTE_CONTINUE -->"
CONTINUE_REQUEST = (
    "Continue the SAME document exactly where your previous response ended. "
    "Return only the missing continuation, not a new version or repeated introduction/title. "
    "Keep all explanations and examples; do not compress the remaining material. "
    "Preserve source labels. Before finishing, check topic/example coverage and consistency "
    "against the sources you read."
)
MULTIPART_RULES = (
    "If this document needs several responses, stop at a section boundary and end with "
    + CONTINUE_MARKER + ". The application will request the next part automatically. "
    "Do not shorten the document to fit one response. Omit the marker only when finished."
)


def split_continuation(text: str) -> tuple[str, bool]:
    """Only a terminal control marker is protocol, never quoted source text."""
    stripped = text.rstrip()
    if stripped.endswith(CONTINUE_MARKER):
        return stripped[:-len(CONTINUE_MARKER)].rstrip() + "\n\n", True
    return text, False


def check_progress(parts: list[str], text: str) -> None:
    if not text.strip() or text.strip() in {part.strip() for part in parts}:
        raise ProviderError("The notes model made no progress. No incomplete note was saved.")
    if sum(map(len, parts)) + len(text) > MAX_DOCUMENT_CHARS:
        raise ProviderError("The note exceeds the editor's document capacity. No incomplete note was saved.")


async def complete_note(gateway: ChatGateway, messages: list[ChatMessage]) -> str:
    """Continue known truncation, on the chosen provider only; persist only after success."""
    history = [
        ChatMessage(m.role, m.content + "\n\n" + MULTIPART_RULES) if m.role == "system" else m
        for m in messages
    ]
    parts: list[str] = []
    for _ in range(MAX_PARTS):
        limited = False
        try:
            answer = await gateway.complete(history, max_tokens=RESPONSE_TOKENS)
        except OutputTruncated as error:
            answer, limited = error.partial, True
        text, more = split_continuation(answer)
        check_progress(parts, text)
        parts.append(text)
        if not limited and not more:
            return "".join(parts)
        history.extend([ChatMessage("assistant", answer), ChatMessage("user", CONTINUE_REQUEST)])
    raise ProviderError(
        "The notes model did not finish after multiple responses. No incomplete note was saved."
    )
