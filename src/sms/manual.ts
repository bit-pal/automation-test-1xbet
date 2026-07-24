// Manual entry by the operator — the default source, needing no extra setup.
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Config } from '../config';
import { QaError } from '../errors';
import { logger } from '../logger';
import { CodeSource } from './index';

// One readline interface for the whole run rather than one per prompt: closing
// and reopening discards whatever is already buffered on stdin, so a retry
// prompt would sit there ignoring the operator until it timed out.
let prompt: ReturnType<typeof createInterface> | undefined;

export function closeOperatorPrompt(): void {
  prompt?.close();
  prompt = undefined;
}

export function makeManualSource(config: Config): CodeSource {
  return {
    name: 'manual',
    async getPhone() {
      // The manual source authorizes with the number from the environment. Config
      // guarantees it is set when CODE_SOURCE=manual; guard anyway for type safety.
      if (!config.phone) {
        throw new QaError('CONFIG_ERROR', 'TEST_PHONE_NUMBER is required for CODE_SOURCE=manual');
      }
      return config.phone;
    },
    async waitForCode(ctx) {
      prompt ??= createInterface({ input, output });
      try {
        const answer = await prompt.question(`\nEnter the code sent to ${ctx.phone}: `, {
          signal: AbortSignal.timeout(ctx.timeoutMs),
        });
        const code = answer.trim();
        // The code itself is never logged; register it so it can't leak elsewhere.
        logger.protect(code);
        if (!/^\d{4,8}$/.test(code)) {
          throw new QaError('CODE_INVALID', 'the operator entered a non-numeric code');
        }
        return code;
      } catch (err) {
        if (err instanceof QaError) throw err;
        if (err instanceof Error && err.name === 'AbortError') {
          throw new QaError('SMS_TIMEOUT', `the operator did not enter a code within ${ctx.timeoutMs}ms`);
        }
        // stdin hit EOF: input was piped or redirected rather than a terminal.
        // Failing loudly beats hanging until the timeout on a prompt nobody sees.
        if ((err as NodeJS.ErrnoException)?.code === 'ERR_USE_AFTER_CLOSE') {
          throw new QaError(
            'CONFIG_ERROR',
            'no operator input available (stdin is closed) — CODE_SOURCE=manual requires an interactive terminal'
          );
        }
        throw err;
      }
    },
  };
}
