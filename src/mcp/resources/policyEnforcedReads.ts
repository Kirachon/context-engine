import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode, McpError, type ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { ContextPackItem, ContextPackV3 } from '../../context/types/contextPack.js';
import type { ContextServiceClient } from '../serviceClient.js';
import {
  evaluateContextResourcePolicy,
  formatPolicyReceiptForLog,
  type ContextPolicyEvaluation,
  type ContextPolicyReceipt,
  type ContextSafetyMode,
} from '../../security/contextPolicy.js';
import { scanContentForSecrets } from '../../security/secretScanner.js';
import { auditLogRedaction } from '../../telemetry/auditLog.js';

export const FILE_RESOURCE_URI_PREFIX = 'context-engine://files/';
export const CHUNK_RESOURCE_URI_PREFIX = 'context-engine://chunks/';
export const SYMBOL_RESOURCE_URI_PREFIX = 'context-engine://symbols/';
export const CONTEXT_PACK_RESOURCE_URI_PREFIX = 'context-engine://context-packs/';

const CHUNK_ID_PATTERN = /^(.+)#L(\d+)-L(\d+)$/;

export interface ResourceReadContext {
  workspaceRoot: string;
  mode?: ContextSafetyMode;
  serviceClient?: Pick<ContextServiceClient, 'symbolDefinition'>;
  allowedRoots?: readonly string[];
}

export interface ResourcePolicyErrorData {
  uri: string;
  action: ContextPolicyEvaluation['action'];
  policyId: 'context-resource-policy';
  receipts: ContextPolicyEvaluation['receipts'];
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.json': 'application/json',
  '.ts': 'text/typescript',
  '.tsx': 'text/tsx',
  '.js': 'text/javascript',
  '.jsx': 'text/jsx',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.scss': 'text/scss',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'text/xml',
  '.txt': 'text/plain',
  '.py': 'text/x-python',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.sql': 'text/sql',
  '.sh': 'text/x-shellscript',
};

function buildTextResourceContents(uri: string, text: string, mimeType: string): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType,
        text,
      },
    ],
  };
}

function inferMimeType(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? 'text/plain';
}

function decodeResourceSegment(value: string, uri: string): string {
  if (!value.trim()) {
    throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
  }

  try {
    return decodeURIComponent(value);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
  }
}

