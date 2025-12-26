import type { EnterpriseFinding } from '../types.js';

/**
 * Deterministically dedupe findings by `id`, preserving the first occurrence order.
 * This is intentionally minimal to avoid changing any output ordering semantics.
 */
export function dedupeFindingsById(findings: EnterpriseFinding[]): EnterpriseFinding[] {
  const seen = new Set<string>();
  const out: EnterpriseFinding[] = [];
  for (const f of findings) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

