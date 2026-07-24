// Where the verification code comes from (ToR section 3, step 5).
//
// The demo app prints the SMS onto the page, but a real service never does — so
// the scenario must not be written as if it can read the code out of the
// browser. Each authorized source implements one interface and is chosen with
// CODE_SOURCE, which keeps the scenario identical whether a human or the
// permitted test gateway supplies the digits.
import { Config } from '../config';
import { makeManualSource } from './manual';
import { makeGatewaySource } from './gateway';
import { ParsedPhone } from '../phone';

export interface CodeContext {
  phone: ParsedPhone;
  /** Anything older is stale and must not be accepted. */
  sentAt: Date;
  timeoutMs: number;
}

export interface CodeSource {
  readonly name: string;
  /** The number to authorize with: from the environment (manual) or the gateway. */
  getPhone(): Promise<ParsedPhone>;
  waitForCode(ctx: CodeContext): Promise<string>;
}

// Pull a 4-8 digit code out of a message body.
export function extractCode(body: string): string | null {
  const match = body.match(/\b(\d{4,8})\b/);
  return match ? match[1] : null;
}

export function resolveCodeSource(config: Config): CodeSource {
  switch (config.codeSource) {
    case 'manual':
      return makeManualSource(config);
    case 'gateway':
      return makeGatewaySource(config);
  }
}

export { closeOperatorPrompt } from './manual';
