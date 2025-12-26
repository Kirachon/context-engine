export type ChangeType = 'feature' | 'bugfix' | 'refactor' | 'infra' | 'docs';

export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export type ReviewCategory =
  | 'correctness'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'style'
  | 'documentation'
  | 'reliability'
  | 'architecture'
  | 'infra';

export interface CodeLocation {
  file: string;
  startLine: number;
  endLine?: number;
}

export interface EnterpriseFinding {
  id: string;
  severity: FindingSeverity;
  category: ReviewCategory;
  confidence: number;
  title: string;
  location: CodeLocation;
  evidence: string[];
  impact: string;
  recommendation: string;
  suggested_patch?: string;
}

export interface ReviewStats {
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  duration_ms: number;
  deterministic_checks_executed: number;
  llm_passes_executed?: number;
  llm_findings_added?: number;
  llm_skipped_reason?: string;
}

export interface ReviewMetadata {
  reviewed_at: string;
  tool_version: string;
  warnings: string[];
  llm_model?: string;
}

export interface EnterpriseReviewResult {
  run_id: string;
  risk_score: number;
  classification: ChangeType;
  hotspots: string[];
  summary: string;
  findings: EnterpriseFinding[];
  /**
   * CI-friendly gate signal. This tool never throws to "fail" a build; instead,
   * consumers can use this boolean to decide whether to block merges.
   */
  should_fail?: boolean;
  fail_reasons?: string[];
  /** Optional SARIF output (when include_sarif=true) */
  sarif?: unknown;
  /** Optional GitHub markdown summary (when include_markdown=true) */
  markdown?: string;
  stats: ReviewStats;
  metadata: ReviewMetadata;
}
