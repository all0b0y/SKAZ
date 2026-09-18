import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppLog, MAX_LOG_BYTES } from './logFile';

// The Logs section is only trustworthy if the file it reads is bounded and
// never carries transcript text or credentials. These tests pin the rotation
// arithmetic and the level filter that keeps DEBUG chatter out.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'audiohelper-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AppLog', () => {
  it('writes INFO and above, dropping DEBUG', () => {
    const log = new AppLog(dir);
    log.write('DEBUG', 'app', 'noisy detail');
    log.write('INFO', 'app', 'backend ready');
    log.write('ERROR', 'app', 'backend exited');

    const content = log.read();
    expect(content).not.toContain('noisy detail');
    expect(content).toContain('backend ready');
    expect(content).toContain('backend exited');
  });

  it('creates the logs directory on first write', () => {
    const log = new AppLog(dir);
    expect(existsSync(log.directory)).toBe(false);
    log.write('INFO', 'app', 'first line');
    expect(existsSync(log.filePath)).toBe(true);
  });

  it('keeps the level python already assigned to a backend line', () => {
    const log = new AppLog(dir);
    log.writeBackendChunk('WARNING audiohelper.live: slow finalization\n', 'stdout');
    expect(log.read()).toContain('WARNING [backend] WARNING audiohelper.live: slow finalization');
  });

  it('records unlabelled stderr output as ERROR', () => {
    const log = new AppLog(dir);
    log.writeBackendChunk('Traceback (most recent call last):\n', 'stderr');
    expect(log.read()).toContain('ERROR [backend] Traceback');
  });

  it('records a python warning on stderr as WARNING, not ERROR', () => {
    const log = new AppLog(dir);
    log.writeBackendChunk(
      'site-packages/uvicorn/protocols/websockets_impl.py:41: UvicornDeprecationWarning: deprecated\n',
      'stderr',
    );
    const content = log.read();
    expect(content).toContain('WARNING [backend]');
    expect(content).not.toContain('ERROR [backend]');
  });

  it('still records a real stderr failure as ERROR', () => {
    const log = new AppLog(dir);
    log.writeBackendChunk('ConnectionRefusedError: [Errno 61] Connection refused\n', 'stderr');
    expect(log.read()).toContain('ERROR [backend]');
  });

  it('ignores blank lines in a backend chunk', () => {
    const log = new AppLog(dir);
    log.writeBackendChunk('\n\n  \n', 'stdout');
    expect(log.read()).toBe('');
  });

  it('rotates app.log to app.log.1 once it exceeds the size cap', () => {
    const log = new AppLog(dir);
    mkdirSync(log.directory, { recursive: true });
    writeFileSync(log.filePath, 'x'.repeat(MAX_LOG_BYTES + 1), 'utf8');

    log.write('INFO', 'app', 'line after rotation');

    expect(existsSync(`${log.filePath}.1`)).toBe(true);
    const current = readFileSync(log.filePath, 'utf8');
    expect(current).toContain('line after rotation');
    // The oversized content moved aside instead of growing without bound.
    expect(current.length).toBeLessThan(MAX_LOG_BYTES);
  });

  it('discards the oldest file instead of keeping more than MAX_LOG_FILES', () => {
    const log = new AppLog(dir);
    mkdirSync(log.directory, { recursive: true });
    writeFileSync(`${log.filePath}.2`, 'oldest', 'utf8');
    writeFileSync(`${log.filePath}.1`, 'older', 'utf8');
    writeFileSync(log.filePath, 'x'.repeat(MAX_LOG_BYTES + 1), 'utf8');

    log.write('INFO', 'app', 'newest');

    expect(readFileSync(`${log.filePath}.2`, 'utf8')).toBe('older');
    expect(existsSync(`${log.filePath}.3`)).toBe(false);
  });

  it('returns an empty string when no log file exists yet', () => {
    expect(new AppLog(dir).read()).toBe('');
  });

  it('tails the file rather than returning everything', () => {
    const log = new AppLog(dir);
    for (let i = 0; i < 200; i += 1) log.write('INFO', 'app', `line ${i}`);
    const tail = log.read(200);
    expect(tail.length).toBeLessThanOrEqual(200);
    expect(tail).toContain('line 199');
  });
});
