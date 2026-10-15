"""Settings → Privacy: what leaves this Mac, where to and when, under the current choices.

Built from the live settings (speech provider and cloud consent, the decision
layer, the agents, the library), never from a static list, so each line says
whether it happens now. No user text is shown here — only the kinds of data.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from ..agents.engine import EngineId
from ..agents.registry import ENGINE_IDS

if TYPE_CHECKING:  # pragma: no cover
    from ...runtime import Runtime


@dataclass(frozen=True)
class Flow:
    what: str
    where: str
    when: str
    enabled: bool


AGENT_DESTINATIONS: dict[EngineId, str] = {
    "codex": "Codex · OpenAI (your ChatGPT account)",
    "claude_code": "Claude Code · Anthropic (your Claude account)",
    "hermes": "Hermes Agent · the model provider you chose in Hermes",
}


async def privacy_flows(runtime: Runtime) -> list[Flow]:
    settings = runtime.settings_store.load()
    provider = settings.transcription_provider
    cloud = settings.cloud_consent
    decisions = runtime.kb_decisions.provider()
    default_engine = runtime.kb_agents.registry.default()
    wiki_engine = runtime.kb_ingest.settings().engine or default_engine
    root = runtime.kb.view().root
    flows = [
        Flow("Audio of recordings, imported media and dictation", "Soniox (cloud speech recognition)",
             "While recording, importing or dictating", provider == "soniox" and cloud),
        Flow("Audio of recordings, imported media and dictation", "OpenAI (cloud speech recognition)",
             "While recording or importing", provider == "openai" and cloud),
        Flow("Audio of recordings, imported media and dictation", "This Mac (Whisper)",
             "While recording, importing or dictating — nothing leaves this Mac",
             provider == "local-whisper"),
        Flow("Short questions about where new knowledge goes, with short excerpts", "OpenRouter · Jev",
             "While materials are added to the wiki", decisions == "openrouter_jev"),
        Flow("Short questions about where new knowledge goes, with short excerpts",
             "This Mac (the local decision model)", "While materials are added to the wiki — nothing leaves "
             "this Mac", decisions == "local"),
    ]
    for engine in ENGINE_IDS:
        flows.append(Flow(
            "Your questions, the chat so far and the library excerpts the agent reads",
            AGENT_DESTINATIONS[engine], "When you ask in a chat",
            engine == default_engine,
        ))
        flows.append(Flow(
            "Text of materials being added to the wiki", AGENT_DESTINATIONS[engine],
            "When a material is added to the wiki", engine == wiki_engine,
        ))
    flows += [
        Flow("The address of a link you add", "The website or video site of that link",
             "When you add a link (SKAZ downloads the page or the video's audio)", True),
        Flow("Library files: materials, wiki pages, translations",
             f"This Mac ({root})" if root else "This Mac (the library folder you choose)",
             "Always — the library is plain files on this Mac", True),
        Flow("The activity log (what ran, when, how long — never the text)", "This Mac",
             "Always", True),
    ]
    return flows
