// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_EXTENSIONS, MATERIAL_EXTENSIONS, SPEECH_EXTENSIONS, VIDEO_EXTENSIONS } from './bridge';
import { fileItem, itemMeta, UNSUPPORTED_FILE } from '../kb/materials/addItems';

const backend = (path: string) => readFileSync(resolve(__dirname, '../../../backend/src/skaz', path), 'utf8');

/** The quoted words of the first literal after `name … =` (a tuple, set or frozenset). */
function pythonWords(source: string, name: string): string[] {
  const start = source.indexOf(`${name}`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const value = source.slice(source.indexOf('=', start) + 1);
  const literal = /[([{]([^)\]}]*)[)\]}]/.exec(value)![1]!;
  return [...literal.matchAll(/"\.?([a-z0-9]+)"/g)].map((m) => m[1]!);
}

describe('the material chooser offers only what the backend takes (QA B2)', () => {
  it('documents = intake PDF | TEXT, speech = provider list + video containers', () => {
    const intake = backend('knowledge/sources/intake.py');
    const documents = [...pythonWords(intake, 'TEXT_EXTENSIONS'), ...pythonWords(intake, 'PDF_EXTENSIONS')];
    expect([...DOCUMENT_EXTENSIONS].sort()).toEqual(documents.sort());
    const provider = pythonWords(backend('gateways/soniox_async.py'), 'SUPPORTED_EXTENSIONS');
    const video = pythonWords(backend('knowledge/speech/media.py'), 'VIDEO_EXTENSIONS');
    expect([...SPEECH_EXTENSIONS].sort()).toEqual([...new Set([...provider, ...video])].sort());
    expect([...VIDEO_EXTENSIONS].sort()).toEqual(video.sort());
    expect(MATERIAL_EXTENSIONS).not.toContain('rtf');
    expect(MATERIAL_EXTENSIONS).not.toContain('html');
    expect(MATERIAL_EXTENSIONS).not.toContain('epub');
  });

  it('a file SKAZ can’t read is marked before Add; audio/video go to the import', () => {
    for (const name of ['page.html', 'doc.rtf', 'book.epub', 'report.docx', 'photo.png']) {
      const item = fileItem(`/a/${name}`, name, 10);
      expect(item.kind, name).toBe('unsupported');
      expect(itemMeta(item)).toBe(UNSUPPORTED_FILE);
    }
    for (const name of ['a.wav', 'b.m4a', 'c.flac', 'd.aiff', 'e.mp4', 'f.MOV']) expect(fileItem(`/a/${name}`, name, 1).kind, name).toBe('speech');
    for (const name of ['a.pdf', 'b.md', 'c.TXT', 'd.markdown']) expect(fileItem(`/a/${name}`, name, 1).kind, name).toBe('document');
  });
});
