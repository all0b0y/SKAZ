import type { ComponentType } from 'react';
import type {
  KbAreaMaterial,
  KbExploring,
  KbFinding,
  KbFunnelRun,
} from '../../api/kb/types.gen';
import { createAreasClient, type AreasClient } from '../api/areas';
import {
  createExploreClient,
  type ExploreClient,
  type ExploreFindingStart,
  type FindingToWikiBody,
} from '../api/explore';
import { createRepeatsClient, type RepeatsClient } from '../api/repeats';
import { createScienceClient, type ScienceClient } from '../api/science';
import type { KbBridge } from '../state/context';
import type { DocTarget } from '../state/document';
import type { SettingsSection } from '../state/ui';
import type { IconName } from '../ui';

export interface ExploreClients {
  areas: AreasClient;
  explore: ExploreClient;
  science: ScienceClient;
  repeats: RepeatsClient;
}

export function createExploreClients(bridge: KbBridge): ExploreClients {
  return {
    areas: createAreasClient(bridge),
    explore: createExploreClient(bridge),
    science: createScienceClient(bridge),
    repeats: createRepeatsClient(bridge),
  };
}

export interface FindingHostProps {
  finding: KbFinding;
  scopeName: string;
  initialMenuOpen?: boolean;
  onBack: () => void;
  onExplore: (findingId: string, body: ExploreFindingStart) => Promise<KbExploring | void>;
  onAddToWiki: (findingId: string, body?: FindingToWikiBody) => Promise<void>;
  onOpenDocument?: (target: DocTarget) => void;
}

export type FindingHostComponent = ComponentType<FindingHostProps>;

export interface ExploreSectionProps {
  hidden?: boolean;
  clients?: ExploreClients;
  FindingComponent?: FindingHostComponent;
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
  already_knew_this: 'Already knew this',
  not_for_me: 'Not for me',
};

export const MATERIAL_KIND_ICON: Record<KbAreaMaterial['kind'], IconName> = {
  audio: 'audio',
  recording: 'mic',
  video: 'video',
  pdf: 'pdf',
  book: 'materials',
  article: 'pdf',
  web: 'link',
  text: 'text',
  note: 'wiki',
};
