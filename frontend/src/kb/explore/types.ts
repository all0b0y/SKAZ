import type { ComponentType } from 'react';
import { createDiscoveryClient, createTopicActions, type DiscoveryClient, type TopicActions } from './clients';
import type {
  KbAreaMaterial,
  KbContinue,
  KbExploreStart,
  KbExploring,
  KbFindingImport,
  KbFinding,
  KbFunnelRun,
} from '../../api/kb/types.gen';
import { createAreasClient, type AreasClient } from '../api/areas';
import { createExploreClient, type ExploreClient } from '../api/explore';
import { createMaintenanceClient, type MaintenanceClient } from '../api/maintenance';
import { createRepeatsClient, type RepeatsClient } from '../api/repeats';
import { createScienceClient, type ScienceClient } from '../api/science';
import type { KbClient } from '../api/client';
import type { DocTarget } from '../state/document';
import type { SettingsSection } from '../state/ui';
import type { IconName } from '../ui';

export interface ExploreClients {
  areas: AreasClient;
  explore: ExploreClient;
  science: ScienceClient;
  repeats: RepeatsClient;
  maintenance: MaintenanceClient;
  topics?: TopicActions;
  discovery?: DiscoveryClient;
}

export function createExploreClients(client: Pick<KbClient, 'call'>): ExploreClients {
  return {
    topics: createTopicActions(client),
    discovery: createDiscoveryClient(client),
    areas: createAreasClient(client),
    explore: createExploreClient(client),
    science: createScienceClient(client),
    repeats: createRepeatsClient(client),
    maintenance: createMaintenanceClient(client),
  };
}

/** What F3's finding component sends when the user picks Brief tour / Deep dive / Notes. */
export type ExploreFindingStart = KbExploreStart;
/** What F3's finding component sends for Add to wiki. */
export type FindingToWikiBody = KbFindingImport;
/** Continue from a checkpoint; `decision_choice` answers `decision_model_required`. */
export type ExploreResumeBody = Pick<KbContinue, 'decision_choice'>;

export interface FindingHostProps {
  finding: KbFinding;
  scopeName: string;
  initialMenuOpen?: boolean;
  onBack: () => void;
  onExplore: (findingId: string, body: ExploreFindingStart) => Promise<KbExploring | void>;
  onAddToWiki: (findingId: string, body: FindingToWikiBody) => Promise<void>;
  onOpenDocument?: (target: DocTarget) => void;
}

export type FindingHostComponent = ComponentType<FindingHostProps>;

export interface ExploreSectionProps {
  hidden?: boolean;
  clients?: ExploreClients;
  onOpenDocument?: (target: DocTarget) => void;
  onOpenSettings?: (section?: SettingsSection) => void;
}

export const STAGE_STEP: Record<KbFunnelRun['stage'], number> = {
  collect: 1,
  rules: 2,
  links: 2,
  decision: 3,
  repeats: 3,
  novelty: 4,
  ready: 5,
};

export const FINDING_LABEL_TEXT: Record<KbFinding['label'], string> = {
  contradicts: 'Contradicts your wiki',
  new: 'New',
  extends: 'Extends',
  branch: 'Branch',
  covered: 'Already in your wiki',
};

export const READ_MARK_LABEL: Record<NonNullable<KbAreaMaterial['read_mark']>, string> = {
  useful_method: 'Useful method',
  changed_my_view: 'Changed my view',
  already_knew: 'Already knew this',
  not_for_me: 'Not for me',
};

export const MATERIAL_KIND_ICON: Record<KbAreaMaterial['kind'], IconName> = {
  audio: 'audio',
  recording: 'mic',
  video: 'video',
  pdf: 'pdf',
  book: 'materials',
  video_link: 'link',
  web: 'link',
  text: 'text',
};

/** "Mon", "Tue"… for a timestamp in the viewer's time zone; null when there is no usable date. */
export function weekdayShort(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { weekday: 'short' });
}
