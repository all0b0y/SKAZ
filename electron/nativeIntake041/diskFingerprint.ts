// Bounded, chunked async SHA-256 fingerprinting for main-process disk selections (no whole-file copies).

import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { HEADER_SNIFF_BYTES } from './formats';
import type { BoundedFileFingerprint } from './trustedIntake';

export const HASH_CHUNK_BYTES = 64 * 1024;

export interface BoundedDiskHandle {
  stat(): Promise<{ isFile(): boolean; size: number }>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface HashBoundedDiskOptions {
  chunkBytes?: number;
  openFile?: (path: string) => Promise<BoundedDiskHandle>;
}

/**
 * Stream-hash a regular file up to `maxBytes` using async chunked I/O and a single fixed buffer.
 * Yields to the event loop between chunks and returns `null` if the file is missing, non-regular,
 * empty, modified mid-read, or exceeds `maxBytes`.
 */
export async function hashBoundedDiskFile(
  path: string,
  maxBytes: number,
  options?: HashBoundedDiskOptions,
): Promise<BoundedFileFingerprint | null> {
  if (maxBytes <= 0) return null;
  const chunkBytes = options?.chunkBytes && options.chunkBytes > 0 ? options.chunkBytes : HASH_CHUNK_BYTES;
  const openFile = options?.openFile ?? ((filePath: string) => open(filePath, 'r'));

  let handle: BoundedDiskHandle | null = null;
  try {
    handle = await openFile(path);
    const st = await handle.stat();
    if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return null;

    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(chunkBytes);
    const headParts: Buffer[] = [];
    let headLen = 0;
    let total = 0;

    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead <= 0) break;
      total += bytesRead;
      if (total > maxBytes) return null;
      const slice = chunk.subarray(0, bytesRead);
      if (headLen < HEADER_SNIFF_BYTES) {
        const take = Math.min(HEADER_SNIFF_BYTES - headLen, bytesRead);
        headParts.push(Buffer.from(slice.subarray(0, take)));
        headLen += take;
      }
      hash.update(slice);
    }

    if (total <= 0 || total !== st.size) return null;
    const head = new Uint8Array(Buffer.concat(headParts, headLen));
    return { size: total, sha256: hash.digest('hex'), head };
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
  }
}
