"""Settings → problems: one list of what isn't working, why, what still works and the fix on the spot.

Decision after question 30 (user requirement "all problem states"): the model
isn't downloaded / is downloading / failed (no space, no network); the
ChatGPT sign-in expired; a key was refused; an agent isn't installed. Each
problem names what keeps working and what stopped, and offers explicit
actions only — switching back to a cloud service is always the user's click,
never automatic.

Sections: ``accounts`` (agents, keys), ``models`` (the decision layer),
``speech``, ``wiki``, ``storage`` (the library), ``privacy``, ``appearance``,
``about``.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from ...native_io import disk_call
from ..agents.engine import EngineId
from ..agents.hermes import PREPARING_NOTE
from ..agents.registry import ENGINE_IDS, ENGINE_NAMES
from ..errors import KnowledgeError, NotFound
from .keys import KEY_PROVIDERS, LABELS, KeyChecks, KeyProvider
from .speech import local_model

if TYPE_CHECKING:  # pragma: no cover
    from ...runtime import Runtime

SectionId = Literal["accounts", "models", "speech", "wiki", "storage", "privacy", "appearance", "about"]
SECTIONS: tuple[SectionId, ...] = ("accounts", "models", "speech", "wiki", "storage", "privacy", "appearance",
                                   "about")
Severity = Literal["warning", "error", "progress"]
HealthState = Literal["ok", "progress", "warning", "error"]
_RANK: dict[str, int] = {"ok": 0, "progress": 1, "warning": 2, "error": 3}


@dataclass(frozen=True)
class ProblemAction:
    id: str
    label: str
    primary: bool = False


@dataclass(frozen=True)
class Problem:
    id: str
    section: SectionId
    severity: Severity
    title: str
    reason: str
    still_works: str
    stopped: str
    progress: float | None = None
    actions: tuple[ProblemAction, ...] = ()


@dataclass(frozen=True)
class Section:
    id: SectionId
    state: HealthState
    problems: tuple[Problem, ...] = field(default_factory=tuple)


USE_LOCAL = ProblemAction("use_local", "Recognise on this Mac")
#: The user's explicit consent to send audio to Soniox (stored as the existing ``cloud_consent``).
ALLOW_SONIOX = ProblemAction("allow_soniox", "Allow sending audio to Soniox", True)


class UnknownProblem(NotFound):
    pass


class ActionRefused(KnowledgeError):
    status_code = 409


def _state(problems: tuple[Problem, ...]) -> HealthState:
    worst: HealthState = "ok"
    for problem in problems:
        if _RANK[problem.severity] > _RANK[worst]:
            worst = problem.severity
    return worst


class SettingsHealth:
    def __init__(self, runtime: Runtime, keys: KeyChecks) -> None:
        self._runtime = runtime
        self._keys = keys

    # -- reading ------------------------------------------------------------

    async def sections(self) -> list[Section]:
        problems = [*await self._agents(), *self._key_problems(), *await self._decisions(),
                    *self._speech(), *self._library()]
        result = []
        for section in SECTIONS:
            mine = tuple(problem for problem in problems if problem.section == section)
            result.append(Section(section, _state(mine), mine))
        return result

    async def problem(self, problem_id: str) -> Problem:
        for section in await self.sections():
            for problem in section.problems:
                if problem.id == problem_id:
                    return problem
        raise UnknownProblem("This problem is already solved.")

    async def _agents(self) -> list[Problem]:
        hub = self._runtime.kb_agents
        default = hub.registry.default()
        problems = []
        for engine in ENGINE_IDS:
            name = ENGINE_NAMES[engine]
            running = hub.installs.running_for(engine)
            if running is not None and running.action == "prepare":
                problems.append(Problem(
                    f"agent-{engine}", "accounts", "progress", f"{name} is getting ready", PREPARING_NOTE,
                    "Everything else works; other agents can answer meanwhile.",
                    f"Chats and wiki work with {name} once it is ready.",
                ))
                continue
            if engine != default:
                continue  # an agent that isn't used is not a problem
            view = await hub.registry.view(engine)
            state, action = hub.state(view)
            if state == "ready":
                continue
            actions: tuple[ProblemAction, ...] = ()
            if action in ("install", "update", "prepare"):
                label = {"install": "Install", "update": "Update", "prepare": "Prepare (~1.5 GB)"}[action]
                actions = (ProblemAction(action, label, True),)
            elif action == "login" and engine != "codex":
                actions = (ProblemAction("login", "Sign in", True),)
            elif action == "check":
                actions = (ProblemAction("check", "Check again", True),)
            title = {"not_installed": f"{name} isn't installed", "outdated": f"{name} needs an update",
                     "signed_out": f"{name}: sign-in needed"}.get(state, f"{name} isn't ready")
            if action == "prepare":
                title = f"{name} needs to prepare its environment"
            problems.append(Problem(
                f"agent-{engine}", "accounts", "error", title,
                view.status.reason or f"{name} can't be used right now.",
                "Recording, importing and reading your materials and wiki keep working.",
                f"Chats and adding to the wiki use {name}, the main agent: they stop until it's ready.",
                actions=actions,
            ))
        return problems

    def _key_problems(self) -> list[Problem]:
        problems = []
        for status in self._keys.statuses():
            if status.configured and status.valid is False:
                problems.append(Problem(
                    f"key-{status.id}", "accounts", "error", f"The {LABELS[status.id]} key didn't work",
                    f"{LABELS[status.id]} refused the stored key at the last check. "
                    "Change the key, then check it.",
                    "Everything that doesn't use " + LABELS[status.id] + " keeps working.",
                    _key_stops(status.id),
                    actions=(ProblemAction("check", "Check again", True),),
                ))
        return problems

    async def _decisions(self) -> list[Problem]:
        service = self._runtime.kb_decisions
        view = await service.view()
        still = "Adding to the wiki keeps working: the writing model makes these decisions itself (slower)."
        stopped = "Quick wiki decisions (where new knowledge goes)."
        if view.provider == "local":
            local = view.local
            if local.state == "downloading":
                return [Problem("decisions-local", "models", "progress", "The decision model is downloading",
                                "The model for wiki decisions on this Mac is being downloaded.",
                                still, stopped,
                                progress=local.progress)]
            if local.state == "not_downloaded":
                return [Problem("decisions-local", "models", "warning", "The decision model isn't downloaded",
                                "You chose wiki decisions on this Mac, but the model isn't there yet.",
                                still, stopped, actions=(ProblemAction("download", "Download", True),
                                                         ProblemAction("use_cloud", "Use OpenRouter · Jev")))]
            if local.state == "failed":
                return [Problem("decisions-local", "models", "error", "The decision model couldn't be set up",
                                local.message or "The download or start failed.", still, stopped,
                                actions=(ProblemAction("retry", "Try again", True),
                                         ProblemAction("use_cloud", "Use OpenRouter · Jev")))]
        if view.provider == "openrouter_jev" and not view.openrouter_key:
            return [Problem("decisions-openrouter", "models", "error", "No OpenRouter key",
                            "Wiki decisions go to OpenRouter · Jev, but no OpenRouter key is stored.",
                            still, stopped, actions=(ProblemAction("use_local", "Decide on this Mac"),))]
        return []

    def _speech(self) -> list[Problem]:
        runtime = self._runtime
        settings = runtime.settings_store.load()
        still = "Your materials, wiki and chats keep working."
        stopped = "New recordings, media imports and dictation."
        provider = settings.transcription_provider
        if provider == "local-whisper":
            model = local_model(runtime, settings.local_whisper_model)
            label = f"Whisper {model.model}"
            if model.state == "downloading":
                return [Problem("speech-local-model", "speech", "progress", f"{label} is downloading",
                                "The speech model for this Mac is being downloaded. You can keep working.",
                                still, stopped, progress=model.progress)]
            if model.state == "missing":
                return [Problem("speech-local-model", "speech", "warning", f"{label} isn't downloaded",
                                "You chose speech recognition on this Mac, but its model isn't there yet.",
                                still, stopped, actions=(ProblemAction("download", "Download", True),
                                                         ProblemAction("use_soniox", "Use Soniox")))]
            if model.state == "failed":
                return [Problem("speech-local-model", "speech", "error", f"{label} couldn't be set up",
                                model.reason or "The model couldn't be prepared.", still, stopped,
                                actions=(ProblemAction("retry", "Try again", True),
                                         ProblemAction("use_soniox", "Use Soniox")))]
            return []
        if provider == "soniox":
            if not runtime.api_key("soniox"):
                return [Problem("speech-soniox-key", "speech", "error", "No Soniox key",
                                "Speech goes to Soniox, but no Soniox key is stored. "
                                "Add it in Accounts and keys.", still, stopped, actions=(USE_LOCAL,))]
            if not settings.cloud_consent:
                return [Problem("speech-soniox-consent", "speech", "error", "Sending audio to Soniox is off",
                                "Speech goes to Soniox, but sending audio to the cloud isn't allowed. "
                                "Allowing it sends the audio of recordings, imported media and dictation "
                                "to Soniox for recognition.",
                                still, stopped, actions=(ALLOW_SONIOX, USE_LOCAL))]
        return []

    def _library(self) -> list[Problem]:
        view = self._runtime.kb.view()
        if view.state == "not_configured":
            return [Problem("library-not-connected", "storage", "warning", "No library yet",
                            f"Materials and the wiki will be kept in {view.suggested_root}.",
                            "Settings and agents.", "Recording, adding materials, the wiki and chats.",
                            actions=(ProblemAction("connect", "Create the library", True),))]
        if view.state == "unavailable":
            return [Problem("library-unavailable", "storage", "error", "The library folder can't be used",
                            view.reason or "SKAZ can't open the library folder.",
                            "What is already indexed can still be searched and read.",
                            "Adding, changing or recording into the library.",
                            actions=(ProblemAction("retry", "Try again", True),))]
        return []

    # -- actions ------------------------------------------------------------

    async def act(self, problem_id: str, action_id: str) -> None:
        problem = await self.problem(problem_id)
        if action_id not in {action.id for action in problem.actions}:
            raise ActionRefused("This action isn't available for this problem.")
        handler = self._handlers().get(problem_id.split("-", 1)[0])
        if handler is None:  # pragma: no cover - every problem kind has a handler
            raise ActionRefused("This action isn't available for this problem.")
        await handler(problem, action_id)

    def _handlers(self) -> dict[str, Callable[[Problem, str], Awaitable[None]]]:
        return {"agent": self._agent_action, "key": self._key_action, "decisions": self._decisions_action,
                "speech": self._speech_action, "library": self._library_action}

    async def _agent_action(self, problem: Problem, action: str) -> None:
        engine: EngineId = problem.id.removeprefix("agent-")  # type: ignore[assignment]
        hub = self._runtime.kb_agents
        if action in ("install", "update", "prepare"):
            hub.installs.start(engine, action)  # type: ignore[arg-type]
            hub.registry.forget(engine)
        elif action == "login":
            await hub.registry.login(engine)
        else:
            await hub.registry.view(engine, refresh=True)

    async def _key_action(self, problem: Problem, _action: str) -> None:
        provider: KeyProvider = problem.id.removeprefix("key-")  # type: ignore[assignment]
        if provider in KEY_PROVIDERS:
            await self._keys.check(provider)

    async def _decisions_action(self, _problem: Problem, action: str) -> None:
        service = self._runtime.kb_decisions
        if action in ("download", "retry"):
            service.manager.download()
        elif action == "use_cloud":
            # Explicit: the stored consent to send wiki excerpts to OpenRouter must already be given.
            await disk_call(service.configure, "openrouter_jev")
        elif action == "use_local":
            await disk_call(service.configure, "local")

    async def _speech_action(self, _problem: Problem, action: str) -> None:
        runtime = self._runtime
        if action in ("download", "retry"):
            model = (await disk_call(runtime.settings_store.load)).local_whisper_model
            await runtime.local_models.start(model, "local-whisper")
        elif action in ("use_soniox", "use_local"):
            await self._update_speech(transcription_provider="soniox" if action == "use_soniox"
                                      else "local-whisper")
        elif action == ALLOW_SONIOX.id:
            # The user's click on "Allow sending audio to Soniox"; revoked in Settings → Speech.
            await self._update_speech(cloud_consent=True)

    async def _update_speech(self, **changes: object) -> None:
        from ...routes.settings import update_settings
        from ...schemas import SettingsUpdate

        await update_settings(SettingsUpdate.model_validate(changes), self._runtime)

    async def _library_action(self, _problem: Problem, action: str) -> None:
        kb = self._runtime.kb
        if action == "connect":
            await disk_call(kb.connect, None)
        else:
            await disk_call(kb.retry)


def _key_stops(provider: KeyProvider) -> str:
    return {
        "soniox": "Speech recognition with Soniox (recordings, imports, dictation).",
        "openrouter": "Wiki decisions through OpenRouter · Jev.",
        "openai": "Anything that uses OpenAI with this key.",
    }[provider]
