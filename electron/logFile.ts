// Append-only application log with size-bounded rotation.
//
// Everything the desktop process already captures — its own lifecycle events
// and the backend's stdout/stderr — is mirrored here so Settings → Logs can
// show what happened without asking the user to run the app from a terminal.
//
// Deliberately NOT logged: transcript text, assistant answers, notes, API keys
// or bearer tokens. The backend never prints those at INFO, and this module
// adds no payload of its own; see AGENTS.md (no secrets in logs, audio text is
// untrusted data rather than diagnostics).

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const MAX_LOG_FILES = 3;

export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };
/** INFO and above, per the agreed policy; DEBUG lines are dropped. */
const MIN_LEVEL: LogLevel = 'INFO';

/** Recognise the level a backend line already carries, so it is not relabelled. */
const BACKEND_LEVEL = /^(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\b/;
/**
 * Python warnings arrive on stderr without a level prefix. Calling a
 * DeprecationWarning an ERROR would cry wolf in the Logs panel, so they are
 * recorded at WARNING and only genuine failures stay ERROR.
 */
const PY_WARNING = /\b\w*Warning\b|^\s*warnings\.warn\(/;

function normaliseLevel(raw: string): LogLevel {
  if (raw === 'WARN') return 'WARNING';
  if (raw === 'CRITICAL') return 'ERROR';
  return raw as LogLevel;
}

export class AppLog {
  private readonly dir: string;
  private readonly file: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'logs');
    this.file = join(this.dir, 'app.log');
  }

  get filePath(): string {
    return this.file;
  }

  get directory(): string {
    return this.dir;
  }

  /** Roll app.log → app.log.1 → app.log.2 once it outgrows MAX_LOG_BYTES. */
  private rotateIfNeeded(): void {
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      return; // no file yet
    }
    if (size < MAX_LOG_BYTES) return;

    const oldest = `${this.file}.${MAX_LOG_FILES - 1}`;
    if (existsSync(oldest)) rmSync(oldest, { force: true });
    for (let i = MAX_LOG_FILES - 2; i >= 1; i -= 1) {
      const from = `${this.file}.${i}`;
      if (existsSync(from)) renameSync(from, `${this.file}.${i + 1}`);
    }
    renameSync(this.file, `${this.file}.1`);
  }

  write(level: LogLevel, source: string, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
    const text = message.replace(/\s+$/, '');
    if (!text) return;
    const line = `${new Date().toISOString()} ${level} [${source}] ${text}\n`;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.rotateIfNeeded();
      appendFileSync(this.file, line, 'utf8');
    } catch {
      // Logging must never take the app down; a failed write is dropped.
    }
  }

  /**
   * Mirror a raw backend chunk. Each line keeps the level Python already
   * assigned it (``LEVEL name: message``); anything else is recorded at INFO
   * on stdout and ERROR on stderr, which is where uvicorn tracebacks land.
   */
  writeBackendChunk(chunk: string, stream: 'stdout' | 'stderr'): void {
    for (const raw of chunk.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const matched = BACKEND_LEVEL.exec(line);
      const level = matched
        ? normaliseLevel(matched[1]!)
        : stream === 'stderr'
          ? PY_WARNING.test(line)
            ? 'WARNING'
            : 'ERROR'
          : 'INFO';
      this.write(level, 'backend', line);
    }
  }

  /** Newest-last tail of the current file, for the Logs settings section. */
  read(maxBytes = 256 * 1024): string {
    try {
      const content = readFileSync(this.file, 'utf8');
      return content.length > maxBytes ? content.slice(content.length - maxBytes) : content;
    } catch {
      return '';
    }
  }
}
