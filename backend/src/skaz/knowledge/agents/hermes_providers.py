"""Hermes providers in SKAZ's own Hermes folder (decisions K1, K3; 2026-10-18 Q2/Q3/Q13).

SKAZ never sees a key or a sign-in. Adding a provider (and signing in again) opens Hermes' own
``hermes auth add <provider> --type oauth|api-key`` in Terminal, with ``HERMES_HOME`` = SKAZ's
folder: the user types the key or finishes the browser sign-in in Hermes itself. SKAZ then reads
what Hermes keeps with ``hermes auth list`` (text: labels, types, ids, priorities and exhaustion
status — never a secret) and the order Hermes tries providers in with ``hermes config get``.
Removing a credential and changing its priority carry no secret, so SKAZ runs ``hermes auth
remove`` / ``hermes auth priority`` itself. The order *between* providers (main provider, then
the fallback chain) stays Hermes' own setting: "Open Hermes setup" runs ``hermes fallback`` in
Terminal; SKAZ never edits Hermes' configuration.

Contract checked against the Hermes source (github.com/NousResearch/hermes-agent) at tags
v2026.9.24 (0.21.5), v0.22.1, v0.22.2 and main a2ad0d5 (2026-10-18), read only — no Hermes was run:
``hermes_cli/subcommands/auth.py`` (``add/list/remove/priority``), ``hermes_cli/auth_commands.py``
``auth_list_command`` (row ``  #<n>  <label:<20> <auth_type:<7> id=<id> priority=<p> <source><status> <←>``,
``_format_exhausted_status``), ``hermes_cli/subcommands/config.py`` (``config get <key> --json``)
and ``hermes_cli/fallback_config.py`` (``fallback_providers`` then legacy ``fallback_model``).
"""
from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal

ProviderGroup = Literal["subscription", "api_key", "cloud"]
CredentialState = Literal["ready", "limited", "signed_out", "error"]

#: When this catalog was last checked against Hermes' provider registry, and against what.
CATALOG_CHECKED = "2026-10-18 · Hermes v0.22.2 and main a2ad0d5"


@dataclass(frozen=True)
class CatalogProvider:
    """One way to connect a Hermes provider (a provider with both appears in two groups)."""

    id: str
    name: str
    group: ProviderGroup
    #: Search words besides the name (aliases Hermes accepts, brand names).
    keywords: str = ""


def _sub(id_: str, name: str, keywords: str = "") -> CatalogProvider:
    return CatalogProvider(id_, name, "subscription", keywords)


def _key(id_: str, name: str, keywords: str = "") -> CatalogProvider:
    return CatalogProvider(id_, name, "api_key", keywords)


#: Hermes' providers SKAZ offers to add. Sign-in providers are Hermes' ``_OAUTH_DEFAULT_PROVIDERS``
#: (``hermes auth add <id> --type oauth``); API-key providers are its ``api_key`` registry rows and
#: model-provider plugins (``hermes auth add <id> --type api-key``); cloud platforms have no pooled
#: credential and are set up in ``hermes model``. Anything else: "Other provider…" (``hermes auth``).
CATALOG: tuple[CatalogProvider, ...] = (
    _sub("openai-codex", "ChatGPT or Codex subscription", "openai chatgpt codex plus pro"),
    _sub("anthropic", "Claude subscription", "anthropic claude pro max"),
    _sub("nous", "Nous Portal", "nous research hermes"),
    _sub("xai-oauth", "xAI Grok (SuperGrok / Premium+)", "grok x supergrok"),
    _sub("qwen-oauth", "Qwen Code", "qwen alibaba"),
    _sub("minimax-oauth", "MiniMax", "minimax"),
    _key("openrouter", "OpenRouter", "or many models"),
    _key("openai-api", "OpenAI API", "openai gpt platform"),
    _key("anthropic", "Anthropic API", "claude console"),
    _key("gemini", "Google AI Studio", "google gemini"),
    _key("deepseek", "DeepSeek"),
    _key("xai", "xAI", "grok"),
    _key("zai", "Z.AI (GLM)", "glm zhipu"),
    _key("kimi-coding", "Kimi / Moonshot", "moonshot kimi"),
    _key("kimi-coding-cn", "Kimi / Moonshot (China)", "moonshot kimi china"),
    _key("minimax", "MiniMax API"),
    _key("minimax-cn", "MiniMax (China)"),
    _key("alibaba", "Qwen Cloud", "alibaba dashscope qwen"),
    _key("alibaba-coding-plan", "Alibaba Cloud (Coding Plan)", "dashscope qwen"),
    _key("nvidia", "NVIDIA NIM", "nemotron"),
    _key("huggingface", "Hugging Face", "hf"),
    _key("ai-gateway", "Vercel AI Gateway", "vercel"),
    _key("opencode-zen", "OpenCode Zen", "opencode"),
    _key("opencode-go", "OpenCode Go", "opencode"),
    _key("kilocode", "Kilo Code", "kilo"),
    _key("copilot", "GitHub Copilot", "github token"),
    _key("deepinfra", "DeepInfra"),
    _key("fireworks", "Fireworks AI"),
    _key("novita", "NovitaAI"),
    _key("nebius-token-factory", "Nebius Token Factory", "nebius"),
    _key("stepfun", "StepFun Step Plan", "step"),
    _key("xiaomi", "Xiaomi MiMo", "mimo"),
    _key("tencent-tokenhub", "Tencent TokenHub", "hunyuan"),
    _key("tencent-tokenplan", "Tencent TokenPlan", "hunyuan"),
    _key("ollama-cloud", "Ollama Cloud", "ollama"),
    _key("upstage", "Upstage Solar", "solar"),
    _key("arcee", "Arcee AI"),
    _key("gmi", "GMI Cloud"),
    _key("meta-ai", "Meta Model API", "meta muse"),
    _key("commandcode", "CommandCode"),
    _key("actual", "Actual Computer"),
    _key("lmstudio", "LM Studio on this computer", "local"),
    CatalogProvider("bedrock", "AWS Bedrock", "cloud", "aws amazon"),
    CatalogProvider("vertex", "Google Vertex AI", "cloud", "google gcp"),
    CatalogProvider("azure-foundry", "Azure Foundry", "cloud", "microsoft azure"),
)
_NAMES: dict[str, str] = {}
for _item in CATALOG:
    _NAMES.setdefault(_item.id, _item.name)
