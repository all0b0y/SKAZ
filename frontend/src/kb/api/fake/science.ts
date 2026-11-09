import type { ScienceClient } from '../science';
import { contractFixtures as f } from './fixtures';

export function createFakeScienceClient(): ScienceClient {
  return {
    settings: async () => structuredClone(f.KbScienceSettings),
    update_settings: async () => structuredClone(f.KbScienceSettings),
    set_key: async () => structuredClone(f.KbScienceSettings),
    search: async () => structuredClone(f.KbScienceResults),
    work: async () => structuredClone(f.KbScienceWork),
    read_text: async () => structuredClone(f.KbScienceText),
    journal: async () => structuredClone(f.KbScienceJournal),
    dismiss_hint: async () => structuredClone(f.KbScienceSettings),
  };
}
