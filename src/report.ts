import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode } from './errors';
import { logger } from './logger';
import { maskPhone } from './phone';

export type Status = 'ok' | 'failed' | 'skipped';

export interface ReportData {
  runId: string;
  startedAt: string;
  geo: string;
  phoneMasked: string;
  siteOpen: Status;
  login: Status;
  smsSend: Status;
  smsReceive: Status;
  codeSource: string;
  codeWaitMs: number | null;
  codeEntry: Status;
  attempts: number;
  authResult: Status;
  totalMs: number | null;
  stopped: boolean;
  stopReason: 'service-defence' | 'self-imposed' | null;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
}

export class Report {
  private readonly startedAtMs = Date.now();
  private readonly jsonlFile: string;
  private readonly summaryFile: string;
  readonly data: ReportData;

  constructor(runId: string, geo: string, phone: string | undefined, codeSource: string, logDir: string) {
    fs.mkdirSync(logDir, { recursive: true });
    this.jsonlFile = path.join(logDir, `run-${runId}.jsonl`);
    this.summaryFile = path.join(logDir, `run-${runId}.txt`);
    this.data = {
      runId,
      startedAt: new Date().toISOString(),
      geo,
      phoneMasked: maskPhone(phone ?? ''),
      siteOpen: 'skipped',
      login: 'skipped',
      smsSend: 'skipped',
      smsReceive: 'skipped',
      codeSource,
      codeWaitMs: null,
      codeEntry: 'skipped',
      attempts: 0,
      authResult: 'failed',
      totalMs: null,
      stopped: false,
      stopReason: null,
      errorCode: null,
      errorMessage: null,
    };
  }

  recordPhone(phone: string): void {
    this.data.phoneMasked = maskPhone(phone);
  }

  step(name: string, status: Status, note?: string): void {
    fs.appendFileSync(
      this.jsonlFile,
      JSON.stringify({
        runId: this.data.runId,
        ts: new Date().toISOString(),
        type: 'step',
        step: name,
        status,
        ...(note ? { note } : {}),
      }) + '\n'
    );
    const tag = status === 'ok' ? ' ok ' : status === 'failed' ? 'FAIL' : 'skip';
    logger.info(`[${tag}] ${name}${note ? ` — ${note}` : ''}`);
  }

  finish(): ReportData {
    this.data.totalMs = Date.now() - this.startedAtMs;
    fs.appendFileSync(this.jsonlFile, JSON.stringify({ type: 'result', ...this.data }) + '\n');
    fs.writeFileSync(this.summaryFile, this.render(), 'utf8');
    logger.info(`\n${this.render()}`);
    logger.info(`Report: ${this.summaryFile}\n        ${this.jsonlFile}`);
    return this.data;
  }

  private render(): string {
    const d = this.data;
    const rows: [string, string][] = [
      ['Run id', d.runId],
      ['Started at', d.startedAt],
      ['Geolocation', d.geo],
      ['Phone (masked)', d.phoneMasked],
      ['Site opened', d.siteOpen],
      ['Login', d.login],
      ['SMS sent', d.smsSend],
      ['SMS received', d.smsReceive],
      ['Code source', d.codeSource],
      ['Code wait', d.codeWaitMs === null ? 'n/a' : `${(d.codeWaitMs / 1000).toFixed(1)}s`],
      ['Code entry', d.codeEntry],
      ['Attempts used', String(d.attempts)],
      ['Authorization', d.authResult],
      ['Total time', d.totalMs === null ? 'n/a' : `${(d.totalMs / 1000).toFixed(1)}s`],
      [
        'Stopped by rule',
        d.stopReason === 'service-defence'
          ? 'yes — service defence (CAPTCHA / limit), no bypass attempted'
          : d.stopReason === 'self-imposed'
            ? 'yes — our own rule (see error)'
            : 'no',
      ],
      ['Error', d.errorCode ? `${d.errorCode}: ${d.errorMessage}` : 'none'],
    ];
    const width = Math.max(...rows.map(([key]) => key.length));
    return [
      '=== Site SMS authorization check ===',
      ...rows.map(([key, value]) => `${key.padEnd(width)} : ${value}`),
    ].join('\n');
  }
}
