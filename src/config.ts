import fs from 'node:fs';
import { QaError } from './errors';
import { ParsedPhone, parsePhone } from './phone';

export type CodeSourceName = 'manual' | 'gateway';

export interface GatewayConfig {
  url: string;
  apiKey: string;
  service: string;
  country: number;
}

export interface Config {
  baseUrl: string;
  login: string;
  password: string;
  phone?: ParsedPhone;
  codeSource: CodeSourceName;
  gateway?: GatewayConfig;
  geo: string;
  codeTimeoutMs: number;
  maxCodeAttempts: number;
  logDir: string;
  artifactsDir: string;
  headful: boolean;
}

function loadEnvFile(file = '.env'): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

function envAny(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

function required(...names: string[]): string {
  const value = envAny(...names);
  if (!value) {
    const label = names.length > 1 ? `${names.join(' (or ')})` : names[0];
    throw new QaError('CONFIG_ERROR', `${label} is not set — copy .env.example to .env and fill it in`);
  }
  return value;
}

const SOURCES: CodeSourceName[] = ['manual', 'gateway'];

function loadGatewayConfig(): GatewayConfig {
  return {
    url: required('SMS_GATEWAY_URL'),
    apiKey: required('SMS_API_KEY'),
    service: required('SMS_SERVICE'),
    country: Number(required('SMS_COUNTRY')),
  };
}

function loadConfig(argv: string[] = []): Config {
  loadEnvFile();

  const codeSource = (process.env.CODE_SOURCE || 'manual') as CodeSourceName;
  if (!SOURCES.includes(codeSource)) {
    throw new QaError('CONFIG_ERROR', `CODE_SOURCE must be one of: ${SOURCES.join(', ')}`);
  }

  const codeTimeoutMs = Number(process.env.CODE_TIMEOUT_MS || 120_000);
  const maxCodeAttempts = Number(process.env.MAX_CODE_ATTEMPTS || 3);
  if (!Number.isFinite(codeTimeoutMs) || codeTimeoutMs <= 0) {
    throw new QaError('CONFIG_ERROR', 'CODE_TIMEOUT_MS must be a positive number');
  }
  if (!Number.isInteger(maxCodeAttempts) || maxCodeAttempts < 1) {
    throw new QaError('CONFIG_ERROR', 'MAX_CODE_ATTEMPTS must be a positive integer');
  }

  return {
    baseUrl: (process.env.SITE_URL || 'http://127.0.0.1:3000').replace(/\/$/, ''),
    login: required('SITE_LOGIN'),
    password: required('SITE_PASSWORD'),
    phone: codeSource === 'manual' ? parsePhone(required('TEST_PHONE_NUMBER')) : undefined,
    codeSource,
    gateway: codeSource === 'gateway' ? loadGatewayConfig() : undefined,
    geo: process.env.RUN_GEO || 'not specified',
    codeTimeoutMs,
    maxCodeAttempts,
    logDir: process.env.LOG_DIR || 'logs',
    artifactsDir: process.env.ARTIFACTS_DIR || 'artifacts',
    headful: argv.includes('--headful'),
  };
}

const config = loadConfig(process.argv.slice(2));

export default config;
