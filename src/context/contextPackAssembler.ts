import { createHash } from 'node:crypto';
import type { ContextBundle, FileContext, MemoryEntry } from '../mcp/serviceClient.js';
import type { ExternalReferenceSnippet } from '../mcp/tooling/externalGrounding.js';
import {
  CONTEXT_PACK_SCHEMA_VERSION,
  DEFAULT_CONTEXT_PACK_LIMITS,
  type ContextPackItem,
  type ContextPackItemKind,
  type ContextPackTokenBudget,
  type ContextPackTruncationReason,
  type ContextPackV3,
} from './types/contextPack.js';

export interface ContextPackAssemblerOptions {
  /** Override token budget; defaults to bundle.metadata.tokenBudget. */
  tokenBudget?: number;
  maxItems?: number;
  maxItemContentChars?: number;
  maxTotalContentChars?: number;
}

export interface AssembleContextPackResult {
  pack: ContextPackV3;
}

const PACK_ID_PREFIX = 'ctxp_';
const PACK_ID_HASH_LENGTH = 16;

/** Conservative token estimate aligned with ContextServiceClient. */
export function estimateContextPackTokens(text: string, charsPerToken = DEFAULT_CONTEXT_PACK_LIMITS.charsPerToken): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / charsPerToken);
}

function hashStable(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePath(pathValue: string | undefined): string {
  return (pathValue ?? '').replace(/\\/g, '/').trim();
}

function clampTokenBudget(value: number | undefined, fallback: number): number {
  const requested = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(
    DEFAULT_CONTEXT_PACK_LIMITS.maxTokenBudget,
    Math.max(DEFAULT_CONTEXT_PACK_LIMITS.minTokenBudget, requested)
  );
}

function truncateContent(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }
  return {
    content: content.slice(0, maxChars),
    truncated: true,
  };
}

function buildItemFingerprint(kind: ContextPackItemKind, path: string | undefined, rank: number, content: string): string {
  return `${kind}|${normalizePath(path)}|${rank}|${hashStable(content)}`;
}

/** Deterministic item id from stable item fields. */
export function computeContextPackItemId(
  kind: ContextPackItemKind,
  path: string | undefined,
  rank: number,
  content: string
): string {
  return `ctxi_${hashStable(buildItemFingerprint(kind, path, rank, content)).slice(0, PACK_ID_HASH_LENGTH)}`;
}

export interface ContextPackIdInput {
  query: string;
  tokenBudget: number;
  itemFingerprints: string[];
}

/** Deterministic pack id from stable assembly inputs. */
export function computeContextPackId(input: ContextPackIdInput): string {
  const normalizedQuery = input.query.trim();
  const sortedFingerprints = [...input.itemFingerprints].sort();
  const payload = JSON.stringify({
    query: normalizedQuery,
    tokenBudget: input.tokenBudget,
    items: sortedFingerprints,
    schema: CONTEXT_PACK_SCHEMA_VERSION,
  });
  return `${PACK_ID_PREFIX}${hashStable(payload).slice(0, PACK_ID_HASH_LENGTH)}`;
}

function fileItemsFromContext(file: FileContext, baseRank: number): ContextPackItem[] {
  const items: ContextPackItem[] = [];
  const path = normalizePath(file.path);

  if (file.snippets.length === 0) {
    const content = file.summary.trim() || path;
    const rank = baseRank;
    items.push({
      id: computeContextPackItemId('file', path, rank, content),
      kind: 'file',
      rank,
      path,
      content,
      token_count: file.tokenCount || estimateContextPackTokens(content),
      relevance: file.relevance,
      selection_rationale: file.selectionRationale,
    });
    return items;
  }

  for (let snippetIndex = 0; snippetIndex < file.snippets.length; snippetIndex += 1) {
    const snippet = file.snippets[snippetIndex];
    const rank = baseRank + snippetIndex;
    const content = snippet.text;
    items.push({
      id: computeContextPackItemId('snippet', path, rank, content),
      kind: 'snippet',
      rank,
      path,
      content,
      token_count: snippet.tokenCount || estimateContextPackTokens(content),
      relevance: snippet.relevance ?? file.relevance,
      lines: snippet.lines,
      selection_rationale: file.selectionRationale,
    });
  }

  return items;
}

