// Typed public boundary between Electron preload/main (V1) and renderer attachment intake (V2).

import type { JsonResponse } from '../../frontend/src/api/bridge';
import type { ImageFormat, IntakeCategory, IntakeRoute } from './formats';

export type SelectionSource = 'picker' | 'drop' | 'clipboard';

export interface TrustedMaterialSelection {
  /** Opaque selection token issued by main so the renderer cannot pass arbitrary paths. */
  selectionId: string;
  /** Real resolved OS path (forwarded to the local backend via trusted main/IPC). */
  path: string;
  /** Original basename preserved as source identity. */
  name: string;
  /** Verified byte size at selection time. */
  size: number;
  /** Verified SHA-256 content hash (lowercase hex) at selection time when version-pinned (`docx` and `image`). */
  sha256?: string;
  /** Lowercase extension without leading dot. */
  ext: string;
  formatId: string;
  category: IntakeCategory;
  route: IntakeRoute;
  mimeType: string;
  source: SelectionSource;
  /** True when Chromium can render the image directly (`jpeg`/`png`/`webp`); false for `heic` and docs. */
  nativePreviewable: boolean;
}

export interface RejectedMaterialSelection {
  name: string;
  reason: string;
  source: SelectionSource;
}

export interface MaterialIntakeBatch {
  accepted: TrustedMaterialSelection[];
  rejected: RejectedMaterialSelection[];
}

export interface ClipboardImageInput {
  bytes: ArrayBuffer;
  mimeType: string;
  suggestedName?: string;
}

export interface ClipboardImageSelection {
  selectionId: string;
  name: string;
  size: number;
  formatId: ImageFormat;
  mimeType: string;
  source: 'clipboard';
  nativePreviewable: boolean;
}

export type ClipboardImageValidation =
  | { ok: true; selection: ClipboardImageSelection }
  | { ok: false; reason: string };

export interface NativeIntakeImportRequest {
  selectionId: string;
  folderId: string;
  title?: string | null;
  toWiki?: boolean | null;
  language?: string | null;
  translate?: boolean;
}

export interface NativeIntakeImagePreview {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: Uint8Array;
}

export interface PreloadNativeIntakeApi {
  chooseMaterialFiles(): Promise<MaterialIntakeBatch>;
  droppedMaterialFiles(files: readonly File[]): Promise<MaterialIntakeBatch>;
  validateClipboardImage(input: ClipboardImageInput): Promise<ClipboardImageValidation>;
}

export interface NativeIntakeBridgeApi extends PreloadNativeIntakeApi {
  importSelection(request: NativeIntakeImportRequest): Promise<JsonResponse<unknown>>;
  imagePreview(selectionId: string): Promise<JsonResponse<NativeIntakeImagePreview>>;
}
