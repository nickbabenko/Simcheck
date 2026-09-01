import fs from 'node:fs';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.SIMCHECK_LOG_LEVEL as Level) || 'info'] ?? 20;

let sink: fs.WriteStream | null = null;

/** Tee log output to a file as well as stderr. */
export function logToFile(file: string): void {
  sink = fs.createWriteStream(file, { flags: 'a' });
}

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const detail = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${detail}`;
  // stdout is reserved for the MCP stdio transport, so everything goes to stderr.
  process.stderr.write(line + '\n');
  sink?.write(line + '\n');
}

export const logger = (scope: string) => ({
  debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
  info: (m: string, e?: unknown) => emit('info', scope, m, e),
  warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
  error: (m: string, e?: unknown) => emit('error', scope, m, e),
});
