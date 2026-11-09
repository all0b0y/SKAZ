import type { MaintenanceClient } from '../maintenance';
import { contractFixtures as f } from './fixtures';

export function createFakeMaintenanceClient(): MaintenanceClient {
  return {
    page_marks: async () => structuredClone(f.KbFreshnessMarks),
    settings: async () => structuredClone(f.KbWeeklySettings),
    update_settings: async () => structuredClone(f.KbWeeklySettings),
    start: async () => structuredClone(f.KbWeeklyCheck),
    check: async () => structuredClone(f.KbWeeklyCheck),
    pause: async () => structuredClone(f.KbWeeklyCheck),
    resume: async () => structuredClone(f.KbWeeklyCheck),
    marks: async () => structuredClone(f.KbFreshnessMarks),
    act: async () => structuredClone(f.KbFreshnessActionResult),
  };
}
