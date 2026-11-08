export const EMAIL_MASK = '[REDACTED:email]';
export const PHONE_MASK = '[REDACTED:phone]';
export const NUMBER_MASK = '[REDACTED:number]';
export const ANSWER_MASK = '[REDACTED:answer]';

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?:\+?\d[\s-]?)?(?:\(?\d[\s-]?){2,4}\d{3,4}[\s-]?\d{4}\b/g;
const DIGITS_SEQ_RE = /\b\d[\d\s-]{7,}\d\b/g;
const ANSWER_FIELD_RE = /(answer|value)\s*[:=]\s*("([^"]*)"|'([^']*)'|[^\s,;]+)/gi;

function maskAnswerFields(input: string): string {
  return input.replace(ANSWER_FIELD_RE, (match, key, value) => {
    return `${key}: ${ANSWER_MASK}`;
  });
}

export function redactText(input: string): string {
  if (!input) return input;
  let output = maskAnswerFields(input);
  output = output.replace(EMAIL_RE, EMAIL_MASK);
  output = output.replace(PHONE_RE, PHONE_MASK);
  output = output.replace(DIGITS_SEQ_RE, NUMBER_MASK);
  output = output.replace(PHONE_RE, PHONE_MASK);
  return output;
}

export function redactAnswerPayload(input: string): string {
  return redactText(input);
}

export function isRedactionEnabled(): boolean {
  const flag = import.meta.env.VITE_REDACT_LOGS;
  if (typeof flag === 'string') return flag.trim().toLowerCase() !== '0' && flag.trim().toLowerCase() !== 'false';
  return true;
}

export function redactLogMessage(message: string): string {
  return isRedactionEnabled() ? redactText(message) : message;
}