#: How the credential list names a provider (an API-key row of a sign-in provider keeps one name).
POOL_NAMES: dict[str, str] = {
    **_NAMES, "openai-codex": "ChatGPT or Codex subscription", "anthropic": "Anthropic",
    "nous": "Nous Portal", "xai-oauth": "xAI Grok", "qwen-oauth": "Qwen Code", "minimax-oauth": "MiniMax",
}


def catalog_entry(provider: str, group: ProviderGroup | None = None) -> CatalogProvider | None:
    return next((item for item in CATALOG if item.id == provider and (group is None or item.group == group)),
                None)


def pool_name(provider: str) -> str:
    return POOL_NAMES.get(provider, provider)


# -- `hermes auth list` -------------------------------------------------------------------------


@dataclass(frozen=True)
class Credential:
    #: 1-based position in Hermes' list for the provider (``#<n>``): Hermes' try order under fill_first.
    index: int
    id: str
    label: str
    auth_type: str
    priority: int
    source: str
    state: CredentialState
    #: ``limited``: when Hermes tries it again (ISO-8601 UTC), if it said.
    until: str | None
    #: The status words Hermes printed (``rate-limited (429)``…), never a secret.
    detail: str | None
    #: Hermes' next pick for the provider (``←``).
    current: bool


@dataclass(frozen=True)
class ProviderPool:
    id: str
    name: str
    credentials: tuple[Credential, ...]
    #: Hermes' free tier line (``nous: Free tier · <model>``) — not a credential the user added.
    free_tier: str | None = None
    #: 0 = Hermes' main provider, 1.. = the fallback chain; None = not in Hermes' order.
    order: int | None = None


_HEADER = re.compile(r"^(?P<provider>[a-z0-9][a-z0-9:._-]*) \((?P<count>\d+) credentials?\):$")
_FREE = re.compile(r"^(?P<provider>[a-z0-9][a-z0-9:._-]*): (?P<label>.+)$")
_ROW = re.compile(
    r"^  #(?P<index>\d+)  (?P<label>.*?) +(?P<type>[a-z_]+) +id=(?P<id>\S+) priority=(?P<priority>-?\d+) ?"
    r"(?P<rest>.*?)(?: ?(?P<current>←))?\s*$")
_LEFT = re.compile(r"\((?:(?P<a>\d+)(?P<au>[dhms]))(?: (?P<b>\d+)(?P<bu>[dhms]))? left\)")
_UNITS = {"d": 86400, "h": 3600, "m": 60, "s": 1}
#: Labels of ``_format_exhausted_status`` (``_EXHAUSTED_CLASSES`` and the default).
_STATUS = re.compile(r" (?P<label>rate-limited|auth failed|exhausted)\b(?P<more>.*)$")


def _status(rest: str, now: datetime) -> tuple[str, CredentialState, str | None, str | None]:
    """``(source, state, until, detail)`` of a row's tail after ``priority=<p>``."""
    match = _STATUS.search(" " + rest)
    if match is None:
        return rest.strip(), "ready", None, None
    source = (" " + rest)[: match.start()].strip()
    label, more = match["label"], match["more"]
    detail = (label + more).strip()
    if "(ready to retry)" in more:
        return source, "ready", None, detail
    if label == "auth failed":
        return source, "signed_out", None, detail
    left = _LEFT.search(more)
    until = None
    if left is not None:
        seconds = int(left["a"]) * _UNITS[left["au"]]
        if left["b"]:
            seconds += int(left["b"]) * _UNITS[left["bu"]]
        until = (now + timedelta(seconds=seconds)).isoformat(timespec="seconds")
    return source, ("limited" if label == "rate-limited" else "error"), until, detail


