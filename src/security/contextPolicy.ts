import fs from 'node:fs';
import path from 'node:path';
import { assessPathSafety, type PathSafetyReason } from './pathSafety.js';
import { isSecretLikePath, sanitizeForPolicyLog, scanContentForSecrets } from './secretScanner.js';

export type ContextSafetyMode = 'strict' | 'balanced' | 'permissive';

export type ContextPolicyReason =
  | PathSafetyReason
  | 'secret_like_file'
  | 'large_file'
  | 'binary_file'
  | 'generated_file'
  | 'content_secret';

export type ContextPolicyAction = 'allow' | 'block' | 'redact';

export interface ContextPolicyReceipt {
  policyId: 'context-resource-policy';
  action: Exclude<ContextPolicyAction, 'allow'>;
  reason: ContextPolicyReason;
  path: string;
  normalizedPath?: string;
  message: string;
  mode: ContextSafetyMode;
}

export interface ContextPolicyEvaluation {
  allowed: boolean;
  action: ContextPolicyAction;
  normalizedPath?: string;
  resolvedPath?: string;
  receipts: ContextPolicyReceipt[];
}

export interface ContextResourcePolicyInput {
  workspaceRoot: string;
  requestedPath: string;
  mode?: ContextSafetyMode;
  maxFileSizeBytes?: number;
  fieldName?: string;
  allowedRoots?: readonly string[];
}

export const DEFAULT_MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024;

const GENERATED_DIRECTORY_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '__generated__',
  'generated',
]);

const GENERATED_BASENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /\.min\.(?:js|css)$/i,
  /\.bundle\.js$/i,
  /\.chunk\.js$/i,
  /\.g\.dart$/i,
  /\.freezed\.dart$/i,
  /\.mocks\.dart$/i,
  /\.generated\.(?:ts|js)$/i,
  /^package-lock\.json$/i,
  /^yarn\.lock$/i,
  /^pnpm-lock\.yaml$/i,
  /^bun\.lockb$/i,
];

function createReceipt(
  input: ContextResourcePolicyInput,
  action: Exclude<ContextPolicyAction, 'allow'>,
  reason: ContextPolicyReason,
  message: string,
  normalizedPath?: string
): ContextPolicyReceipt {
  return {
    policyId: 'context-resource-policy',
    action,
    reason,
    path: input.requestedPath,
    ...(normalizedPath === undefined ? {} : { normalizedPath }),
    message,
    mode: input.mode ?? 'balanced',
  };
}

export function isGeneratedFilePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.toLowerCase().split('/');
  if (segments.some((segment) => GENERATED_DIRECTORY_SEGMENTS.has(segment))) {
    return true;
  }

  const basename = path.posix.basename(normalized);
  return GENERATED_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

export function isLikelyBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }

  let nonPrintableCount = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
    if ((byte < 32 || byte > 126) && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintableCount += 1;
    }
  }

  return nonPrintableCount / buffer.length > 0.1;
}

