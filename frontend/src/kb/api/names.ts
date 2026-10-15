// Short names for unions of the generated /kb contract (types.gen.ts, made from the backend
// OpenAPI schema). Nothing here declares a shape of its own: every name is a field of a generated
// model, so a backend change still breaks `npm run typecheck` where it matters.

import type {
  KbAgent, KbKeyStatus, KbMaterialSummary, KbMessage, KbPage, KbSettingsSection,
} from '../../api/kb/types.gen';

export type EngineId = KbAgent['id'];
export type AgentState = KbAgent['state'];
export type MaterialKind = KbMaterialSummary['kind'];
export type KbWikiState = KbMaterialSummary['wiki_state'];
export type PageKind = KbPage['kind'];
export type MessageState = KbMessage['state'];
export type KeyProviderId = KbKeyStatus['id'];
export type HealthSectionId = KbSettingsSection['id'];
