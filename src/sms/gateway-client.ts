import { GatewayConfig } from "../config";
import { QaError } from "../errors";
import { ParsedPhone, parsePhone } from "../phone";

export type GatewayStatus =
  | "STATUS_OK"
  | "STATUS_WAIT_CODE"
  | "STATUS_CANCEL"
  | string;

export interface GatewayStatusResult {
  /** Raw status token, e.g. "STATUS_OK", "STATUS_WAIT_CODE", "STATUS_CANCEL". */
  status: GatewayStatus;
  /** The verification code, present only when status is "STATUS_OK". */
  code: string | null;
  /** The untouched, trimmed gateway response. */
  raw: string;
}

export class SmsGatewayClient {
  private activationId?: string;

  constructor(private readonly config: GatewayConfig) {}

  // is GATEWAY_UNAVAILABLE, distinct from "the SMS never arrived" (SMS_TIMEOUT),
  // so the report says which of the two actually happened.
  private async request(
    action: string,
    params: Record<string, string> = {},
  ): Promise<string> {
    const url = new URL(this.config.url);
    url.searchParams.set("action", action);
    url.searchParams.set("api_key", this.config.apiKey);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);

    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new QaError(
        "GATEWAY_UNAVAILABLE",
        `cannot reach the SMS gateway: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (!res.ok) {
      throw new QaError(
        "GATEWAY_UNAVAILABLE",
        `gateway responded ${res.status} ${res.statusText}`,
      );
    }
    return (await res.text()).trim();
  }


  async getStatus(): Promise<GatewayStatusResult> {
    if (!this.activationId) {
      throw new QaError(
        "GATEWAY_UNAVAILABLE",
        "no active activation — call getPhoneNumber() before polling for a code",
      );
    }
    const raw = await this.request("getStatus", {
      id: this.activationId,
    });
    const [status, ...rest] = raw.split(":");

    if (status === "STATUS_OK") return { status, code: rest.join(":"), raw };
    if (status === "STATUS_WAIT_CODE" || status === "STATUS_CANCEL") {
      return { status, code: null, raw };
    }

    // Anything else (NO_BALANCE, BAD_KEY, NO_ACTIVATION, ...) is a gateway-side
    // failure. Returning it as a pollable status would spin until SMS_TIMEOUT and
    // hide the real cause; raise it instead.
    throw new QaError("GATEWAY_UNAVAILABLE", `gateway returned "${raw}"`);
  }

  async getPhoneNumber(): Promise<ParsedPhone> {
    const raw = await this.request("getNumber", {
      country: this.config.country.toString(),
      service: this.config.service,
    });
    const [token, activationId, number] = raw.split(":");

    if (token !== "ACCESS_NUMBER" || !activationId || !number) {
      throw new QaError(
        "GATEWAY_UNAVAILABLE",
        `gateway returned "${raw}" instead of ACCESS_NUMBER:<id>:<number>`,
      );
    }

    let phone: ParsedPhone;
    try {
      phone = parsePhone(number);
    } catch {
      throw new QaError(
        "GATEWAY_UNAVAILABLE",
        `gateway returned an unparseable number in "${raw}"`,
      );
    }

    this.activationId = activationId;
    return phone;
  }
}
