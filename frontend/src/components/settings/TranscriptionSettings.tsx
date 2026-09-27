import { useCallback } from 'react';
import { clsx } from 'clsx';
import { useStore } from '../../state/store';
import { Icon } from '../ui/Icon';
import { LocalModelPreparation, formatBytes } from './LocalModelPreparation';
import type {
  LocalModelStatus,
  Settings,
  TranscriptionCapabilities,
  TranscriptionProviderId,
  TranscriptionProviderInfo,
} from '../../api/types';

/** Unsaved Transcription choices; omitted fields keep the stored value. */
export interface TranscriptionDraft {
  transcription_provider?: TranscriptionProviderId;
  local_whisper_model?: string;
  openai_transcription_model?: string;
  speaker_separation?: boolean;
}

interface TranscriptionSettingsProps {
  settings: Settings;
  draft: TranscriptionDraft;
  onChange: (draft: TranscriptionDraft) => void;
  disabled?: boolean;
  /** Recording in progress: a new provider applies to the next recording only. */
  capturing?: boolean;
}

const SPEAKER_MODEL = 'wespeaker-voxceleb-resnet34-LM';
const SPEAKER_MODEL_BYTES = 26_600_000;

const LIVE: Record<TranscriptionCapabilities['live'], string> = {
  streaming: 'Streaming: words appear while you speak',
  near_streaming: 'Near-streaming: provisional text, confirmed after about a second',
  utterance: 'Phrase by phrase: text appears after each pause',
};
const SPEAKERS: Record<TranscriptionCapabilities['speakers'], string> = {
  full: 'Speakers separated by the provider',
  approximate: 'Speakers separated approximately (local voice model)',
  none: 'No speaker separation',
};
const TRANSLATION: Record<TranscriptionCapabilities['translation'], string> = {
  any: 'Live translation into any supported language',
  english_only: 'Translation into English only',
  none: 'No live translation',
};

const formatSize = (bytes?: number | null): string | null => (bytes ? formatBytes(bytes) : null);

/**
 * Settings → Transcription: which provider turns speech into the transcript,
 * what it can and cannot do, and — for Local Whisper — the model on this
 * computer. Choosing a provider never falls back to another one; if it cannot
 * run, recording says why.
 */
