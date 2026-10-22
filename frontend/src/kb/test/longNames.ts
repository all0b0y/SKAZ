// U1 layout smoke (scripts/kb-u1.smoke.spec.ts): the same fake worlds with long RU/EN names, so the
// Edit models and "Add a provider to Hermes" windows and the study block are checked at their worst.
// Browser harness only; never part of the app build.

import type { KbAgent } from '../../api/kb/types.gen';
import type { EngineId } from '../api/names';
import type { FakeWorld } from './fakeKb';

export const LONG_PROVIDER = 'OpenRouter — агрегатор моделей с очень длинным названием провайдера (EU region)';
export const LONG_MODEL = 'Очень длинное человеческое имя модели для проверки переносов — preview edition';
export const LONG_DECK = 'ИТ-аудит: карточки по презентации PowerPoint о внутреннем контроле и управлении рисками';

interface Helpers {
  agent: (id: EngineId, name: string, state: KbAgent['state'], extra?: Partial<KbAgent>) => KbAgent;
  providersOf: (models: ReadonlyArray<KbAgent['models'][number]>) => KbAgent['providers'];
}

export function stretchNames(world: FakeWorld, { agent, providersOf }: Helpers): void {
  const models: KbAgent['models'] = [0, 1, 2].map((i) => ({
    id: `openrouter/very-long-vendor-name/extremely-long-model-identifier-${i}-2026-10-20-preview`,
    label: `extremely-long-model-identifier-${i}`, efforts: ['low', 'medium', 'high'], default_effort: 'medium',
    provider: 'openrouter', provider_label: LONG_PROVIDER, name: `${LONG_MODEL} ${i + 1}`, tag: null,
    visible: true, default_visible: true, favorite: false,
  }));
  const at = world.agents.agents.findIndex((a) => a.id === 'hermes');
  world.agents.agents[at] = agent('hermes', 'Hermes Agent', 'ready', {
    models, current_model: models[0]!.id, providers: providersOf(models), first_run: { checked: true, note: '' },
  });
  world.hermesProviders.catalog = world.hermesProviders.catalog.map((item, i) => (i % 2
    ? { ...item, name: `${item.name} — очень длинное название провайдера для проверки отступов` } : item));
  world.hermesProviders.catalog_checked = '2026-10-20 · Hermes v0.22.2+179.gb51e8b8 · canary build from a git checkout';
  for (const chat of world.chats) {
    for (const message of chat.messages) {
      for (const part of message.parts as Array<{ type: string; title?: string; save?: { path: string } }>) {
        if (part.type === 'study' && part.title) {
          part.title = `${LONG_DECK} (${part.title})`;
          if (part.save) part.save.path = part.save.path.replace(/[^/]+\.md$/, `${part.title.replace(':', '')}.md`);
        }
      }
    }
  }
}
