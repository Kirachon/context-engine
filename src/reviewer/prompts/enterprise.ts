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

type EnterprisePromptSection = {
  title: string;
  body: string;
};

function buildEnterprisePrompt(args: {
  focus: string;
  customInstructions?: string;
  sections: EnterprisePromptSection[];
}): string {
  const parts = [
    'You are an expert code reviewer. Return only JSON matching the schema.',
    `Focus on ${args.focus}.`,
  ];

  const trimmedInstructions = args.customInstructions?.trim();
  if (trimmedInstructions) {
    parts.push(`CUSTOM INSTRUCTIONS:\n${trimmedInstructions}`);
  }

  for (const section of args.sections) {
    parts.push(`${section.title}:\n${section.body}`);
  }

  parts.push(`SCHEMA:\n${ENTERPRISE_FINDINGS_SCHEMA}`);
  return parts.join('\n\n');
}

export function buildStructuralPrompt(args: {
  diff: string;
  context: string;
  invariants: string;
  customInstructions?: string;
}): string {
  return buildEnterprisePrompt({
    focus: 'architecture, API compatibility, error handling patterns, and test gaps',
    customInstructions: args.customInstructions,
    sections: [
      { title: 'DIFF', body: args.diff },
      { title: 'CONTEXT', body: args.context },
      { title: 'INVARIANTS', body: args.invariants },
    ],
  });
}

export function buildDetailedPrompt(args: {
  diff: string;
  context: string;
  invariants: string;
  structuralFindingsJson: string;
  customInstructions?: string;
}): string {
  return buildEnterprisePrompt({
    focus: 'correctness bugs, edge cases, security issues, and performance regressions',
    customInstructions: args.customInstructions,
    sections: [
      { title: 'STRUCTURAL FINDINGS', body: args.structuralFindingsJson },
      { title: 'DIFF', body: args.diff },
      { title: 'CONTEXT', body: args.context },
      { title: 'INVARIANTS', body: args.invariants },
    ],
  });
}