export function TranscriptionSettings({ settings, draft, onChange, disabled, capturing }: TranscriptionSettingsProps) {
  const refreshSettings = useStore((s) => s.refreshSettings);
  const providers = settings.transcription_providers ?? [];
  const selected = draft.transcription_provider ?? settings.transcription_provider ?? 'soniox';
  const info = providers.find((item) => item.id === selected);
  const localModel = draft.local_whisper_model ?? settings.local_whisper_model ?? 'small';
  const openaiModel = draft.openai_transcription_model ?? settings.openai_transcription_model ?? 'whisper-1';
  const speakerSeparation = draft.speaker_separation ?? settings.speaker_separation ?? true;
  const change = (patch: TranscriptionDraft) => onChange({ ...draft, ...patch });
  // Readiness is computed by the backend; re-read it once a download settles.
  const onModelState = useCallback((state: LocalModelStatus['state']) => {
    if (state === 'ready' || state === 'not_installed') void refreshSettings();
  }, [refreshSettings]);

  if (providers.length === 0) {
    return (
      <div className="profile profile--fixed">
        <div className="profile__head">
          <div>
            <strong>Transcription (ASR)</strong>
            <p className="field__hint">Turns speech into timestamped text.</p>
          </div>
          <span className="profile__fixed-value">Soniox</span>
        </div>
        <p className="field__hint">
          Live transcription runs through Soniox — model and endpoint choices here do not apply.
          {settings.provider_has_api_key?.soniox === true ? ' Key saved.' : ' No key set — add it under API keys.'}
        </p>
      </div>
    );
  }

  return (
    <div className="transcription">
      <div className="transcription__providers" role="radiogroup" aria-label="Transcription provider">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            selected={provider.id === selected}
            disabled={disabled}
            onSelect={() => change({ transcription_provider: provider.id })}
          />
        ))}
      </div>
      {capturing && (
        <p className="field__hint">A recording is in progress; a new provider applies to the next recording.</p>
      )}

      {info && (
        <section className="profile" aria-label={`${info.label} details`}>
          <ul className="transcription__facts">
            <li>{LIVE[info.capabilities.live]}</li>
            <li>{SPEAKERS[info.capabilities.speakers]}</li>
            <li>{TRANSLATION[info.capabilities.translation]}</li>
            <li>
              {info.capabilities.offline
                ? 'Runs on this computer; works with the network off. Audio never leaves it.'
                : `Sends audio to ${info.label}; requires cloud processing consent and a ${info.label} key.`}
            </li>
          </ul>

          {info.id === 'local-whisper' && (
            <>
              <div className="field">
                <label htmlFor="local-whisper-model">Model</label>
                <select
                  id="local-whisper-model"
                  value={localModel}
                  disabled={disabled}
                  onChange={(event) => change({ local_whisper_model: event.target.value })}
                >
                  {info.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                      {formatSize(model.size_bytes) ? ` · ${formatSize(model.size_bytes)}` : ''}
                      {model.recommended ? ' · recommended' : ''}
                    </option>
                  ))}
                </select>
                {info.models.find((model) => model.id === localModel)?.note && (
                  <span className="field__hint">{info.models.find((model) => model.id === localModel)?.note}</span>
                )}
              </div>
              <LocalModelPreparation
                provider="local-whisper"
                model={localModel}
                sizeBytes={info.models.find((model) => model.id === localModel)?.size_bytes}
                onState={onModelState}
              />
            </>
          )}

          {info.id === 'openai' && (
            <div className="field">
              <label htmlFor="openai-transcription-model">Model</label>
              <select
                id="openai-transcription-model"
                value={openaiModel}
                disabled={disabled}
                onChange={(event) => change({ openai_transcription_model: event.target.value })}
              >
                {info.models.map((model) => (
                  <option key={model.id} value={model.id}>{model.name}</option>
                ))}
              </select>
              {info.models.find((model) => model.id === openaiModel)?.note && (
                <span className="field__hint">{info.models.find((model) => model.id === openaiModel)?.note}</span>
              )}
            </div>
          )}

          {info.capabilities.speakers === 'approximate' && (
            <div className="transcription__speakers">
              <label className="consent">
                <input
                  type="checkbox"
                  checked={speakerSeparation}
                  disabled={disabled}
                  onChange={(event) => change({ speaker_separation: event.target.checked })}
                />
                <span>
                  <strong>Separate speakers</strong>
                  <span className="field__hint">
                    Groups the transcript by voice with a small local model (WeSpeaker ResNet34). It can merge
                    similar voices or split one voice; without it every word belongs to one speaker.
                  </span>
                </span>
              </label>
              {speakerSeparation && (
                <div className="transcription__speaker-model">
                  <strong>Speaker model</strong>
                  <span className="field__hint">
                    {info.capabilities.offline
                      ? 'Downloaded once, then used offline together with the Whisper model.'
                      : `Runs on this computer next to ${info.label}: ${info.label} returns no speaker labels, so SKAZ groups `
                        + 'voices locally. Nothing extra is sent anywhere.'}
                  </span>
                  <LocalModelPreparation provider="local-speaker" model={SPEAKER_MODEL} sizeBytes={SPEAKER_MODEL_BYTES} />
                </div>
              )}
            </div>
          )}

          {info.limitations.length > 0 && (
            <div className="transcription__limits">
              <strong>Compared with Soniox</strong>
              <ul>
                {info.limitations.map((limit) => <li key={limit}>{limit}</li>)}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function ProviderCard({ provider, selected, disabled, onSelect }: {
  provider: TranscriptionProviderInfo;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={clsx('transcription__provider', selected && 'transcription__provider--on')}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="transcription__provider-head">
        <strong>{provider.label}</strong>
        <span className={clsx('transcription__tag', provider.capabilities.offline && 'transcription__tag--local')}>
          {provider.capabilities.offline ? 'On this computer' : 'Cloud'}
        </span>
      </span>
      <span className={clsx('profile__note', provider.ready ? 'profile__note--ok' : 'profile__note--warn')}>
        <Icon name={provider.ready ? 'check' : 'warning'} size={13} />
        {provider.ready ? 'Ready' : provider.detail ?? 'Not ready'}
      </span>
    </button>
  );
}
