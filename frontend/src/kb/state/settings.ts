import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  KbAbout, KbDecisionProviderUpdate, KbDecisions, KbKeys, KbPrivacy, KbSettingsHealth, KbSpeechSettings, KbSpeechSettingsUpdate, KbWikiSettings, KbWikiSettingsUpdate,
} from '../../api/kb/types.gen';
import type { HealthSectionId, KeyProviderId } from '../api/names';
import { errorText, type KbClient } from '../api/client';
import type { ActionResult } from './library';
import type { SettingsSection } from './ui';

/** One backend-backed piece of settings: its value, or the reason it could not be read. */
export interface Remote<T> {
  value: T | null;
  error: string | null;
}

const empty = <T,>(): Remote<T> => ({ value: null, error: null });

export interface SettingsData {
  health: Remote<KbSettingsHealth>;
  keys: Remote<KbKeys>;
  speech: Remote<KbSpeechSettings>;
  wiki: Remote<KbWikiSettings>;
  decisions: Remote<KbDecisions>;
  privacy: Remote<KbPrivacy>;
  about: Remote<KbAbout>;
}

export interface SettingsActions {
  loadHealth: () => Promise<void>;
  healthAction: (problemId: string, actionId: string) => Promise<ActionResult>;
  loadKeys: () => Promise<void>;
  saveKey: (provider: KeyProviderId, key: string) => Promise<ActionResult>;
  checkKey: (provider: KeyProviderId) => Promise<ActionResult>;
  loadSpeech: () => Promise<void>;
  updateSpeech: (patch: KbSpeechSettingsUpdate) => Promise<ActionResult>;
  /** Delete the downloaded Whisper model; answers the bytes freed. */
  deleteLocalModel: () => Promise<ActionResult<number>>;
  loadWiki: () => Promise<void>;
  updateWiki: (patch: KbWikiSettingsUpdate) => Promise<ActionResult>;
  loadDecisions: () => Promise<void>;
  setDecisionProvider: (update: KbDecisionProviderUpdate) => Promise<ActionResult>;
  downloadDecisionModel: () => Promise<ActionResult>;
  cancelDecisionModel: () => Promise<ActionResult>;
  loadPrivacy: () => Promise<void>;
  loadAbout: () => Promise<void>;
}

export type SettingsStore = StoreApi<SettingsData & SettingsActions>;

/** Health section ids (S3) ↔ the settings menu (U1). */
export const HEALTH_TO_SECTION: Record<HealthSectionId, SettingsSection> = {
  accounts: 'conn', models: 'models', speech: 'rec', wiki: 'wiki', storage: 'storage', privacy: 'privacy', appearance: 'look', about: 'about',
};

export function createSettingsStore(client: KbClient): SettingsStore {
  return createStore<SettingsData & SettingsActions>()((set, get) => {
    const read = async <K extends keyof SettingsData>(key: K, fn: () => Promise<NonNullable<SettingsData[K]['value']>>) => {
      try {
        const value = await fn();
        set({ [key]: { value, error: null } } as unknown as Partial<SettingsData>);
      } catch (error) {
        set((s) => ({ [key]: { value: s[key].value, error: errorText(error) } }) as unknown as Partial<SettingsData>);
      }
    };
    const write = async <K extends keyof SettingsData>(key: K, fn: () => Promise<NonNullable<SettingsData[K]['value']> | void>): Promise<ActionResult> => {
      try {
        const value = await fn();
        if (value) set({ [key]: { value, error: null } } as unknown as Partial<SettingsData>);
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    };
    const loadKeys = () => read('keys', () => client.call('GET /kb/settings/keys'));
    // A key changes what other sections can do (decisions through OpenRouter, Soniox speech, the
    // problem plates, privacy): re-read the ones already on screen, so the status follows at once.
    const followKeys = async () => {
      const s = get();
      const loaded = (r: { value: unknown; error: string | null }) => r.value !== null || r.error !== null;
      await Promise.all([
        loaded(s.decisions) ? read('decisions', () => client.call('GET /kb/decisions')) : undefined,
        loaded(s.speech) ? read('speech', () => client.call('GET /kb/settings/speech')) : undefined,
        loaded(s.privacy) ? read('privacy', () => client.call('GET /kb/settings/privacy')) : undefined,
        read('health', () => client.call('GET /kb/settings/health')),
      ]);
    };
    return {
      health: empty(), keys: empty(), speech: empty(), wiki: empty(), decisions: empty(), privacy: empty(), about: empty(),

      loadHealth: () => read('health', () => client.call('GET /kb/settings/health')),
      healthAction: (problemId, actionId) => write('health', () =>
        client.call('POST /kb/settings/health/{problem_id}/{action_id}', { path: { problem_id: problemId, action_id: actionId } })),
      loadKeys,
      saveKey: async (provider, key) => {
        const res = await write('keys', async () => { await client.call('PUT /kb/settings/keys/{provider}', { path: { provider }, body: { key } }); });
        if (res.ok) await Promise.all([loadKeys(), followKeys()]);
        return res;
      },
      checkKey: async (provider) => {
        const res = await write('keys', async () => {
          const row = await client.call('POST /kb/settings/keys/{provider}/check', { path: { provider } });
          set((s) => ({ keys: { value: s.keys.value ? { providers: s.keys.value.providers.map((p) => (p.id === row.id ? row : p)) } : null, error: null } }));
        });
        if (res.ok) await followKeys();
        return res;
      },
      loadSpeech: () => read('speech', () => client.call('GET /kb/settings/speech')),
      updateSpeech: (patch) => write('speech', () => client.call('PUT /kb/settings/speech', { body: patch })),
      deleteLocalModel: async () => {
        try {
          const result = await client.call('DELETE /kb/settings/speech/local-model');
          set({ speech: { value: result.speech, error: null } });
          return { ok: true, value: result.deleted_bytes };
        } catch (error) {
          return { ok: false, error: errorText(error) };
        }
      },
      loadWiki: () => read('wiki', () => client.call('GET /kb/settings/wiki')),
      updateWiki: (patch) => write('wiki', () => client.call('PUT /kb/settings/wiki', { body: patch })),
      loadDecisions: () => read('decisions', () => client.call('GET /kb/decisions')),
      setDecisionProvider: (update) => write('decisions', () => client.call('PUT /kb/decisions/provider', { body: update })),
      downloadDecisionModel: () => write('decisions', () => client.call('POST /kb/decisions/local/download')),
      cancelDecisionModel: () => write('decisions', () => client.call('POST /kb/decisions/local/cancel')),
      loadPrivacy: () => read('privacy', () => client.call('GET /kb/settings/privacy')),
      loadAbout: () => read('about', () => client.call('GET /kb/settings/about')),
    };
  });
}
