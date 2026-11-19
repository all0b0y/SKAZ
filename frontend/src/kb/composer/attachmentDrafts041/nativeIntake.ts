import { MAX_IMAGE_BYTES } from '../../../../../electron/nativeIntake041/formats';
import { VIDEO_EXTENSIONS, type ClipboardImageSelection, type NativeIntakeApi, type TrustedMaterialSelection } from '../../../api/bridge';
import type { KbMaterialAdded, KbSpeechMaterial } from '../../../api/kb/types.gen';
import { KbApiError } from '../../api/client';
import type { AttachmentIntake, AttachmentIntakeResult, PreparedAttachment } from './draft';

const VIDEO_EXT = new Set<string>(VIDEO_EXTENSIONS);

/** Both picker APIs use the same classification as Materials and the speech backend. */
export async function prepareSpeechFile(
  name: string, ext: string, load: () => Promise<AttachmentIntakeResult>,
): Promise<PreparedAttachment> {
  return VIDEO_EXT.has(ext) ? { name, importVideo: load } : load();
}

export function prepareDraftSelection(
  bridge: NativeIntakeApi,
  folderId: string | null,
  selection: TrustedMaterialSelection | ClipboardImageSelection,
  onSaved: () => void,
): Promise<PreparedAttachment> {
  const load = () => importDraftSelection(bridge, folderId, selection, onSaved);
  return 'route' in selection && selection.route === 'speech'
    ? prepareSpeechFile(selection.name, selection.ext, load)
    : load();
}

async function importDraftSelection(
  bridge: NativeIntakeApi,
  folderId: string | null,
  selection: TrustedMaterialSelection | ClipboardImageSelection,
  onSaved: () => void,
): Promise<AttachmentIntakeResult> {
  if (!folderId) throw new Error('Connect the library first.');
  const response = await bridge.importSelection({ selectionId: selection.selectionId, folderId, toWiki: false });
  if (!response.ok) throw new KbApiError(response.status, response.detail, response.code);
  const { name } = selection;
  onSaved();

  if ('route' in selection && selection.route === 'speech') {
    const item = response.data as KbSpeechMaterial;
    if (item.status === 'failed') throw new Error('This media import failed. Check the file in Materials.');
    return { id: item.material_id, ready: item.status === 'ready', existing: item.already_in_library, name };
  }

  const item = response.data as KbMaterialAdded;
  if (item.material.status === 'failed') throw new Error('SKAZ could not read this file. Check the file in Materials.');
  let thumbnail: Blob | undefined;
  if (!('category' in selection) || selection.category === 'image') {
    // The trusted boundary prepares previews for disk images, including HEIC, and validated clipboard bytes.
    const preview = await bridge.imagePreview(selection.selectionId).catch(() => null);
    if (preview?.ok) {
      thumbnail = new Blob([new Uint8Array(preview.data.bytes)], { type: preview.data.mimeType });
    }
  }
  return { id: item.material.id, ready: item.material.status === 'ready', existing: item.already_in_library, thumbnail, name };
}

export function nativeAttachmentIntake(
  bridge: NativeIntakeApi | undefined, folderId: string | null, onSaved: () => void,
): AttachmentIntake {
  return async ({ file, source }) => {
    if (!bridge) throw new Error('File drops and image paste are available in the SKAZ desktop chat.');
    if (!folderId) throw new Error('Connect the library first.');
    if (source === 'clipboard') {
      if (file.size > MAX_IMAGE_BYTES) throw new Error('The pasted image is larger than 32 MB.');
      const result = await bridge.validateClipboardImage({
        bytes: await file.arrayBuffer(), mimeType: file.type, suggestedName: file.name === 'image.png' ? undefined : file.name,
      });
      if (!result.ok) throw new Error(result.reason);
      return importDraftSelection(bridge, folderId, result.selection, onSaved);
    }

    // V1 can omit Files whose native path it cannot resolve. Inspect one at a time so every item
    // keeps its identity even when different directories contain files with the same name.
    const batch = await bridge.droppedMaterialFiles([file]);
    const selection = batch.accepted[0];
    if (!selection) {
      throw new Error(batch.rejected[0]?.reason ?? 'SKAZ couldn’t read this dropped file. Choose it on the computer.');
    }
    return prepareDraftSelection(bridge, folderId, selection, onSaved);
  };
}
