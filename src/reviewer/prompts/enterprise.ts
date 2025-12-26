export const ENTERPRISE_FINDINGS_SCHEMA = `{
  "findings": [
    {
      "id": "F001",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
      "category": "correctness|security|performance|maintainability|style|documentation|reliability|architecture|infra",
      "confidence": 0.0,
      "title": "short title",
      "location": { "file": "path", "startLine": 1, "endLine": 1 },
      "evidence": ["short snippet(s)"],
      "impact": "why it matters",
      "recommendation": "what to change",
      "suggested_patch": "optional unified diff string"
    }
  ]
}`;

export function buildStructuralPrompt(args: {
  diff: string;
  context: string;
  invariants: string;
  customInstructions?: string;
}): string {
  return `You are an expert code reviewer.\n\n` +
    `Focus on: architecture, API compatibility, error handling patterns, test gaps.\n` +
    `Do NOT return prose. Return only JSON matching the schema.\n\n` +
    (args.customInstructions ? `CUSTOM INSTRUCTIONS:\n${args.customInstructions}\n\n` : '') +
    `DIFF:\n${args.diff}\n\n` +
    `CONTEXT (diff-first excerpts):\n${args.context}\n\n` +
    `INVARIANTS (project policies):\n${args.invariants}\n\n` +
    `SCHEMA:\n${ENTERPRISE_FINDINGS_SCHEMA}\n`;
}

export function buildDetailedPrompt(args: {
  diff: string;
  context: string;
  invariants: string;
  structuralFindingsJson: string;
  customInstructions?: string;
}): string {
  return `You are an expert code reviewer.\n\n` +
    `Focus on: correctness bugs, edge cases, security issues, performance regressions.\n` +
    `Use structural findings as guidance; add new findings only.\n` +
    `Do NOT return prose. Return only JSON matching the schema.\n\n` +
    (args.customInstructions ? `CUSTOM INSTRUCTIONS:\n${args.customInstructions}\n\n` : '') +
    `STRUCTURAL FINDINGS (JSON):\n${args.structuralFindingsJson}\n\n` +
    `DIFF:\n${args.diff}\n\n` +
    `CONTEXT (diff-first excerpts):\n${args.context}\n\n` +
    `INVARIANTS (project policies):\n${args.invariants}\n\n` +
    `SCHEMA:\n${ENTERPRISE_FINDINGS_SCHEMA}\n`;
}

