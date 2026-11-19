// Preload-safe boundary helper (no Node built-ins) so sandboxed preloads never pull `node:*` modules.

import type {
  ClipboardImageInput,
  ClipboardImageValidation,
  MaterialIntakeBatch,
  NativeIntakeBridgeApi,
  NativeIntakeImagePreview,
  NativeIntakeImportRequest,
  PreloadNativeIntakeApi,
} from './contracts';
import type { JsonResponse } from '../../frontend/src/api/bridge';

export interface PreloadIntakeChannels {
  chooseMaterialFiles: string;
  droppedMaterialFiles: string;
  validateClipboardImage: string;
  importSelection?: string;
  imagePreview?: string;
}

export function createPreloadIntakeBoundary(bridge: {
  getPathForFile: (file: File) => string;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  channels: PreloadIntakeChannels;
}): PreloadNativeIntakeApi {
  const base: PreloadNativeIntakeApi = {
    chooseMaterialFiles: () =>
      bridge.invoke(bridge.channels.chooseMaterialFiles) as Promise<MaterialIntakeBatch>,
    droppedMaterialFiles: (files) => {
      const paths: string[] = [];
      for (const file of files) {
        const path = bridge.getPathForFile(file);
        if (path) paths.push(path);
      }
      if (paths.length === 0) return Promise.resolve({ accepted: [], rejected: [] });
      return bridge.invoke(bridge.channels.droppedMaterialFiles, paths) as Promise<MaterialIntakeBatch>;
    },
    validateClipboardImage: (input: ClipboardImageInput) =>
      bridge.invoke(bridge.channels.validateClipboardImage, {
        bytes: input.bytes,
        mimeType: input.mimeType,
        suggestedName: input.suggestedName,
      }) as Promise<ClipboardImageValidation>,
  };

  if (bridge.channels.importSelection && bridge.channels.imagePreview) {
    const importChannel = bridge.channels.importSelection;
    const previewChannel = bridge.channels.imagePreview;
    const full: NativeIntakeBridgeApi = {
      ...base,
      importSelection: (request: NativeIntakeImportRequest) =>
        bridge.invoke(importChannel, {
          selectionId: request.selectionId,
          folderId: request.folderId,
          title: request.title ?? null,
          toWiki: request.toWiki ?? null,
          language: request.language ?? null,
          translate: request.translate === true,
        }) as Promise<JsonResponse<unknown>>,
      imagePreview: (selectionId: string) =>
        bridge.invoke(previewChannel, selectionId) as Promise<JsonResponse<NativeIntakeImagePreview>>,
    };
    return full;
  }

  return base;
}
