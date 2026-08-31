import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { nowIso } from './util.js';
import { logger } from './log.js';

const log = logger('audit');

export interface AuditEntry {
  at: string;
  token: string;          // token name
  tokenId: string;
  action: string;         // e.g. 'runs.submit', 'artifacts.upload', 'auth.denied'
  outcome: 'ok' | 'denied' | 'error';
  remote?: string;
  runId?: string;
  detail?: Record<string, unknown>;
}

/**
 * Append-only JSONL record of everything that mutates state or is refused.
 * Keeps the answer to "what did that token do" a `grep` away, which matters
 * once more than one agent can reach the daemon.
 */
export class AuditLog {
  private file: string;
  private stream?: fs.WriteStream;

  constructor(cfg: Config) {
    this.file = path.join(cfg.home, 'audit.log');
  }

  open(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.stream = fs.createWriteStream(this.file, { flags: 'a', mode: 0o600 });
    this.stream.on('error', (e) => log.warn('audit log write failed', e.message));
  }

  record(entry: Omit<AuditEntry, 'at'>): void {
    const line = JSON.stringify({ at: nowIso(), ...entry });
    if (this.stream) this.stream.write(line + '\n');
    // Denials are worth seeing in the daemon log too, not just on disk.
    if (entry.outcome !== 'ok') log.warn(`${entry.action} ${entry.outcome}`, entry.detail ?? {});
  }

  path(): string { return this.file; }
}
