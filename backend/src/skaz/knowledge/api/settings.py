"""``/kb/settings/{health,keys,speech,privacy,about,skills}``: settings over the existing stores (S3, H3).

``/kb/settings/wiki`` belongs to the ingest area (W1). Keys and speech choices
are written through the legacy ``PUT /settings`` logic (same validation,
same secret store, same stream shutdown when a key or consent goes away).
"""
from __future__ import annotations

from typing import Annotated, get_args

from fastapi import APIRouter, HTTPException, Path
from pydantic import SecretStr, ValidationError

from ...gateways.asr import LocalModelBusy
from ...local_models import CacheSafetyError
from ...native_io import disk_call
from ...routes.deps import RuntimeDep
from ...routes.settings import update_settings
from ...runtime import Runtime
from ...schemas import SettingsUpdate
from ..decisions.local import LocalUnavailable
from ..errors import KnowledgeError
from ..settings.about import about
from ..settings.health import SettingsHealth
from ..settings.keys import KeyChecks, KeyProvider, KeyStatus
from ..settings.privacy import privacy_flows
from ..settings.speech import (
    SpeechSettings,
    UnknownLocalModel,
    delete_local_model,
    speech_settings,
    to_legacy,
)
from ..skills import SkazSkill, catalog
from ..skills.settings import is_enabled, set_enabled
from ..skills.status import engine_statuses
from .schemas_settings import (
    KbAbout,
    KbKeyProvider,
    KbKeys,
    KbKeyStatus,
    KbKeyUpdate,
    KbLicense,
    KbLocalModelDeleted,
    KbLocalSpeechModel,
    KbPrivacy,
    KbPrivacyFlow,
    KbProblem,
    KbProblemAction,
    KbSettingsHealth,
    KbSettingsSection,
    KbSkill,
    KbSkillEngine,
    KbSkills,
    KbSkillUpdate,
    KbSpeechSettings,
    KbSpeechSettingsUpdate,
)

router = APIRouter(prefix="/kb/settings", tags=["kb"])
assert set(get_args(KbKeyProvider)) == set(get_args(KeyProvider))


ProblemId = Annotated[str, Path(min_length=1, max_length=80, pattern=r"^[a-z0-9_-]+$")]
ActionId = Annotated[str, Path(min_length=1, max_length=40, pattern=r"^[a-z0-9_]+$")]
SkillId = Annotated[str, Path(min_length=1, max_length=40, pattern=r"^[a-z0-9-]+$")]


def _http(error: KnowledgeError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.message)


# -- health ---------------------------------------------------------------------


async def _health(runtime: Runtime) -> KbSettingsHealth:
    health: SettingsHealth = runtime.kb_settings_health
    return KbSettingsHealth(sections=[
        KbSettingsSection(id=section.id, state=section.state, problems=[
            KbProblem(id=problem.id, severity=problem.severity, title=problem.title, reason=problem.reason,
                      still_works=problem.still_works, stopped=problem.stopped, progress=problem.progress,
                      actions=[KbProblemAction(id=action.id, label=action.label, primary=action.primary)
                               for action in problem.actions])
            for problem in section.problems
        ])
        for section in await health.sections()
    ])


@router.get("/health")
async def read_health(runtime: RuntimeDep) -> KbSettingsHealth:
    """Problems per settings section, for the banners, the section dots and the dot on the gear."""
    return await _health(runtime)


@router.post("/health/{problem_id}/{action_id}")
async def fix_problem(problem_id: ProblemId, action_id: ActionId, runtime: RuntimeDep) -> KbSettingsHealth:
    """Download / retry / sign in / check / switch the service — only what the problem offers."""
    try:
        await runtime.kb_settings_health.act(problem_id, action_id)
    except KnowledgeError as error:
        raise _http(error) from error
    except LocalModelBusy as error:
        raise HTTPException(status_code=409, detail="Another local model is being prepared. Try again later."
                            ) from error
    except LocalUnavailable as error:
        raise HTTPException(status_code=503, detail=error.message) from error
    return await _health(runtime)


# -- keys -----------------------------------------------------------------------


def _key_view(status: KeyStatus) -> KbKeyStatus:
    return KbKeyStatus(id=status.id, configured=status.configured, checked_at=status.checked_at,
                       valid=status.valid)


@router.get("/keys")
async def read_keys(runtime: RuntimeDep) -> KbKeys:
    checks: KeyChecks = runtime.kb_keys
    return KbKeys(providers=[_key_view(status) for status in await disk_call(checks.statuses)])


@router.put("/keys/{provider}")
async def store_key(provider: KbKeyProvider, body: KbKeyUpdate, runtime: RuntimeDep) -> KbKeyStatus:
    """Save (or, with an empty key, delete) a key in the app's secret store. The key is never returned."""
    value = body.key.get_secret_value().strip()
    await update_settings(SettingsUpdate(provider_keys={provider: SecretStr(value)}), runtime)
    checks: KeyChecks = runtime.kb_keys
    await disk_call(checks.forget, provider)
    return _key_view(await disk_call(checks.status, provider))