function memoryItem(memory: MemoryEntry, rank: number): ContextPackItem {
  const titlePrefix = memory.title ? `${memory.title}\n\n` : '';
  const content = `${titlePrefix}${memory.content}`.trim();
  return {
    id: computeContextPackItemId('memory', memory.source, rank, content),
    kind: 'memory',
    rank,
    path: memory.source,
    content,
    token_count: estimateContextPackTokens(content),
    relevance: memory.relevanceScore,
    selection_rationale: memory.category ? `memory:${memory.category}` : 'memory',
  };
}

function hintItem(hint: string, rank: number): ContextPackItem {
  const content = hint.trim();
  return {
    id: computeContextPackItemId('hint', undefined, rank, content),
    kind: 'hint',
    rank,
    content,
    token_count: estimateContextPackTokens(content),
    selection_rationale: 'bundle_hint',
  };
}

function externalItem(reference: ExternalReferenceSnippet, rank: number): ContextPackItem {
  const label = reference.label?.trim() || reference.title?.trim();
  const header = label ? `[${label}]\n` : '';
  const body = reference.excerpt?.trim() || reference.url;
  const content = `${header}${body}`.trim();
  const path = reference.url;
  return {
    id: computeContextPackItemId('external', path, rank, content),
    kind: 'external',
    rank,
    path,
    content,
    token_count: estimateContextPackTokens(content),
    selection_rationale: reference.type ? `external:${reference.type}` : 'external',
  };
}

function flattenContextBundle(bundle: ContextBundle): ContextPackItem[] {
  const items: ContextPackItem[] = [];
  let rank = 0;

  for (const file of bundle.files) {
    const fileItems = fileItemsFromContext(file, rank);
    items.push(...fileItems);
    rank += fileItems.length;
  }

  for (const memory of bundle.memories ?? []) {
    items.push(memoryItem(memory, rank));
    rank += 1;
  }

  for (const hint of bundle.hints) {
    if (!hint.trim()) {
      continue;
    }
    items.push(hintItem(hint, rank));
    rank += 1;
  }

  for (const reference of bundle.externalReferences ?? []) {
    items.push(externalItem(reference, rank));
    rank += 1;
  }

  return items;
}

function countDistinctFilePaths(items: ContextPackItem[]): number {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.path && (item.kind === 'file' || item.kind === 'snippet')) {
      paths.add(normalizePath(item.path));
    }
  }
  return paths.size;
}

