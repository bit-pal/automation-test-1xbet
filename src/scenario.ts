import { ElementHandle, Page } from "puppeteer";
import { Config } from "./config";
import { ParsedPhone } from "./phone";
import { QaError } from "./errors";
import { logger } from "./logger";
import { Report } from "./report";
import { CodeSource } from "./sms";
import {
  assertNoCaptcha,
  assertNotLimited,
  assertNoRateLimitFlag,
} from "./guards";

// --- Step 1: open Site ---
export async function openSite(
  page: Page,
  config: Config,
  report: Report,
): Promise<void> {
  try {
    const res = await page.goto(config.baseUrl, {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });
    if (!res || !res.ok()) {
      throw new QaError(
        "SERVICE_UNAVAILABLE",
        `Site responded ${res ? res.status() : "nothing"}`,
      );
    }
  } catch (err) {
    if (err instanceof QaError) throw err;
    throw new QaError(
      "SERVICE_UNAVAILABLE",
      `cannot open ${config.baseUrl}: ${err instanceof Error ? err.message : err}`,
    );
  }

  await assertNoCaptcha(page);
  await assertNotLimited(page);
  report.data.siteOpen = "ok";
  report.step("open-site", "ok", config.baseUrl);
}

// --- Steps 2-3: the login form ---
export async function logIn(
  page: Page,
  config: Config,
  report: Report,
): Promise<void> {
  await page.locator("button.auth-dropdown-trigger ::-p-text(Log in)").click();
  try {
    await page.waitForSelector(".auth-form", { timeout: 15_000 });
  } catch {
    throw new QaError(
      "PAGE_STRUCTURE_CHANGED",
      "the login form (.auth-form) is missing",
    );
  }

  logger.debug("logging in as", config.login);
  await page.type("input#username", config.login, { delay: 5 });
  await page.type("input#username-password", config.password, { delay: 5 });

  await page.locator('.auth-form button[type="submit"]').click();

  await waitForSelectorOrFailWithCaptcha(
    page,
    ".user-office__main",
    30_000,
    "the login neither navigated nor reported an error within 30s",
  ).catch(async (error: QaError) => {
    assertNoRateLimitFlag(page);
    await assertNoCaptcha(page);

    if (error.code === "UNEXPECTED_ERROR") {
      if (/too many|limited|locked|restricted/i.test(error.message)) {
        throw new QaError("ACCOUNT_LIMITED", error.message);
      }
      // No account creation here — section 6 forbids it.
      throw new QaError(
        "INVALID_CREDENTIALS",
        error.message || "the login was rejected",
      );
    }
    throw error;
  });

  await assertNotLimited(page);
  report.data.login = "ok";
  report.step("login", "ok", `as ${config.login}`);
}

export function classifyCodeMessage(message: string): QaError | null {
  if (/expired/i.test(message)) return new QaError("CODE_EXPIRED", message);
  if (/incorrect verification code|invalid code/i.test(message)) return null;
  if (/already has a phone number|already in use/i.test(message)) {
    return new QaError(
      "PRECONDITION_FAILED",
      `${message} — reset the test account before re-running ` +
        "(a second account or a different number is not permitted)",
    );
  }
  if (/invalid phone number/i.test(message))
    return new QaError("CONFIG_ERROR", message);
  // Unrecognised: halting is safer than burning attempts on an unknown cause.
  return new QaError(
    "UNEXPECTED_ERROR",
    `the code step was rejected: ${message}`,
  );
}

// --- Step 4: enter the test number into the "add a phone" form ---
async function enterPhoneNumber(page: Page, phone: ParsedPhone): Promise<void> {
  await waitForSelectorOrFail(
    page,
    ".account-phone input",
    30_000,
    'the security panel showed neither "Add a number" nor an existing number',
  );

  const oldPhone = await page.$eval(
    ".account-phone input",
    (el) => (el as HTMLInputElement).value,
  );

  if (oldPhone) {
    // Not a block and not a limit: the account simply is not in a state this run
    // can start from. Reporting it as a stop would imply the service pushed back.
    throw new QaError(
      "PRECONDITION_FAILED",
      "the test account already has a verified number; reset it before re-running " +
        "(adding a second number or a second account is not permitted)",
    );
  }

  await page.click(".account-phone button");

  await waitForSelectorOrFail(
    page,
    ".add-phone-step-phone__field input",
    15_000,
    "the dialog where user link his phone was modified",
  );

  await page.type(
    '.add-phone-step-phone__field input[name="phone"]',
    phone.nationalNumber,
    { delay: 5 },
  );
}

