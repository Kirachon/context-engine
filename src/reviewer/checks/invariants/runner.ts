import { minimatch } from 'minimatch';
import type { ParsedDiff } from '../../../mcp/types/codeReview.js';
import type { EnterpriseFinding } from '../../types.js';
import type { InvariantsConfig, ReviewInvariant } from './types.js';

export interface InvariantRunResult {
  findings: EnterpriseFinding[];
  warnings: string[];
  checked_invariants: number;
}

function compileRegex(def: { pattern: string; flags?: string }): RegExp {
  try {
    return new RegExp(def.pattern, def.flags ?? '');
  } catch (e) {
    throw new Error(`Invalid regex: /${def.pattern}/${def.flags ?? ''} (${String(e)})`);
  }
}

function appliesToFile(invariant: ReviewInvariant, filePath: string): boolean {
  return invariant.paths.some(p => minimatch(filePath, p, { dot: true }));
}

function getAddedTextForFile(diff: ParsedDiff, filePath: string): string {
  const file = diff.files.find(f => f.new_path === filePath || f.old_path === filePath);
  if (!file) return '';
  return file.hunks
    .flatMap(h => h.lines)
    .filter(l => l.type === 'add')
    .map(l => l.content)
    .join('\n');
}

export function runInvariants(diff: ParsedDiff, changedFiles: string[], config: InvariantsConfig): InvariantRunResult {
  const findings: EnterpriseFinding[] = [];
  const warnings: string[] = [];

  const allInvariants = Object.values(config).flat();
  let checked = 0;

  for (const invariant of allInvariants) {
    if (!invariant.action) {
      warnings.push(`Invariant ${invariant.id} has no action; skipping deterministic evaluation`);
      continue;
    }

    for (const filePath of changedFiles) {
      if (!appliesToFile(invariant, filePath)) continue;
      checked++;

      const addedText = getAddedTextForFile(diff, filePath);
      const location = { file: filePath, startLine: 1, endLine: 1 };

      try {
        const fail = evaluateInvariant(invariant, addedText);
        if (fail) {
          findings.push({
            id: invariant.id,
            severity: invariant.severity,
            category: invariant.category,
            confidence: 0.95,
            title: invariant.rule.slice(0, 80),
            location,
            evidence: [fail.evidence],
            impact: fail.impact,
            recommendation: fail.recommendation,
          });
        }
      } catch (e) {
        warnings.push(`Invariant ${invariant.id} evaluation failed: ${String(e)}`);
      }
    }
  }

  return { findings, warnings, checked_invariants: checked };
}

function evaluateInvariant(
  invariant: ReviewInvariant,
  addedText: string
): { evidence: string; impact: string; recommendation: string } | null {
  const action = invariant.action;
  if (!action) return null;

  if (action === 'deny') {
    const deny = invariant.deny?.regex;
    if (!deny) {
      throw new Error('deny action requires deny.regex');
    }
    const re = compileRegex(deny);
    if (re.test(addedText)) {
      return {
        evidence: `deny.regex matched: /${deny.pattern}/${deny.flags ?? ''}`,
        impact: 'A project invariant was violated by newly added code.',
        recommendation: 'Refactor the change to comply with the invariant or update the policy intentionally.',
      };
    }
    return null;
  }

  if (action === 'require') {
    const req = invariant.require?.regex;
    if (!req) throw new Error('require action requires require.regex');
    const re = compileRegex(req);
    if (!re.test(addedText)) {
      return {
        evidence: `require.regex not found: /${req.pattern}/${req.flags ?? ''}`,
        impact: 'A required pattern was not found in newly added code for affected files.',
        recommendation: 'Add the required construct (or adjust the policy if it is no longer appropriate).',
      };
    }
    return null;
  }

  if (action === 'when_require') {
    const when = invariant.when?.regex;
    const req = invariant.require?.regex;
    if (!when || !req) throw new Error('when_require action requires when.regex and require.regex');
    const whenRe = compileRegex(when);
    const reqRe = compileRegex(req);
    if (whenRe.test(addedText) && !reqRe.test(addedText)) {
      return {
        evidence: `when.regex matched but require.regex missing: when=/${when.pattern}/${when.flags ?? ''} require=/${req.pattern}/${req.flags ?? ''}`,
        impact: 'Conditional invariant triggered; required safeguard appears missing.',
        recommendation: 'Add the required safeguard or remove the triggering behavior.',
      };
    }
    return null;
  }

  return null;
}

