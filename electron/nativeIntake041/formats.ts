// Standalone format classification, byte bounds, and header sniffing for SKAZ 0.4.1 native intake.

export const TEXT_EXTENSIONS = ['txt', 'md', 'markdown'] as const;
export const PDF_EXTENSIONS = ['pdf'] as const;
export const DOCX_EXTENSIONS = ['docx'] as const;
export const DOCUMENT_EXTENSIONS = [...PDF_EXTENSIONS, ...TEXT_EXTENSIONS, ...DOCX_EXTENSIONS, 'pptx', 'key'] as const;
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic'] as const;
export const AUDIO_EXTENSIONS = [
  'aac', 'aiff', 'amr', 'asf', 'flac', 'm4a', 'mp3', 'mp4', 'ogg', 'wav', 'webm',
] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi'] as const;
export const SPEECH_EXTENSIONS = [...AUDIO_EXTENSIONS, 'mkv', 'mov', 'avi', 'm4v'] as const;
export const MATERIAL_EXTENSIONS = [...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS, ...SPEECH_EXTENSIONS] as const;

export const MAX_TEXT_BYTES = 64 * 1024 * 1024;
export const MAX_PDF_BYTES = 200 * 1024 * 1024;
export const MAX_DOCX_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_SPEECH_BYTES = 2 * 1024 * 1024 * 1024;
export const HEADER_SNIFF_BYTES = 64;
export const MAX_CHOSEN_FILES = 2000;

export type IntakeCategory = 'text' | 'pdf' | 'docx' | 'presentation' | 'image' | 'speech';
export type IntakeRoute = 'document' | 'image' | 'speech';
export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'heic';

export interface ClassifiedMaterialExtension {
  ext: string;
  category: IntakeCategory;
  route: IntakeRoute;
  formatId: string;
  mimeType: string;
  maxBytes: number;
  isNew041: boolean;
  nativePreviewable: boolean;
}

const IMAGE_META: Record<string, { formatId: ImageFormat; mimeType: string; nativePreviewable: boolean }> = {
  jpg: { formatId: 'jpeg', mimeType: 'image/jpeg', nativePreviewable: true },
  jpeg: { formatId: 'jpeg', mimeType: 'image/jpeg', nativePreviewable: true },
  png: { formatId: 'png', mimeType: 'image/png', nativePreviewable: true },
  webp: { formatId: 'webp', mimeType: 'image/webp', nativePreviewable: true },
  heic: { formatId: 'heic', mimeType: 'image/heic', nativePreviewable: false },
};

const SPEECH_MIME: Record<string, string> = {
  aac: 'audio/aac',
  aiff: 'audio/aiff',
  amr: 'audio/amr',
  asf: 'video/x-ms-asf',
  avi: 'video/x-msvideo',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'video/webm',
};

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);

export function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

export function extensionOf(fileNameOrPath: string): string | null {
  const name = baseName(fileNameOrPath);
  const match = /\.([^.]+)$/.exec(name);
  if (!match?.[1]) return null;
  return match[1].toLowerCase();
}

export function classifyMaterialExtension(fileNameOrPath: string): ClassifiedMaterialExtension | null {
  const ext = extensionOf(fileNameOrPath);
  if (!ext) return null;

  if (ext === 'txt' || ext === 'md' || ext === 'markdown') {
    const isMd = ext !== 'txt';
    return {
      ext,
      category: 'text',
      route: 'document',
      formatId: isMd ? 'markdown' : 'txt',
      mimeType: isMd ? 'text/markdown' : 'text/plain',
      maxBytes: MAX_TEXT_BYTES,
      isNew041: false,
      nativePreviewable: false,
    };
  }
  if (ext === 'pdf') {
    return {
      ext,
      category: 'pdf',
      route: 'document',
      formatId: 'pdf',
      mimeType: 'application/pdf',
      maxBytes: MAX_PDF_BYTES,
      isNew041: false,
      nativePreviewable: false,
    };
  }
  if (ext === 'docx') {
    return {
      ext,
      category: 'docx',
      route: 'document',
      formatId: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      maxBytes: MAX_DOCX_BYTES,
      isNew041: true,
      nativePreviewable: false,
    };
  }
  if (ext === 'pptx' || ext === 'key') {
    return { ext, category: 'presentation', route: 'document', formatId: ext,
      mimeType: ext === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/vnd.apple.keynote',
      maxBytes: MAX_PDF_BYTES, isNew041: true, nativePreviewable: false };
  }
  const img = IMAGE_META[ext];
  if (img) {
    return {
      ext,
      category: 'image',
      route: 'image',
      formatId: img.formatId,
      mimeType: img.mimeType,
      maxBytes: MAX_IMAGE_BYTES,
      isNew041: true,
      nativePreviewable: img.nativePreviewable,
    };
  }
  const speechMime = SPEECH_MIME[ext];
  if (speechMime) {
    return {
      ext,
      category: 'speech',
      route: 'speech',
      formatId: ext,
      mimeType: speechMime,
      maxBytes: MAX_SPEECH_BYTES,
      isNew041: false,
      nativePreviewable: false,
    };
  }
  return null;
}

function asciiAt(buf: Uint8Array, start: number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += String.fromCharCode(buf[start + i] ?? 0);
  }
  return out;
}

export function sniffImageHeader(head: Uint8Array): ImageFormat | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'jpeg';
  }
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return 'png';
  }
  if (head.length >= 12 && asciiAt(head, 0, 4) === 'RIFF' && asciiAt(head, 8, 4) === 'WEBP') {
    return 'webp';
  }
  if (head.length >= 12 && asciiAt(head, 4, 4) === 'ftyp') {
    const boxSize =
      ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
    if (boxSize === 0 || boxSize >= 12) {
      const limit = boxSize === 0 ? head.length : Math.min(head.length, boxSize);
      const major = asciiAt(head, 8, 4);
      if (HEIC_BRANDS.has(major)) return 'heic';
      for (let offset = 16; offset + 4 <= limit; offset += 4) {
        if (HEIC_BRANDS.has(asciiAt(head, offset, 4))) return 'heic';
      }
    }
  }
  return null;
}

export function verifyHeaderForExtension(
  head: Uint8Array,
  classified: ClassifiedMaterialExtension,
): string | null {
  if (head.length === 0) return 'This file is empty.';
  if (classified.category === 'pdf') {
    return asciiAt(head, 0, 5) === '%PDF-' ? null : "This file isn't a valid PDF document.";
  }
  if (classified.category === 'docx' || classified.category === 'presentation') {
    const isZip =
      head.length >= 4 &&
      head[0] === 0x50 &&
      head[1] === 0x4b &&
      ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06));
    return isZip ? null : `This file isn't a valid ${classified.formatId.toUpperCase()} document.`;
  }
  if (classified.category === 'image') {
    const detected = sniffImageHeader(head);
    if (detected !== classified.formatId) {
      return `This file doesn't match a valid ${classified.formatId.toUpperCase()} image.`;
    }
    return null;
  }
  if (classified.category === 'text') {
    const isUtf16Bom =
      head.length >= 2 &&
      ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff));
    if (isUtf16Bom) return null;
    for (let i = 0; i < head.length; i += 1) {
      if (head[i] === 0) return "This isn't a text file. SKAZ reads .txt and .md files that hold text.";
    }
    return null;
  }
  return null;
}
