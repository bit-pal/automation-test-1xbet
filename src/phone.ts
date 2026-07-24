import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { QaError } from './errors';

export interface ParsedPhone {
  /** Full number in E.164 form, e.g. "+959695304546". */
  e164: string;
  /** Country calling code without "+", e.g. "95". */
  countryCallingCode: string;
  /** National (significant) number, e.g. "9695304546". */
  nationalNumber: string;
}

export function parsePhone(raw: string): ParsedPhone {
  const normalised = raw.trim().startsWith('+') ? raw.trim() : `+${raw.trim()}`;
  const parsed = parsePhoneNumberFromString(normalised);
  if (!parsed || !parsed.isValid()) {
    throw new QaError('CONFIG_ERROR', `TEST_PHONE_NUMBER is not a valid phone number: "${raw}"`);
  }
  return {
    e164: parsed.number,
    countryCallingCode: parsed.countryCallingCode,
    nationalNumber: parsed.nationalNumber,
  };
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '***';
  return `+${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}