// --- Step 4 (cont.): confirm the number and initiate the SMS ---
async function initiateSms(page: Page, report: Report): Promise<Date> {
  await page.click(".add-phone-step-phone__field + button");

  await waitForSelectorOrFailWithCaptcha(
    page,
    '.v--final-modal-overlay[status="success"]',
    15_000,
    "the phone number was never sent within 15s",
  );

  await page.click(".v--final-modal-overlay .ui-popup__submit");

  await waitForSelectorOrFail(
    page,
    ".v--final-modal-overlay .add-phone-step-sms-code",
    10_000,
    "",
  );

  const sentAt = new Date();
  report.data.smsSend = "ok";
  report.step("send-sms", "ok", `to ${report.data.phoneMasked}`);
  return sentAt;
}

const getErrorDialog = (page: Page, timeout: number) =>
  page.waitForSelector('.v--final-modal-overlay[status="error"]', {
    visible: true,
    timeout,
  });
const getSuccessDialog = (page: Page, timeout: number) =>
  page.waitForSelector('.v--final-modal-overlay[status="success"]', {
    visible: true,
    timeout,
  });

const getAttr = async (el: ElementHandle<Element> | null, attrName: string) =>
  (await el?.evaluate((e) => e.getAttribute(attrName) ?? "")) ?? "";
const getText = async (el: ElementHandle<Element> | null) =>
  (await el?.evaluate((e) => e.textContent?.trim() ?? "")) ?? "";

type CodeCheckResult =
  | { status: "success"; msg: string }
  | { status: "error"; msg: string }
  | { status: "timeout" };

const ERR_TEXT_SEL =
  ".add-phone-step-sms-code__field .ui-input-base-error__text";

async function findCodeCheckResult(
  page: Page,
  timeout: number,
): Promise<CodeCheckResult> {
  const arms: Promise<CodeCheckResult>[] = [
    page.waitForSelector(ERR_TEXT_SEL, { visible: true, timeout }).then(
      async (el): Promise<CodeCheckResult> => ({
        status: "error",
        msg: await getText(el),
      }),
    ),

    getErrorDialog(page, timeout).then(
      async (el): Promise<CodeCheckResult> => ({
        status: "error",
        msg: await getAttr(el, "text"),
      }),
    ),

    getSuccessDialog(page, timeout).then(
      async (el): Promise<CodeCheckResult> => ({
        status: "success",
        msg: await getAttr(el, "text"),
      }),
    ),
  ];

  // Never-resolving arms would leak, so each rejection is neutralised and the
  // overall deadline is enforced by Promise.any falling through.
  return Promise.any(arms).catch(() => ({ status: "timeout" as const }));
}

