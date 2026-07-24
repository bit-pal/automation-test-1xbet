export type ErrorCode =
  | 'CONFIG_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'INVALID_CREDENTIALS'
  | 'PAGE_STRUCTURE_CHANGED'
  | 'SMS_NOT_SENT'
  | 'SMS_TIMEOUT'
  | 'GATEWAY_UNAVAILABLE'
  | 'CODE_INVALID'
  | 'CODE_EXPIRED'
  | 'ATTEMPTS_EXCEEDED'
  | 'CAPTCHA_DETECTED'
  | 'ACCOUNT_LIMITED'
  | 'CONCURRENT_RUN'
  | 'PRECONDITION_FAILED'
  | 'UNEXPECTED_ERROR';

const SERVICE_DEFENCE: ErrorCode[] = ['CAPTCHA_DETECTED', 'ACCOUNT_LIMITED'];

const SELF_IMPOSED: ErrorCode[] = ['ATTEMPTS_EXCEEDED', 'CONCURRENT_RUN'];

export class QaError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'QaError';
  }

  get isServiceDefence(): boolean {
    return SERVICE_DEFENCE.includes(this.code);
  }

  get isSelfImposed(): boolean {
    return SELF_IMPOSED.includes(this.code);
  }

  get halts(): boolean {
    return this.isServiceDefence || this.isSelfImposed;
  }
}

export function asQaError(err: unknown): QaError {
  if (err instanceof QaError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new QaError('UNEXPECTED_ERROR', message);
}
