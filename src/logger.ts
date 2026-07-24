const REDACTION = '«redacted»';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class Logger {
  private readonly secrets = new Set<string>();

  constructor(private readonly debugEnabled = false) {}

  protect(value: string | undefined | null): void {
    if (value && value.trim().length >= 3) this.secrets.add(value.trim());
  }

  private redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join(REDACTION);
    return out;
  }

  private emit(level: LogLevel, parts: unknown[]): void {
    if (level === 'debug' && !this.debugEnabled) return;
    const text = this.redact(parts.map(stringify).join(' '));
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(text);
  }

  debug(...parts: unknown[]): void {
    this.emit('debug', parts);
  }
  info(...parts: unknown[]): void {
    this.emit('info', parts);
  }
  warn(...parts: unknown[]): void {
    this.emit('warn', parts);
  }
  error(...parts: unknown[]): void {
    this.emit('error', parts);
  }
}

export const logger = new Logger(/^(1|true|yes)$/i.test(process.env.DEBUG ?? ''));
