import path from 'node:path';
import { SecretScrubber } from '../reactive/guardrails/secretScrubber.js';

export interface SecretScanResult {
  secretLikePath: boolean;
  contentHasSecrets: boolean;
  secretCount: number;
}

const SECRET_LIKE_BASENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env(?:\..+)?$/i,
  /^.*\.pem$/i,
  /^.*\.key$/i,
  /^.*\.p12$/i,
  /^.*\.jks$/i,
  /^.*\.keystore$/i,
  /^secrets\.(?:json|ya?ml)$/i,
  /^credentials\.(?:json|ya?ml)$/i,
  /^.*secrets.*\.(?:json|ya?ml)$/i,
];

let defaultScrubber: SecretScrubber | undefined;

function getDefaultScrubber(): SecretScrubber {
  if (!defaultScrubber) {
    defaultScrubber = new SecretScrubber();
  }
  return defaultScrubber;
}

export function isSecretLikePath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath.replace(/\\/g, '/'));
  return SECRET_LIKE_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

export function scanContentForSecrets(
  content: string,
  scrubber: SecretScrubber = getDefaultScrubber()
): SecretScanResult {
  const result = scrubber.scrub(content);
  return {
    secretLikePath: false,
    contentHasSecrets: result.hasSecrets,
    secretCount: result.detectedSecrets.length,
  };
}

export function sanitizeForPolicyLog(value: string): string {
  const preSanitized = value
    .replace(/\bauthorization\s*:\s*[^\s]+/gi, 'authorization: [REDACTED]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'bearer [REDACTED]')
    .replace(/\bghp_[A-Za-z0-9._-]+/gi, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9._-]+/gi, '[REDACTED_API_KEY]');

  const scrubbed = getDefaultScrubber().scrub(preSanitized).scrubbedContent;
  return scrubbed
    .replace(/\bghp_[^\s]+/gi, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bsk-(?:proj-)?[^\s]+/gi, '[REDACTED_API_KEY]');
}

const DEFAULT_LOG_CONTENT_MAX_LENGTH = 500;

export function sanitizeLogContent(
  value: unknown,
  options?: { maxLength?: number }
): string {
  const maxLength = options?.maxLength ?? DEFAULT_LOG_CONTENT_MAX_LENGTH;

  if (value === null || value === undefined) {
    return String(value);
  }

  if (typeof value === 'string') {
    const scrubbed = sanitizeForPolicyLog(value);
    if (scrubbed.length <= maxLength) {
      return scrubbed;
    }
    return `${scrubbed.slice(0, maxLength)}...[truncated ${scrubbed.length - maxLength} chars]`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return sanitizeLogContent(JSON.stringify(value), { maxLength });
  } catch {
    return '[unserializable]';
  }
}