@router.post("/keys/{provider}/check")
async def check_key(provider: KbKeyProvider, runtime: RuntimeDep) -> KbKeyStatus:
    """One cheap authenticated request to the provider; no user data is sent."""
    try:
        return _key_view(await runtime.kb_keys.check(provider))
    except KnowledgeError as error:
        raise _http(error) from error


# -- speech ---------------------------------------------------------------------


def _speech_view(value: SpeechSettings) -> KbSpeechSettings:
    model = value.local_model
    return KbSpeechSettings(
        provider=value.provider, languages=list(value.languages),
        translate_by_default=value.translate_by_default,
        translation_language=value.translation_language,
        local_model=KbLocalSpeechModel(model=model.model, state=model.state, progress=model.progress,
                                       reason=model.reason, size_bytes=model.size_bytes),
        cloud_consent=value.cloud_consent,
    )


@router.get("/speech")
async def read_speech(runtime: RuntimeDep) -> KbSpeechSettings:
    return _speech_view(await disk_call(speech_settings, runtime))


@router.put("/speech")
async def update_speech(body: KbSpeechSettingsUpdate, runtime: RuntimeDep) -> KbSpeechSettings:
    """Service, languages, translation default and the cloud consent — in the existing settings, nowhere else.

    Taking the consent back stops cloud recognition that is running (the legacy update does that).
    """
    try:
        update = _speech_update(body)
    except ValidationError as error:
        reason = error.errors()[0].get("msg", "Invalid speech settings.").removeprefix("Value error, ")
        raise HTTPException(status_code=422, detail=reason) from error
    await update_settings(update, runtime)
    return _speech_view(await disk_call(speech_settings, runtime))


@router.delete("/speech/local-model")
async def delete_speech_model(runtime: RuntimeDep) -> KbLocalModelDeleted:
    """Delete the downloaded Whisper model of this Mac (the old "Delete downloaded model")."""
    try:
        result = await delete_local_model(runtime)
    except LocalModelBusy as error:
        raise HTTPException(status_code=409, detail=(
            "The speech model is in use or still downloading. Try again when it is free.")) from error
    except CacheSafetyError as error:
        raise HTTPException(status_code=409, detail=(
            "SKAZ didn't delete the model: its folder isn't safe to remove "
            "(it links outside the model cache).")) from error
    except UnknownLocalModel as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return KbLocalModelDeleted(deleted=result.deleted, deleted_bytes=result.deleted_bytes,
                               speech=_speech_view(await disk_call(speech_settings, runtime)))


def _speech_update(body: KbSpeechSettingsUpdate) -> SettingsUpdate:
    return SettingsUpdate.model_validate({
        key: value for key, value in {
            "transcription_provider": to_legacy(body.provider) if body.provider else None,
            "used_languages": body.languages,
            "native_recording_mode": (None if body.translate_by_default is None
                                      else "translation" if body.translate_by_default else "transcription"),
            "translation_target_language": body.translation_language,
            "cloud_consent": body.cloud_consent,
        }.items() if value is not None
    })


# -- privacy and about ----------------------------------------------------------------


@router.get("/privacy")
async def read_privacy(runtime: RuntimeDep) -> KbPrivacy:
    flows = await privacy_flows(runtime)
    return KbPrivacy(flows=[
        KbPrivacyFlow(what=flow.what, where=flow.where, when=flow.when, enabled=flow.enabled)
        for flow in flows
    ])


@router.get("/about")
async def read_about() -> KbAbout:
    info = about()
    return KbAbout(version=info.version, build=info.build,
                   licenses=[KbLicense(name=item.name, license=item.license, url=item.url)
                             for item in info.licenses])


# -- skills (0.3.1 H3) ------------------------------------------------------------------


async def _skills(runtime: Runtime) -> KbSkills:
    """SKAZ's own skills with the switch and, per agent, whether its turns carry the skill now."""
    views = await runtime.kb_agents.registry.views()
    settings = runtime.kb.settings

    def view(item: SkazSkill, enabled: bool) -> KbSkill:
        return KbSkill(id=item.id, name=item.name, version=item.version, license=item.license,
                       source_url=item.source_url, enabled=enabled,
                       engines=[KbSkillEngine(engine=status.engine, state=status.state, reason=status.reason)
                                for status in engine_statuses(enabled, views)])

    enabled = await disk_call(lambda: {item.id: is_enabled(settings, item.id) for item in catalog()})
    return KbSkills(skills=[view(item, enabled[item.id]) for item in catalog()])


@router.get("/skills")
async def read_skills(runtime: RuntimeDep) -> KbSkills:
    return await _skills(runtime)


@router.put("/skills/{skill_id}")
async def update_skill(skill_id: SkillId, body: KbSkillUpdate, runtime: RuntimeDep) -> KbSkills:
    """Switch one SKAZ skill on or off. Applies from the next turn; running answers are not touched."""
    try:
        await disk_call(set_enabled, runtime.kb.settings, skill_id, body.enabled)
    except KnowledgeError as error:
        raise _http(error) from error
    return await _skills(runtime)
