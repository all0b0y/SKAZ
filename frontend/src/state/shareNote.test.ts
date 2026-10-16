import { describe, expect, it } from 'vitest';
import { shareableNote } from './shareNote';
import { shareFileName } from '../../../electron/ipcPolicy';

describe('shared note file (spec §5)', () => {
  it('keeps a note that already opens with its heading, adds nothing', () => {
    const shared = shareableNote({ title: '', content: '# Лекция 1\n\nТекст.\n\n\n' }, 'Session');
    expect(shared).toEqual({ fileName: 'Лекция 1', content: '# Лекция 1\n\nТекст.\n' });
  });

  it('puts the stored title on top when the text has no heading', () => {
    const shared = shareableNote({ title: 'Устойчивость', content: 'Первая мысль.' }, 'Session');
    expect(shared).toEqual({ fileName: 'Устойчивость', content: '# Устойчивость\n\nПервая мысль.\n' });
  });

  it('names an empty untitled note after its session', () => {
    expect(shareableNote({ content: '' }, '19.09.2026, 14:05').fileName).toBe('Notes — 19.09.2026, 14:05');
  });

  it('never carries the session-folder service tail', () => {
    const shared = shareableNote({ title: 'T', content: '# T\n\nТекст.' }, null);
    expect(shared.content).not.toMatch(/Sources|revision/);
  });
});

describe('share file name policy in main', () => {
  it('accepts a plain name and always appends .md itself', () => {
    expect(shareFileName({ fileName: 'Лекция 1', content: 'x' })).toBe('Лекция 1.md');
    expect(shareFileName({ fileName: 'Лекция.md.md', content: 'x' })).toBe('Лекция.md');
    expect(shareFileName({ fileName: 'run.sh', content: 'x' })).toBe('run.sh.md');
  });

  it('cannot address a path outside its own directory', () => {
    expect(shareFileName({ fileName: '../../etc/passwd', content: 'x' })).toBe('etc passwd.md');
    expect(shareFileName({ fileName: '/Users/x/.ssh/id', content: 'x' })).toBe('Users x .ssh id.md');
    expect(shareFileName({ fileName: '..', content: 'x' })).toBeNull();
    expect(shareFileName({ fileName: '.hidden', content: 'x' })).toBe('hidden.md');
  });

  it('refuses control characters, wrong types and oversized text', () => {
    expect(shareFileName({ fileName: 'a\u0000b', content: 'x' })).toBeNull();
    expect(shareFileName({ fileName: 'a\nb', content: 'x' })).toBe('a b.md');
    expect(shareFileName({ fileName: 42 as unknown as string, content: 'x' })).toBeNull();
    expect(shareFileName({ fileName: 'a', content: 'x'.repeat(2 * 1024 * 1024 + 1) })).toBeNull();
  });
});
