import type { EnterpriseReviewResult, EnterpriseFinding } from '../types.js';

function sortBySeverity(a: EnterpriseFinding, b: EnterpriseFinding): number {
  const order: Record<string, number> = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };
  return (order[b.severity] ?? 0) - (order[a.severity] ?? 0);
}

function escapeMd(text: string): string {
  return text.replace(/[<>]/g, s => (s === '<' ? '&lt;' : '&gt;'));
}

export function formatGitHubComment(result: EnterpriseReviewResult): string {
  const lines: string[] = [];

  lines.push('## Code Review Summary');
  lines.push('');
  lines.push(`- Risk: **${result.risk_score}/5**`);
  lines.push(`- Classification: **${result.classification}**`);
  if (result.hotspots?.length) lines.push(`- Hotspots: ${result.hotspots.map(h => `\`${h}\``).join(', ')}`);
  if (result.should_fail) lines.push(`- CI gate: **FAIL**`);
  if (result.should_fail === false) lines.push(`- CI gate: **PASS**`);
  lines.push('');

  if (result.summary) {
    lines.push(escapeMd(result.summary));
    lines.push('');
  }

  const findings = (result.findings ?? []).slice().sort(sortBySeverity);
  if (findings.length === 0) {
    lines.push('No findings.');
    return lines.join('\n');
  }

  lines.push('## Findings');
  lines.push('');
  for (const f of findings.slice(0, 20)) {
    const loc = `${f.location.file}:${f.location.startLine}`;
    lines.push(`- **${f.severity}** \`${f.id}\` (${f.category}) at \`${loc}\`: ${escapeMd(f.title)}`);
  }

  if (findings.length > 20) {
    lines.push('');
    lines.push(`(Showing first 20 of ${findings.length} findings.)`);
  }

  if (result.fail_reasons?.length) {
    lines.push('');
    lines.push('## CI Gate Reasons');
    lines.push('');
    for (const r of result.fail_reasons.slice(0, 20)) {
      lines.push(`- ${escapeMd(r)}`);
    }
  }

  return lines.join('\n');
}

