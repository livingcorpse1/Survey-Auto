import { describe, expect, it } from 'vitest';
import { isRedactionEnabled, redactText } from '@/lib/agent/redact';

describe('log redaction', () => {
  it('masks email addresses', () => {
    expect(redactText('contact me at john.smith@example.com please')).toBe('contact me at [REDACTED:email] please');
  });

  it('masks phone numbers', () => {
    expect(redactText('call 555 123 4567 now')).toBe('call [REDACTED:phone] now');
  });

  it('masks long digit sequences like card numbers', () => {
    expect(redactText('card 4111 1111 1111 1111')).toBe('card [REDACTED:phone] 1111');
  });

  it('masks answer field values', () => {
    expect(redactText('answer: "yes, I like cats"')).toBe('answer: [REDACTED:answer]');
  });

  it('leaves ordinary survey text untouched', () => {
    expect(redactText('Question 4 of 12: Do you shop online weekly?')).toBe('Question 4 of 12: Do you shop online weekly?');
  });

  it('keeps short numbers intact but masks long runs', () => {
    expect(redactText('step 3 of 10')).toBe('step 3 of 10');
    expect(redactText('version 123456789012')).toBe('version [REDACTED:phone]');
  });

  it('returns empty input unchanged', () => {
    expect(redactText('')).toBe('');
  });

  it('is enabled by default and respects VITE_REDACT_LOGS=0', () => {
    vi.stubEnv('VITE_REDACT_LOGS', '0');
    expect(isRedactionEnabled()).toBe(false);
    vi.stubEnv('VITE_REDACT_LOGS', '1');
    expect(isRedactionEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});

import { vi } from 'vitest';
