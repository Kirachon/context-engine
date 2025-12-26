import type { EnterpriseReviewResult, EnterpriseFinding } from '../types.js';

// Minimal SARIF v2.1.0 generator for GitHub code scanning.
// We keep it dependency-free and small; callers can JSON.stringify() the result.

function toSarifLevel(severity: string): 'error' | 'warning' | 'note' {
  if (severity === 'CRITICAL') return 'error';
  if (severity === 'HIGH') return 'error';
  if (severity === 'MEDIUM') return 'warning';
  return 'note';
}

function stableRuleId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function buildRules(findings: EnterpriseFinding[]) {
  const byId = new Map<string, EnterpriseFinding>();
  for (const f of findings) {
    if (!byId.has(f.id)) byId.set(f.id, f);
  }
  return Array.from(byId.values()).map(f => ({
    id: stableRuleId(f.id),
    name: stableRuleId(f.id),
    shortDescription: { text: f.title },
    fullDescription: { text: f.recommendation },
    properties: {
      category: f.category,
      severity: f.severity,
      confidence: f.confidence,
    },
  }));
}

function buildResult(f: EnterpriseFinding) {
  return {
    ruleId: stableRuleId(f.id),
    level: toSarifLevel(f.severity),
    message: { text: `${f.title}\n\nImpact: ${f.impact}\n\nRecommendation: ${f.recommendation}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.location.file },
          region: {
            startLine: f.location.startLine,
            endLine: f.location.endLine ?? f.location.startLine,
          },
        },
      },
    ],
    properties: {
      id: f.id,
      category: f.category,
      severity: f.severity,
      confidence: f.confidence,
    },
  };
}

export function toSarif(result: EnterpriseReviewResult) {
  const findings = result.findings ?? [];
  const rules = buildRules(findings);

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'context-engine-review',
            version: result.metadata?.tool_version ?? 'unknown',
            rules,
          },
        },
        results: findings.map(buildResult),
      },
    ],
  };
}