def parse_auth_list(text: str, *, now: datetime | None = None) -> list[ProviderPool]:
    """Providers and their credentials as ``hermes auth list`` prints them (other lines ignored)."""
    moment = now or datetime.now(UTC)
    pools: list[ProviderPool] = []
    current: tuple[str, list[Credential]] | None = None

    def close() -> None:
        nonlocal current
        if current is not None:
            pools.append(ProviderPool(current[0], pool_name(current[0]), tuple(current[1])))
            current = None

    lines = text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].rstrip()
        index += 1
        header = _HEADER.match(line)
        if header is not None:
            close()
            current = (header["provider"], [])
            continue
        row = _ROW.match(line)
        if row is not None and current is not None:
            source, state, until, detail = _status(row["rest"], moment)
            current[1].append(Credential(
                index=int(row["index"]), id=row["id"], label=row["label"].strip(), auth_type=row["type"],
                priority=int(row["priority"]), source=source, state=state, until=until, detail=detail,
                current=row["current"] is not None))
            continue
        free = _FREE.match(line)
        if free is not None and current is None and "·" in free["label"] and not line.startswith(" "):
            pools.append(ProviderPool(free["provider"], pool_name(free["provider"]), (),
                                      free_tier=free["label"].strip()))
            index += 1 if index < len(lines) and lines[index].startswith("  ") else 0  # its hint line
            continue
        if not line.strip():
            close()
    close()
    return pools


def _value(text: str) -> object:
    try:
        return json.loads(text.strip() or "null")
    except ValueError:
        return None


def provider_order(main_json: str | None, fallback_json: str | None,
                   legacy_json: str | None = None) -> list[str]:
    """Hermes' try order of providers: ``model.provider``, then ``fallback_providers``, then
    legacy ``fallback_model`` (``fallback_config.get_fallback_chain``); duplicates dropped."""
    order: list[str] = []
    main = _value(main_json) if main_json is not None else None
    if isinstance(main, str) and main.strip():
        order.append(main.strip())
    for raw in (fallback_json, legacy_json):
        value = _value(raw) if raw is not None else None
        entries = value if isinstance(value, list) else [value] if isinstance(value, dict) else []
        for entry in entries:
            provider = entry.get("provider") if isinstance(entry, dict) else None
            if isinstance(provider, str) and provider.strip() and provider.strip() not in order:
                order.append(provider.strip())
    return order


def ordered(pools: Sequence[ProviderPool], order: Sequence[str]) -> list[ProviderPool]:
    """Pools in Hermes' order (main, fallbacks), then the rest by name; each with its place."""
    place = {provider: number for number, provider in enumerate(order)}
    ranked = sorted(pools, key=lambda pool: (place.get(pool.id, len(place)), pool.name.lower(), pool.id))
    return [ProviderPool(pool.id, pool.name, pool.credentials, pool.free_tier, place.get(pool.id))
            for pool in ranked]


# -- commands ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class TerminalCommand:
    """What one Terminal window runs: Hermes commands joined with ``&&`` (never a secret)."""

    name: str
    title: str
    commands: tuple[tuple[str, ...], ...]
    provider: str | None = None
    extra: dict[str, str] = field(default_factory=dict)


SAFE_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,62}")
SAFE_CREDENTIAL = re.compile(r"[A-Za-z0-9_-]{1,64}")


def add_command(provider: CatalogProvider) -> TerminalCommand:
    if provider.group == "cloud":
        return TerminalCommand("hermes-provider-cloud", f"SKAZ opened the Hermes setup for {provider.name}. "
                               "Choose it in the list; Hermes asks for its settings.", (("model",),),
                               provider.id)
    kind = "oauth" if provider.group == "subscription" else "api-key"
    what = "Finish signing in in your browser" if kind == "oauth" else "Paste the key when Hermes asks"
    return TerminalCommand(f"hermes-provider-add-{provider.id}",
                           f"SKAZ opened Hermes to add {provider.name}. {what}; SKAZ never sees it.",
                           (("auth", "add", provider.id, "--type", kind),), provider.id)


def sign_in_again_command(pool: ProviderPool, credential: Credential) -> TerminalCommand:
    """A new credential at the old one's place, then the old one removed — only if the new one was added."""
    kind = "oauth" if credential.auth_type == "oauth" else "api-key"
    place = str(max(credential.priority, 0))
    add: tuple[str, ...] = ("auth", "add", pool.id, "--type", kind, "--priority", place)
    if credential.label:
        add += ("--label", credential.label)
    return TerminalCommand(f"hermes-provider-signin-{pool.id}",
                           f"SKAZ opened Hermes to sign in to {pool.name} again. The old sign-in is "
                           "removed only after the new one works; SKAZ never sees either.",
                           (add, ("auth", "remove", pool.id, credential.id)), pool.id)


def other_command() -> TerminalCommand:
    return TerminalCommand("hermes-provider-other", "SKAZ opened Hermes' credential manager. Choose "
                           "“Add a credential” and the provider; SKAZ never sees the key.", (("auth",),))


def order_command() -> TerminalCommand:
    return TerminalCommand("hermes-provider-order", "SKAZ opened Hermes' fallback providers: the order "
                           "Hermes tries providers in when the main one fails.", (("fallback",),))