function actionForReason(
  reason: ContextPolicyReason,
  mode: ContextSafetyMode
): Exclude<ContextPolicyAction, 'allow'> {
  switch (reason) {
    case 'path_traversal':
    case 'encoded_traversal':
    case 'outside_root':
    case 'outside_client_root':
    case 'symlink_escape':
      return 'block';
    case 'secret_like_file':
    case 'content_secret':
      return mode === 'strict' ? 'block' : 'redact';
    case 'large_file':
    case 'binary_file':
      return mode === 'permissive' ? 'redact' : 'block';
    case 'generated_file':
      if (mode === 'strict') {
        return 'block';
      }
      if (mode === 'balanced') {
        return 'redact';
      }
      return 'redact';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function shouldAllowGeneratedFile(mode: ContextSafetyMode): boolean {
  return mode === 'permissive';
}

function readFileProbe(resolvedPath: string): { stats: fs.Stats; sample: Buffer } {
  const stats = fs.statSync(resolvedPath);
  const fd = fs.openSync(resolvedPath, 'r');
  try {
    const sample = Buffer.alloc(Math.min(8192, stats.size));
    const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
    return { stats, sample: sample.subarray(0, bytesRead) };
  } finally {
    fs.closeSync(fd);
  }
}

export function evaluateContextResourcePolicy(
  input: ContextResourcePolicyInput
): ContextPolicyEvaluation {
  const mode = input.mode ?? 'balanced';
  const maxFileSizeBytes = input.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const pathAssessment = assessPathSafety(
    input.workspaceRoot,
    input.requestedPath,
    input.fieldName,
    input.allowedRoots
  );

  if (!pathAssessment.safe) {
    const reason = pathAssessment.reason ?? 'outside_root';
    const action = actionForReason(reason, mode);
    return {
      allowed: false,
      action,
      ...(pathAssessment.normalizedPath === undefined
        ? {}
        : { normalizedPath: pathAssessment.normalizedPath }),
      ...(pathAssessment.resolvedPath === undefined
        ? {}
        : { resolvedPath: pathAssessment.resolvedPath }),
      receipts: [
        createReceipt(
          input,
          action,
          reason,
          pathAssessment.message ?? `Path blocked by policy (${reason}).`,
          pathAssessment.normalizedPath
        ),
      ],
    };
  }

  const normalizedPath = pathAssessment.normalizedPath!;
  const resolvedPath = pathAssessment.resolvedPath!;
  const receipts: ContextPolicyReceipt[] = [];

  if (isSecretLikePath(normalizedPath)) {
    const reason: ContextPolicyReason = 'secret_like_file';
    const action = actionForReason(reason, mode);
    receipts.push(
      createReceipt(
        input,
        action,
        reason,
        'Filename indicates a secret or credential file.',
        normalizedPath
      )
    );
  }

  if (isGeneratedFilePath(normalizedPath)) {
    if (!shouldAllowGeneratedFile(mode)) {
      const reason: ContextPolicyReason = 'generated_file';
      const action = actionForReason(reason, mode);
      receipts.push(
        createReceipt(
          input,
          action,
          reason,
          'Path matches generated or dependency artifact patterns.',
          normalizedPath
        )
      );
    }
  }

  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
    const { stats, sample } = readFileProbe(resolvedPath);

    if (stats.size > maxFileSizeBytes) {
      const reason: ContextPolicyReason = 'large_file';
      const action = actionForReason(reason, mode);
      receipts.push(
        createReceipt(
          input,
          action,
          reason,
          `File exceeds safe size limit (${stats.size} > ${maxFileSizeBytes} bytes).`,
          normalizedPath
        )
      );
    }

    if (isLikelyBinaryBuffer(sample)) {
      const reason: ContextPolicyReason = 'binary_file';
      const action = actionForReason(reason, mode);
      receipts.push(
        createReceipt(
          input,
          action,
          reason,
          'File content appears to be binary.',
          normalizedPath
        )
      );
    }

    if (stats.size <= maxFileSizeBytes && !isLikelyBinaryBuffer(sample)) {
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      const secretScan = scanContentForSecrets(content);
      if (secretScan.contentHasSecrets) {
        const reason: ContextPolicyReason = 'content_secret';
        const action = actionForReason(reason, mode);
        receipts.push(
          createReceipt(
            input,
            action,
            reason,
            'File content matches secret-like patterns.',
            normalizedPath
          )
        );
      }
    }
  }

  if (receipts.length === 0) {
    return {
      allowed: true,
      action: 'allow',
      normalizedPath,
      resolvedPath,
      receipts,
    };
  }

  const hasBlock = receipts.some((receipt) => receipt.action === 'block');
  const action: ContextPolicyAction = hasBlock ? 'block' : 'redact';

  return {
    allowed: false,
    action,
    normalizedPath,
    resolvedPath,
    receipts,
  };
}

export function formatPolicyReceiptForLog(receipt: ContextPolicyReceipt): string {
  return sanitizeForPolicyLog(
    `[${receipt.policyId}] ${receipt.action} ${receipt.reason} path=${receipt.path} message=${receipt.message}`
  );
}
