import { Config } from "../config";
import { QaError } from "../errors";
import { logger } from "../logger";
import { SmsGatewayClient } from "./gateway-client";
import { CodeSource } from "./index";

const POLL_INTERVAL_MS = 2_000;

export function makeGatewaySource(config: Config): CodeSource {
  if (!config.gateway) {
    throw new QaError(
      "CONFIG_ERROR",
      "gateway source selected but gateway settings are missing",
    );
  }
  const client = new SmsGatewayClient(config.gateway);

  return {
    name: "gateway",
    async getPhone() {
      const phone = await client.getPhoneNumber();
      logger.protect(phone.e164);
      return phone;
    },
    async waitForCode(ctx) {
      const deadline = Date.now() + ctx.timeoutMs;

      while (Date.now() < deadline) {
        const { status, code } = await client.getStatus();
        logger.debug("gateway status:", status);

        if (status === "STATUS_OK" && code) {
          logger.protect(code);
          return code;
        }
        if (status === "STATUS_CANCEL") {
          throw new QaError(
            "SMS_TIMEOUT",
            "the gateway reports the activation was cancelled",
          );
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      throw new QaError(
        "SMS_TIMEOUT",
        `no SMS reached the gateway within ${ctx.timeoutMs}ms`,
      );
    },
  };
}