function applySizeAndBudgetLimits(
  items: ContextPackItem[],
  requestedTokenBudget: number,
  limits: {
    maxItems: number;
    maxItemContentChars: number;
    maxTotalContentChars: number;
  }
): { items: ContextPackItem[]; tokenBudget: ContextPackTokenBudget; truncationReasons: ContextPackTruncationReason[] } {
  const truncationReasons = new Set<ContextPackTruncationReason>();
  const selected: ContextPackItem[] = [];
  let usedTokens = 0;
  let totalContentChars = 0;

  for (const sourceItem of items) {
    if (selected.length >= limits.maxItems) {
      truncationReasons.add('max_items');
      break;
    }

    const { content: trimmedContent, truncated: itemTruncated } = truncateContent(
      sourceItem.content,
      limits.maxItemContentChars
    );
    if (itemTruncated) {
      truncationReasons.add('max_item_content_chars');
    }

    const nextTotalChars = totalContentChars + trimmedContent.length;
    if (nextTotalChars > limits.maxTotalContentChars) {
      truncationReasons.add('max_total_content_chars');
      break;
    }

    const itemTokenCount =
      trimmedContent === sourceItem.content
        ? sourceItem.token_count
        : estimateContextPackTokens(trimmedContent);

    if (usedTokens + itemTokenCount > requestedTokenBudget) {
      truncationReasons.add('token_budget');
      break;
    }

    const item: ContextPackItem =
      trimmedContent === sourceItem.content
        ? sourceItem
        : {
            ...sourceItem,
            content: trimmedContent,
            token_count: itemTokenCount,
            id: computeContextPackItemId(sourceItem.kind, sourceItem.path, sourceItem.rank, trimmedContent),
          };

    selected.push(item);
    usedTokens += item.token_count;
    totalContentChars = nextTotalChars;
  }

  const truncated = truncationReasons.size > 0 || selected.length < items.length;

  return {
    items: selected.map((item, index) => ({ ...item, rank: index })),
    tokenBudget: {
      requested: requestedTokenBudget,
      used: usedTokens,
      truncated,
    },
    truncationReasons: [...truncationReasons],
  };
}

/**
 * Build an ephemeral Context Pack V3 from an existing ContextBundle.
 * Pure function — no persistence or side effects.
 */
export function assembleContextPack(
  bundle: ContextBundle,
  options: ContextPackAssemblerOptions = {}
): AssembleContextPackResult {
  const maxItems = options.maxItems ?? DEFAULT_CONTEXT_PACK_LIMITS.maxItems;
  const maxItemContentChars = options.maxItemContentChars ?? DEFAULT_CONTEXT_PACK_LIMITS.maxItemContentChars;
  const maxTotalContentChars = options.maxTotalContentChars ?? DEFAULT_CONTEXT_PACK_LIMITS.maxTotalContentChars;
  const requestedTokenBudget = clampTokenBudget(
    options.tokenBudget ?? bundle.metadata.tokenBudget,
    DEFAULT_CONTEXT_PACK_LIMITS.defaultTokenBudget
  );

  const candidateItems = flattenContextBundle(bundle);
  const { items, tokenBudget, truncationReasons } = applySizeAndBudgetLimits(candidateItems, requestedTokenBudget, {
    maxItems,
    maxItemContentChars,
    maxTotalContentChars,
  });

  const mergedTruncationReasons = new Set<ContextPackTruncationReason>(truncationReasons);
  if (bundle.metadata.truncated) {
    mergedTruncationReasons.add('token_budget');
    tokenBudget.truncated = true;
  }

  const itemFingerprints = items.map((item) =>
    buildItemFingerprint(item.kind, item.path, item.rank, item.content)
  );

  const pack: ContextPackV3 = {
    schema_version: CONTEXT_PACK_SCHEMA_VERSION,
    id: computeContextPackId({
      query: bundle.query,
      tokenBudget: requestedTokenBudget,
      itemFingerprints,
    }),
    query: bundle.query,
    items,
    token_budget: tokenBudget,
    metadata: {
      item_count: items.length,
      file_count: countDistinctFilePaths(items),
      truncated: tokenBudget.truncated,
      ...(mergedTruncationReasons.size > 0
        ? { truncation_reasons: [...mergedTruncationReasons] }
        : {}),
      summary: bundle.summary,
      search_time_ms: bundle.metadata.searchTimeMs,
      assembled_at: new Date().toISOString(),
    },
  };

  return { pack };
}

/** Test helper: assemble with a fixed timestamp so snapshots stay stable. */
export function assembleContextPackWithTimestamp(
  bundle: ContextBundle,
  assembledAt: string,
  options: ContextPackAssemblerOptions = {}
): AssembleContextPackResult {
  const result = assembleContextPack(bundle, options);
  return {
    pack: {
      ...result.pack,
      metadata: {
        ...result.pack.metadata,
        assembled_at: assembledAt,
      },
    },
  };
}
