import fs from 'node:fs';
import path from 'node:path';
import { Page } from 'puppeteer';
import { QaError } from './errors';

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[title*="challenge" i]',
  '#captcha',
  '.g-recaptcha',
  '.h-captcha',
  '[data-sitekey]',
];

const LIMIT_PATTERNS = [
  /too many (requests|attempts)/i,
  /rate ?limit/i,
  /temporarily (locked|limited|restricted|blocked|unavailable)/i,
  /account (has been )?(locked|suspended|restricted)/i,
  /try again (later|in \d+)/i,
];

// Called after every navigation and before every submit.
export async function assertNoCaptcha(page: Page): Promise<void> {
  for (const selector of CAPTCHA_SELECTORS) {
    if (await page.$(selector)) {
      throw new QaError(
        'CAPTCHA_DETECTED',
        `anti-bot challenge present (${selector}) — stopping, bypass is not permitted`
      );
    }
  }
}

export async function assertNotLimited(page: Page): Promise<void> {
  const text = await page.evaluate(() => document.body?.innerText ?? '');
  const hit = LIMIT_PATTERNS.find((re) => re.test(text));
  if (hit) {
    throw new QaError(
      'ACCOUNT_LIMITED',
      `the service reports a limit or restriction (matched ${hit}) — stopping`
    );
  }
}

// A 429 on any request is the same stop condition as a visible limit notice.
//
// The flag lives here rather than on the page because a navigation replaces the
// DOM, which would quietly discard a 429 observed moments before it.
const rateLimited = new WeakSet<Page>();

export function watchForRateLimit(page: Page): void {
  page.on('response', (res) => {
    // Throwing inside an event handler would surface as an unhandled rejection
    // and lose the run's error handling, so record it and let a guard raise it.
    if (res.status() === 429) rateLimited.add(page);
  });
}

export function assertNoRateLimitFlag(page: Page): void {
  if (rateLimited.has(page)) {
    throw new QaError('ACCOUNT_LIMITED', 'the service returned HTTP 429 — stopping');
  }
}

// --- Serial execution (section 6 forbids mass or parallel attempts) ---

const LOCK_STALE_MS = 15 * 60 * 1000;

export function acquireRunLock(dir: string): () => void {
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, '.run.lock');

  if (fs.existsSync(lockFile)) {
    const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
    if (ageMs < LOCK_STALE_MS) {
      throw new QaError(
        'CONCURRENT_RUN',
        `another run is in progress (${lockFile}, ${Math.round(ageMs / 1000)}s old); ` +
          'parallel attempts are not permitted'
      );
    }
    fs.rmSync(lockFile); // stale leftover from a killed run
  }

  fs.writeFileSync(lockFile, String(process.pid), 'utf8');
  return () => {
    try {
      fs.rmSync(lockFile);
    } catch {
      /* already gone */
    }
  };
}