// --- Steps 5-8: send the SMS, receive the code, enter it, check the result ---
export async function sendAndVerifyCode(
  page: Page,
  config: Config,
  report: Report,
  source: CodeSource,
): Promise<void> {
  await page.goto(`${config.baseUrl}/office/account`, {
    waitUntil: "networkidle2",
  });
  await assertNoCaptcha(page);
  await assertNotLimited(page);

  // The number to authorize with comes from the source: the environment for the
  // manual source, the gateway's own number for the gateway source. Record its
  // mask before anything is sent so the report reflects the number actually used.
  const phone = await source.getPhone();
  report.recordPhone(phone.e164);

  await enterPhoneNumber(page, phone);
  const sentAt = await initiateSms(page, report);

  // --- Receive the code and enter it, retrying a rejected code up to the limit ---
  //
  // A rejected code is re-read from the source and re-entered, bounded by
  // MAX_CODE_ATTEMPTS. The SMS is sent once and never resent (ToR section 6), so a
  // source that hands back the identical code means no new SMS came — there is
  // nothing new to try, and we stop rather than burn an attempt on a known-bad code.
  const readCode = (): Promise<string> =>
    source.waitForCode({ phone, sentAt, timeoutMs: config.codeTimeoutMs });

  const waitStart = Date.now();
  let lastCode: string | undefined;
  let accepted = false;

  for (let attempt = 1; attempt <= config.maxCodeAttempts; attempt++) {
    report.data.attempts = attempt;

    // Obtain a code. The SMS is never resent, so a timeout here is terminal.
    let code: string;
    try {
      code = await readCode();
    } catch (err) {
      report.data.codeWaitMs = Date.now() - waitStart;
      report.data.smsReceive = "failed";
      throw err;
    }

    // The same code twice means no new SMS arrived; re-entering a code the service
    // already rejected would only waste an attempt, so stop with the error.
    if (code === lastCode) {
      report.data.codeWaitMs = Date.now() - waitStart;
      report.data.smsReceive = "failed";
      throw new QaError(
        "CODE_INVALID",
        "the source returned the same code, already rejected — no new SMS arrived",
      );
    }
    lastCode = code;

    report.data.codeWaitMs = Date.now() - waitStart;
    report.data.smsReceive = "ok";
    // The code itself is never recorded (section 4).
    report.step("receive-code", "ok", `via ${source.name}`);

    // Enter it and see whether the service accepts it.
    await page.locator(".add-phone-step-sms-code__field input").fill(code);
    await page.locator(".add-phone-step-sms-code__submit").click();

    const result = await findCodeCheckResult(page, 15_000);
    if (result.status === "success") {
      accepted = true;
      break;
    }
    if (result.status === "timeout") {
      throw new QaError(
        "PAGE_STRUCTURE_CHANGED",
        "the code was neither accepted nor rejected within 15s",
      );
    }

    // Rejected. A plain "incorrect code" is worth another attempt; anything else
    // (expired, already in use, invalid number, ...) is terminal.
    const classified = classifyCodeMessage(result.msg);
    if (classified) {
      report.data.codeEntry = "failed";
      throw classified;
    }
    logger.info(`code rejected — attempt ${attempt}/${config.maxCodeAttempts}`);
  }

  if (!accepted) {
    report.data.codeEntry = "failed";
    throw new QaError(
      "ATTEMPTS_EXCEEDED",
      `the code was rejected on all ${config.maxCodeAttempts} attempt(s)`,
    );
  }
  report.data.codeEntry = "ok";

  // --- Check the authorization result ---
  const attached = await page.$eval(
    ".account-phone input",
    (el) => (el as HTMLInputElement).value ?? "",
  );
  // The form silently truncates over-long input, so never assume what was
  // attached is what we asked for. Compare on digits to ignore formatting.
  if (attached.replace(/\D/g, "") !== phone.e164.replace(/\D/g, "")) {
    throw new QaError(
      "PAGE_STRUCTURE_CHANGED",
      "a different number was attached to the account",
    );
  }
  report.data.authResult = "ok";
  report.step("check-result", "ok", report.data.phoneMasked);
}

async function waitForSelectorOrFail(
  page: Page,
  selector: string,
  timeout: number,
  timeoutMsg: string,
) {
  const element = page
    .waitForSelector(selector, { timeout })
    .then((elementHandle) => ({ status: "success", elementHandle }));
  const error = getErrorDialog(page, timeout).then((elementHandle) => ({
    status: "error",
    elementHandle,
  }));

  return Promise.race([element, error])
    .catch((e) => {
      throw new QaError("PAGE_STRUCTURE_CHANGED", timeoutMsg);
    })
    .then(async ({ status, elementHandle }) => {
      if (status === "error") {
        const message = (await elementHandle!.evaluate((e) =>
          e.getAttribute("text"),
        )) as string;
        throw new QaError("UNEXPECTED_ERROR", message);
      }
      return elementHandle;
    });
}

async function waitForSelectorOrFailWithCaptcha(
  page: Page,
  selector: string,
  timeout: number,
  timeoutMsg: string,
) {
  const captcha = page
    .waitForSelector("#huntCaptcha", { visible: true, timeout })
    .then(() => ({
      status: "captcha" as const,
      elementHandle: null as ElementHandle<Element> | null,
    }));

  const element = waitForSelectorOrFail(
    page,
    selector,
    timeout,
    timeoutMsg,
  ).then((elementHandle) => ({
    status: "success" as const,
    elementHandle,
  }));

  return Promise.race([element, captcha]).then(
    async ({ status, elementHandle }) => {
      // Detect and stop — bypassing the challenge is prohibited (ToR section 5).
      if (status === "captcha") {
        throw new QaError("CAPTCHA_DETECTED", "anti-bot challenge present (#huntCaptcha) — stopping, bypass is not permitted");
        // await waitForSelectorOrFail(page, selector, 0, timeoutMsg);
      }
      return elementHandle;
    },
  );
}
