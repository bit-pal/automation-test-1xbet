import puppeteer, { Browser, Page } from "puppeteer";
import fs from "node:fs";
import path from "node:path";
import config, { Config } from "./config";
import { asQaError } from "./errors";
import { logger } from "./logger";
import { Report } from "./report";
import { resolveCodeSource, closeOperatorPrompt } from "./sms";
import { acquireRunLock, watchForRateLimit } from "./guards";
import { openSite, logIn, sendAndVerifyCode } from "./scenario";

async function capture(page: Page, config: Config, runId: string, tag: string): Promise<void> {
  try {
    fs.mkdirSync(config.artifactsDir, { recursive: true });
    const file = path.join(config.artifactsDir, `${runId}-${tag}.png`);
    await page.screenshot({ path: file as `${string}.png`, fullPage: true });
    logger.info(`Screenshot: ${file}`);
  } catch {
    /* ignored on purpose */
  }
}

async function main(): Promise<void> {
  logger.protect(config.password);
  logger.protect(config.phone?.e164);
  logger.protect(config.gateway?.apiKey);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");

  const report = new Report(runId, config.geo, config.phone?.e164, config.codeSource, config.logDir);
  let releaseLock: (() => void) | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    releaseLock = acquireRunLock(config.logDir);
    browser = await puppeteer.launch(
      config.headful
        ? {
            headless: false,
            slowMo: 250, // ms delay between each CDP action
            devtools: false, // opens DevTools automatically
            args: ["--window-size=1400,900"],
            defaultViewport: null, // use the real window size
            channel: 'chrome'
          }
        : { headless: "shell" }
    );
    const pages = await browser.pages();
    if (pages.length === 0) {
      page = await browser.newPage();
    } else {
      page = pages[0]
    }
    watchForRateLimit(page);

    await openSite(page, config, report);
    await logIn(page, config, report);
    await sendAndVerifyCode(page, config, report, resolveCodeSource(config));

  } catch (err) {
    const qa = asQaError(err);
    report.data.errorCode = qa.code;
    report.data.errorMessage = qa.message;
    report.data.stopped = qa.halts;
    report.data.stopReason = qa.isServiceDefence ? "service-defence" : qa.isSelfImposed ? "self-imposed" : null;
    report.data.authResult = "failed";
    report.step(qa.halts ? "stopped" : "aborted", "failed", `${qa.code}: ${qa.message}`);

    if (qa.isServiceDefence) {
      logger.error("Halted per ToR section 5 — no bypass was attempted.");
    } else if (qa.isSelfImposed) {
      logger.error("Halted by our own rule (ToR section 6).");
    }

    // Screenshot the page we opened, not a positional guess into browser.pages().
    if (page) await capture(page, config, runId, "failure");
    process.exitCode = 1;
  } finally {
    closeOperatorPrompt(); // an open stdin prompt would keep the process alive
    report.finish();
    await browser?.close();
    releaseLock?.();
  }
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