function requireWorkspaceContext(context: ResourceReadContext | undefined, uri: string): ResourceReadContext {
  if (!context?.workspaceRoot?.trim()) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Workspace context is required for resource: ${uri}`
    );
  }
  return context;
}

export function buildResourcePolicyErrorData(
  uri: string,
  evaluation: ContextPolicyEvaluation
): ResourcePolicyErrorData {
  return {
    uri,
    action: evaluation.action,
    policyId: 'context-resource-policy',
    receipts: evaluation.receipts,
  };
}

export function resourcePolicyBlockedError(uri: string, evaluation: ContextPolicyEvaluation): McpError {
  for (const receipt of evaluation.receipts) {
    console.error(formatPolicyReceiptForLog(receipt));
    auditLogRedaction(receipt, { uri });
  }

  const verb = evaluation.action === 'block' ? 'blocked' : 'redacted';
  return new McpError(
    ErrorCode.InvalidRequest,
    `Resource access ${verb} by context policy: ${uri}`,
    buildResourcePolicyErrorData(uri, evaluation)
  );
}

export function isResourcePolicyError(error: unknown): error is McpError {
  return (
    error instanceof McpError
    && error.code === ErrorCode.InvalidRequest
    && typeof error.data === 'object'
    && error.data !== null
    && (error.data as ResourcePolicyErrorData).policyId === 'context-resource-policy'
  );
}

function enforcePolicyForPath(
  uri: string,
  requestedPath: string,
  context: ResourceReadContext
): ContextPolicyEvaluation {
  const evaluation = evaluateContextResourcePolicy({
    workspaceRoot: context.workspaceRoot,
    requestedPath,
    mode: context.mode,
    fieldName: 'path',
    allowedRoots: context.allowedRoots,
  });

  if (!evaluation.allowed) {
    throw resourcePolicyBlockedError(uri, evaluation);
  }

  return evaluation;
}

function readUtf8File(resolvedPath: string): string {
  return fs.readFileSync(resolvedPath, 'utf-8');
}

function readUtf8FileLines(resolvedPath: string, startLine: number, endLine: number): string {
  const content = readUtf8File(resolvedPath);
  const lines = content.split(/\r?\n/);
  if (startLine < 1 || endLine < startLine) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid chunk line range.');
  }
  if (startLine > lines.length) {
    throw new McpError(ErrorCode.InvalidParams, `Chunk start line ${startLine} exceeds file length (${lines.length}).`);
  }

  return lines.slice(startLine - 1, endLine).join('\n');
}

function resolveExistingFile(
  uri: string,
  evaluation: ContextPolicyEvaluation
): { normalizedPath: string; resolvedPath: string } {
  const normalizedPath = evaluation.normalizedPath;
  const resolvedPath = evaluation.resolvedPath;
  if (!normalizedPath || !resolvedPath) {
    throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
  }
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
  }
  return { normalizedPath, resolvedPath };
}

export function parseChunkId(chunkId: string): { path: string; startLine: number; endLine: number } | null {
  const match = CHUNK_ID_PATTERN.exec(chunkId);
  if (!match) {
    return null;
  }

  return {
    path: match[1],
    startLine: Number.parseInt(match[2], 10),
    endLine: Number.parseInt(match[3], 10),
  };
}

export function readPolicyEnforcedFileResource(
  uri: string,
  context?: ResourceReadContext
): ReadResourceResult {
  const resolvedContext = requireWorkspaceContext(context, uri);
  const encodedPath = uri.slice(FILE_RESOURCE_URI_PREFIX.length);
  const requestedPath = decodeResourceSegment(encodedPath, uri);
  const evaluation = enforcePolicyForPath(uri, requestedPath, resolvedContext);
  const { normalizedPath, resolvedPath } = resolveExistingFile(uri, evaluation);
  const text = readUtf8File(resolvedPath);

  return buildTextResourceContents(uri, text, inferMimeType(normalizedPath));
}

export function readPolicyEnforcedChunkResource(
  uri: string,
  context?: ResourceReadContext
): ReadResourceResult {
  const resolvedContext = requireWorkspaceContext(context, uri);
  const encodedChunkId = uri.slice(CHUNK_RESOURCE_URI_PREFIX.length);
  const chunkId = decodeResourceSegment(encodedChunkId, uri);
  const parsedChunk = parseChunkId(chunkId);
  if (!parsedChunk) {
    throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
  }

  const evaluation = enforcePolicyForPath(uri, parsedChunk.path, resolvedContext);
  const { normalizedPath, resolvedPath } = resolveExistingFile(uri, evaluation);
  const text = readUtf8FileLines(resolvedPath, parsedChunk.startLine, parsedChunk.endLine);

  return buildTextResourceContents(uri, text, inferMimeType(normalizedPath));
}

export async function readPolicyEnforcedSymbolResource(
  uri: string,
  context?: ResourceReadContext
): Promise<ReadResourceResult> {
  const resolvedContext = requireWorkspaceContext(context, uri);
  const encodedSymbolId = uri.slice(SYMBOL_RESOURCE_URI_PREFIX.length);
  const symbolId = decodeResourceSegment(encodedSymbolId, uri);

  if (!resolvedContext.serviceClient) {
    return buildTextResourceContents(
      uri,
      JSON.stringify(
        {
          symbol: symbolId,
          found: false,
          stub: true,
          policyId: 'context-resource-policy',
          receipts: [],
          message: 'Symbol lookup requires an active service client.',
        },
        null,
        2
      ),
      'application/json'
    );
  }

  const definition = await resolvedContext.serviceClient.symbolDefinition(symbolId);
  if (!definition.found || !definition.file) {
    throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
  }

  const evaluation = enforcePolicyForPath(uri, definition.file, resolvedContext);
  resolveExistingFile(uri, evaluation);

  return buildTextResourceContents(
    uri,
    JSON.stringify(
      {
        symbol: definition.symbol ?? symbolId,
        found: true,
        file: definition.file,
        line: definition.line,
        kind: definition.kind ?? null,
        snippet: definition.snippet ?? null,
        policyId: 'context-resource-policy',
        receipts: [],
      },
      null,
      2
    ),
    'application/json'
  );
}

export function applyContextPackResourcePolicy(
  pack: ContextPackV3,
  context: ResourceReadContext,
  uri: string
): ContextPackV3 {
  const resolvedContext = requireWorkspaceContext(context, uri);
  const mode = resolvedContext.mode ?? 'balanced';
  const receipts: ContextPolicyReceipt[] = [];
  let hasBlock = false;

  const items = pack.items.map((item) => {
    const itemResult = applyContextPackItemPolicy(item, resolvedContext.workspaceRoot, mode);
    if (itemResult.receipts.length > 0) {
      receipts.push(...itemResult.receipts);
    }
    if (itemResult.blocked) {
      hasBlock = true;
    }
    return itemResult.item;
  });

  if (hasBlock) {
    throw resourcePolicyBlockedError(uri, {
      allowed: false,
      action: 'block',
      receipts,
    });
  }

  return {
    ...pack,
    items,
  };
}

function applyContextPackItemPolicy(
  item: ContextPackItem,
  workspaceRoot: string,
  mode: ContextSafetyMode
): { item: ContextPackItem; receipts: ContextPolicyReceipt[]; blocked: boolean } {
  if (item.path) {
    const evaluation = evaluateContextResourcePolicy({
      workspaceRoot,
      requestedPath: item.path,
      mode,
      fieldName: 'path',
    });

    if (!evaluation.allowed) {
      const blocked = evaluation.action === 'block';
      return {
        item: blocked
          ? item
          : {
              ...item,
              content: '[REDACTED BY CONTEXT POLICY]',
            },
        receipts: evaluation.receipts,
        blocked,
      };
    }

    return { item, receipts: [], blocked: false };
  }

  const secretScan = scanContentForSecrets(item.content);
  if (!secretScan.contentHasSecrets) {
    return { item, receipts: [], blocked: false };
  }

  const action = mode === 'strict' ? 'block' : 'redact';
  const receipt: ContextPolicyReceipt = {
    policyId: 'context-resource-policy',
    action,
    reason: 'content_secret',
    path: item.id,
    message: 'Context pack item content matches secret-like patterns.',
    mode,
  };

  return {
    item: action === 'block'
      ? item
      : {
          ...item,
          content: '[REDACTED BY CONTEXT POLICY]',
        },
    receipts: [receipt],
    blocked: action === 'block',
  };
}

export async function readPolicyEnforcedContextPackResource(
  uri: string,
  context: ResourceReadContext | undefined,
  loadPack: (packId: string) => Promise<ContextPackV3 | null>
): Promise<ReadResourceResult> {
  requireWorkspaceContext(context, uri);
  const encodedPackId = uri.slice(CONTEXT_PACK_RESOURCE_URI_PREFIX.length);
  const packId = decodeResourceSegment(encodedPackId, uri);
  const pack = await loadPack(packId);
  if (!pack) {
    throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
  }

  const sanitizedPack = applyContextPackResourcePolicy(pack, context!, uri);
  return buildTextResourceContents(uri, JSON.stringify(sanitizedPack, null, 2), 'application/json');
}

export function matchesPolicyEnforcedResourceUri(uri: string): boolean {
  return (
    uri.startsWith(FILE_RESOURCE_URI_PREFIX)
    || uri.startsWith(CHUNK_RESOURCE_URI_PREFIX)
    || uri.startsWith(SYMBOL_RESOURCE_URI_PREFIX)
    || uri.startsWith(CONTEXT_PACK_RESOURCE_URI_PREFIX)
  );
}
