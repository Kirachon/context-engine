/**
 * Planning Mode Type Definitions
 *
 * Enhanced types for AI-powered software planning and architecture design.
 * Supports DAG-based task dependencies, parallel execution detection,
 * and rich metadata for intelligent plan generation.
 */

// ============================================================================
// Core Plan Types
// ============================================================================

/**
 * Priority levels for plan steps
 */
export type StepPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Risk likelihood assessment
 */
export type RiskLikelihood = 'low' | 'medium' | 'high';

/**
 * File change operation types
 */
export type FileChangeType = 'create' | 'modify' | 'rename' | 'delete';

/**
 * Complexity estimation for file changes
 */
export type ChangeComplexity = 'trivial' | 'simple' | 'moderate' | 'complex';

/**
 * Diagram types supported for visualization
 */
export type DiagramType = 'architecture' | 'sequence' | 'flowchart' | 'er' | 'c4' | 'gantt';

// ============================================================================
// File Change Tracking
// ============================================================================

/**
 * Represents a planned change to a file
 */
export interface FileChange {
  /** File path relative to workspace root */
  path: string;
  /** Type of change operation */
  change_type: FileChangeType;
  /** Estimated lines of code affected */
  estimated_loc: number;
  /** Complexity assessment */
  complexity: ChangeComplexity;
  /** Brief explanation of the change */
  reason: string;
}

// ============================================================================
// Diagram Types
// ============================================================================

/**
 * A diagram generated as part of the plan
 */
export interface PlanDiagram {
  /** Type of diagram */
  type: DiagramType;
  /** Human-readable title */
  title: string;
  /** Mermaid diagram code */
  mermaid: string;
}

// ============================================================================
// Risk Assessment
// ============================================================================

/**
 * Identified risk with mitigation strategy
 */
export interface PlanRisk {
  /** Description of the risk */
  issue: string;
  /** Proposed mitigation approach */
  mitigation: string;
  /** Assessed likelihood */
  likelihood: RiskLikelihood;
  /** Impact if risk materializes */
  impact?: string;
}

// ============================================================================
// Testing Strategy
// ============================================================================

/**
 * Testing strategy for the planned implementation
 */
export interface TestingStrategy {
  /** Unit testing approach */
  unit: string;
  /** Integration testing approach */
  integration: string;
  /** End-to-end testing approach (optional) */
  e2e?: string;
  /** Target code coverage percentage */
  coverage_target: string;
  /** Specific test files to create or modify */
  test_files?: string[];
}

// ============================================================================
// Milestone and Step Types
// ============================================================================

/**
 * A milestone grouping multiple steps
 */
export interface PlanMilestone {
  /** Milestone name */
  name: string;
  /** Step numbers included in this milestone */
  steps_included: number[];
  /** Estimated time to complete */
  estimated_time: string;
  /** Key deliverables for this milestone */
  deliverables?: string[];
}

/**
 * Acceptance criterion for plan or step validation
 */
export interface AcceptanceCriterion {
  /** Description of the criterion */
  description: string;
  /** How to verify this criterion is met */
  verification: string;
}

/**
 * Output variable from a step (for ReWOO-style variable references)
 */
export interface StepOutput {
  /** Variable name */
  name: string;
  /** Description of what this output contains */
  description: string;
}

// ============================================================================
// Enhanced Plan Step
// ============================================================================

/**
 * Enhanced plan step with full metadata and dependency tracking
 */
export interface EnhancedPlanStep {
  /** Sequential step number */
  step_number: number;
  /** Unique identifier for variable references */
  id: string;
  /** Short descriptive title */
  title: string;
  /** Detailed description of what to do */
  description: string;

  // === File Operations ===
  /** Files to be modified */
  files_to_modify: FileChange[];
  /** New files to be created */
  files_to_create: FileChange[];
  /** Files to be deleted */
  files_to_delete: string[];

  // === Dependencies ===
  /** Step numbers this step depends on (must complete first) */
  depends_on: number[];
  /** Step numbers this step blocks */
  blocks: number[];
  /** Step numbers that can run in parallel with this step */
  can_parallel_with: number[];

  // === Execution Metadata ===
  /** Priority level */
  priority: StepPriority;
  /** Estimated effort (e.g., "2-3 hours") */
  estimated_effort: string;
  /** Estimated token count for context window planning */
  estimated_tokens?: number;

  // === Quality Assurance ===
  /** Acceptance criteria for this step */
  acceptance_criteria: string[];
  /** Strategy to undo changes if step fails */
  rollback_strategy?: string;

  // === Variable References (ReWOO-style) ===
  /** Outputs produced by this step that other steps can reference */
  outputs?: StepOutput[];
  /** Variables from previous steps used as input */
  input_refs?: string[];
}

// ============================================================================
// Dependency Graph (DAG)
// ============================================================================

/**
 * Node in the dependency graph
 */
export interface DependencyNode {
  /** Unique identifier */
  id: string;
  /** Corresponding step number */
  step_number: number;
}

/**
 * Edge in the dependency graph
 */
export interface DependencyEdge {
  /** Source step ID */
  from: string;
  /** Target step ID */
  to: string;
  /** Type of dependency */
  type: 'blocks' | 'informs';
}

/**
 * Complete dependency graph for the plan
 */
export interface DependencyGraph {
  /** All nodes in the graph */
  nodes: DependencyNode[];
  /** All edges representing dependencies */
  edges: DependencyEdge[];
  /** Step numbers on the critical path (longest dependency chain) */
  critical_path: number[];
  /** Groups of step numbers that can execute in parallel */
  parallel_groups: number[][];
  /** Topologically sorted execution order */
  execution_order: number[];
}

// ============================================================================
// Plan Scope
// ============================================================================

/**
 * Defines the scope boundaries of the plan
 */
export interface PlanScope {
  /** What is explicitly included in this plan */
  included: string[];
  /** What is explicitly excluded from this plan */
  excluded: string[];
  /** Assumptions the plan is based on */
  assumptions: string[];
  /** Constraints that must be respected */
  constraints: string[];
}

// ============================================================================
// Architecture Section
// ============================================================================

/**
 * Architecture decisions and visualizations
 */
export interface PlanArchitecture {
  /** High-level architecture notes and decisions */
  notes: string;
  /** Design patterns being used */
  patterns_used: string[];
  /** Generated diagrams */
  diagrams: PlanDiagram[];
}

// ============================================================================
// Feature Definitions
// ============================================================================

/**
 * A feature included in the plan
 */
export interface PlanFeature {
  /** Feature name */
  name: string;
  /** Feature description */
  description: string;
  /** Associated step numbers */
  steps: number[];
}

// ============================================================================
// Alternative Approaches
// ============================================================================

/**
 * An alternative approach that was considered
 */
export interface AlternativeApproach {
  /** Name of the alternative */
  name: string;
  /** Description of the approach */
  description: string;
  /** Why it wasn't chosen */
  reason_not_chosen: string;
  /** Potential advantages */
  pros: string[];
  /** Potential disadvantages */
  cons: string[];
}


// ============================================================================
// Main Plan Output
// ============================================================================

/**
 * Complete enhanced plan output with all metadata
 */
export interface EnhancedPlanOutput {
  // === Metadata ===
  /** Unique plan identifier */
  id: string;
  /** Plan version (increments on refinement) */
  version: number;
  /** Creation timestamp */
  created_at: string;
  /** Last update timestamp */
  updated_at: string;

  // === Core Plan ===
  /** Clear restatement of the goal with scope boundaries */
  goal: string;
  /** Scope definition */
  scope: PlanScope;

  // === Features ===
  /** Core must-have features */
  mvp_features: PlanFeature[];
  /** Optional enhancements */
  nice_to_have_features: PlanFeature[];

  // === Architecture ===
  /** Architecture decisions and diagrams */
  architecture: PlanArchitecture;

  // === Risk Assessment ===
  /** Identified risks with mitigations */
  risks: PlanRisk[];

  // === Execution Plan ===
  /** High-level milestones */
  milestones: PlanMilestone[];
  /** Detailed implementation steps */
  steps: EnhancedPlanStep[];

  // === Dependencies Graph (DAG) ===
  /** Dependency graph for parallel execution planning */
  dependency_graph: DependencyGraph;

  // === Quality & Testing ===
  /** Testing strategy */
  testing_strategy: TestingStrategy;
  /** Overall acceptance criteria */
  acceptance_criteria: AcceptanceCriterion[];

  // === Confidence & Alternatives ===
  /** LLM's confidence in the plan (0-1) */
  confidence_score: number;
  /** Questions needing clarification before proceeding */
  questions_for_clarification: string[];
  /** Alternative approaches considered */
  alternative_approaches?: AlternativeApproach[];

  // === Context Used ===
  /** Files analyzed to create this plan */
  context_files: string[];
  /** Key insights about the codebase */
  codebase_insights: string[];
}

// ============================================================================
// Plan Generation Options
// ============================================================================

/**
 * Options for plan generation
 */
export interface PlanGenerationOptions {
  /** Maximum refinement iterations (default: 3) */
  max_refinements?: number;
  /** Maximum files to include in context (default: 10) */
  max_context_files?: number;
  /** Token budget for context retrieval (default: 12000) */
  context_token_budget?: number;
  /** Include related files in context (default: true) */
  include_related_files?: boolean;
  /** Generate architecture diagrams (default: true) */
  generate_diagrams?: boolean;
  /** Analyze parallel execution opportunities (default: true) */
  analyze_parallelism?: boolean;
  /** Focus on MVP only (default: false) */
  mvp_only?: boolean;
}

/**
 * Options for plan refinement
 */
export interface PlanRefinementOptions {
  /** Clarification answers (keyed by question) */
  clarifications?: Record<string, string>;
  /** User feedback on the current plan */
  feedback?: string;
  /** Specific steps to focus on */
  focus_steps?: number[];
  /** Regenerate diagrams (default: false) */
  regenerate_diagrams?: boolean;
}

// ============================================================================
// Plan Status and Results
// ============================================================================

/**
 * Status of plan generation
 */
export type PlanStatus = 'generating' | 'needs_clarification' | 'ready' | 'approved' | 'executing' | 'completed' | 'failed';

/**
 * Result of a plan generation or refinement operation
 */
export interface PlanResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** The generated or refined plan */
  plan?: EnhancedPlanOutput;
  /** Current status */
  status: PlanStatus;
  /** Error message if failed */
  error?: string;
  /** Time taken in milliseconds */
  duration_ms: number;
}

/**
 * Summary of a plan for quick reference
 */
export interface PlanSummary {
  /** Plan ID */
  id: string;
  /** Goal summary */
  goal: string;
  /** Current status */
  status: PlanStatus;
  /** Number of steps */
  step_count: number;
  /** Number of files affected */
  files_affected: number;
  /** Estimated total effort */
  total_estimated_effort: string;
  /** Confidence score */
  confidence_score: number;
  /** Created timestamp */
  created_at: string;
}

// ============================================================================
// Phase 2: Plan Persistence Types
// ============================================================================

/**
 * Metadata for a persisted plan
 */
export interface PersistedPlanMetadata {
  /** Plan ID */
  id: string;
  /** Plan name (user-friendly) */
  name: string;
  /** Goal summary */
  goal: string;
  /** Current status */
  status: PlanStatus;
  /** Current version number */
  version: number;
  /** File path where plan is stored */
  file_path: string;
  /** Creation timestamp */
  created_at: string;
  /** Last update timestamp */
  updated_at: string;
  /** Number of steps */
  step_count: number;
  /** Tags for organization */
  tags?: string[];
}

/**
 * Options for saving a plan
 */
export interface SavePlanOptions {
  /** Custom name for the plan (defaults to derived from goal) */
  name?: string;
  /** Tags for organization */
  tags?: string[];
  /** Overwrite existing plan with same ID */
  overwrite?: boolean;
}

/**
 * Options for listing plans
 */
export interface ListPlansOptions {
  /** Filter by status */
  status?: PlanStatus;
  /** Filter by tags (any match) */
  tags?: string[];
  /** Sort by field */
  sort_by?: 'created_at' | 'updated_at' | 'name';
  /** Sort direction */
  sort_order?: 'asc' | 'desc';
  /** Maximum number of plans to return */
  limit?: number;
}

/**
 * Result of a persistence operation
 */
export interface PersistenceResult {
  /** Whether operation succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Plan ID affected */
  plan_id?: string;
  /** File path affected */
  file_path?: string;
}

// ============================================================================
// Phase 2: Approval Workflow Types
// ============================================================================

/**
 * Status of an approval request
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'modification_requested';

/**
 * Type of approval action
 */
export type ApprovalAction = 'approve' | 'reject' | 'request_modification';

/**
 * Request for user approval of a plan or step
 */
export interface ApprovalRequest {
  /** Unique request ID */
  id: string;
  /** Associated plan ID */
  plan_id: string;
  /** Optional step number (if approving specific step) */
  step_number?: number;
  /** Type of approval requested */
  type: 'full_plan' | 'step' | 'step_group';
  /** Current status */
  status: ApprovalStatus;
  /** What user is being asked to approve */
  summary: string;
  /** Detailed description */
  details: string;
  /** Files that will be affected */
  affected_files: string[];
  /** Potential risks identified */
  risks: string[];
  /** Creation timestamp */
  created_at: string;
  /** Resolution timestamp */
  resolved_at?: string;
  /** User response (if any) */
  response?: string;
  /** Modification notes (if modification requested) */
  modification_notes?: string;
}

/**
 * User response to an approval request
 */
export interface ApprovalResponse {
  /** Request ID being responded to */
  request_id: string;
  /** Action taken */
  action: ApprovalAction;
  /** Optional comment */
  comment?: string;
  /** Requested modifications (if action is request_modification) */
  modifications?: string;
}

/**
 * Result of an approval action
 */
export interface ApprovalResult {
  /** Whether the action succeeded */
  success: boolean;
  /** Updated request */
  request?: ApprovalRequest;
  /** Error message if failed */
  error?: string;
  /** Next steps after approval */
  next_steps?: string[];
}

// ============================================================================
// Phase 2: Execution Tracking Types
// ============================================================================

/**
 * Status of a step execution
 */
export type StepExecutionStatus =
  | 'pending'
  | 'ready'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'blocked';

/**
 * Execution state for a single step
 */
export interface StepExecutionState {
  /** Step number */
  step_number: number;
  /** Step ID */
  step_id: string;
  /** Current status */
  status: StepExecutionStatus;
  /** Start timestamp */
  started_at?: string;
  /** Completion timestamp */
  completed_at?: string;
  /** Duration in milliseconds */
  duration_ms?: number;
  /** Completion notes */
  notes?: string;
  /** Error message if failed */
  error?: string;
  /** Retry count */
  retry_count: number;
  /** Files actually modified */
  files_modified?: string[];
}

/**
 * Overall execution state for a plan
 */
export interface PlanExecutionState {
  /** Plan ID */
  plan_id: string;
  /** Plan version being executed */
  plan_version: number;
  /** Overall status */
  status: PlanStatus;
  /** Execution start timestamp */
  started_at?: string;
  /** Execution completion timestamp */
  completed_at?: string;
  /** Per-step execution states */
  steps: StepExecutionState[];
  /** Currently executing step numbers */
  current_steps: number[];
  /** Step numbers ready to execute */
  ready_steps: number[];
  /** Step numbers blocked by dependencies */
  blocked_steps: number[];
}

/**
 * Progress summary for a plan execution
 */
export interface ExecutionProgress {
  /** Plan ID */
  plan_id: string;
  /** Total number of steps */
  total_steps: number;
  /** Completed steps count */
  completed_steps: number;
  /** Failed steps count */
  failed_steps: number;
  /** Skipped steps count */
  skipped_steps: number;
  /** In-progress steps count */
  in_progress_steps: number;
  /** Blocked steps count */
  blocked_steps: number;
  /** Ready to execute steps count */
  ready_steps: number;
  /** Pending steps count */
  pending_steps: number;
  /** Completion percentage (0-100) */
  percentage: number;
  /** Estimated time remaining */
  estimated_remaining?: string;
}

/**
 * Options for completing a step
 */
export interface CompleteStepOptions {
  /** Completion notes */
  notes?: string;
  /** Files actually modified */
  files_modified?: string[];
  /** Skip dependent steps if this step failed */
  skip_dependents_on_failure?: boolean;
}

/**
 * Options for failing a step
 */
export interface FailStepOptions {
  /** Error message */
  error: string;
  /** Whether to retry */
  retry?: boolean;
  /** Skip this step and continue */
  skip?: boolean;
  /** Skip all dependent steps */
  skip_dependents?: boolean;
}

// ============================================================================
// Phase 2: Plan History Types
// ============================================================================

/**
 * A version entry in plan history
 */
export interface PlanVersion {
  /** Version number */
  version: number;
  /** Creation timestamp */
  created_at: string;
  /** What changed in this version */
  change_summary: string;
  /** Type of change */
  change_type: 'created' | 'refined' | 'approved' | 'modified' | 'executed' | 'rolled_back';
  /** Who made the change (if available) */
  changed_by?: string;
  /** The full plan at this version */
  plan: EnhancedPlanOutput;
}

/**
 * Difference between two plan versions
 */
export interface PlanDiff {
  /** Original version number */
  from_version: number;
  /** New version number */
  to_version: number;
  /** Summary of changes */
  summary: string;
  /** Steps added */
  steps_added: number[];
  /** Steps removed */
  steps_removed: number[];
  /** Steps modified */
  steps_modified: number[];
  /** Files added to plan */
  files_added: string[];
  /** Files removed from plan */
  files_removed: string[];
  /** Changes to scope */
  scope_changes?: {
    included_added: string[];
    included_removed: string[];
    excluded_added: string[];
    excluded_removed: string[];
  };
  /** Changes to risks */
  risks_added: string[];
  /** Changes to risks */
  risks_removed: string[];
  /** Detailed field changes */
  field_changes: FieldChange[];
}

/**
 * A single field change in a diff
 */
export interface FieldChange {
  /** Path to the changed field (e.g., "steps[0].description") */
  path: string;
  /** Type of change */
  type: 'added' | 'removed' | 'modified';
  /** Old value (for modified/removed) */
  old_value?: unknown;
  /** New value (for modified/added) */
  new_value?: unknown;
}

/**
 * Complete history for a plan
 */
export interface PlanHistory {
  /** Plan ID */
  plan_id: string;
  /** Current version number */
  current_version: number;
  /** All versions */
  versions: PlanVersion[];
  /** Creation timestamp of the plan */
  created_at: string;
  /** Last modification timestamp */
  last_modified_at: string;
}

/**
 * Options for viewing history
 */
export interface HistoryOptions {
  /** Number of versions to retrieve */
  limit?: number;
  /** Include full plan in each version (default: false) */
  include_plans?: boolean;
  /** Only versions after this timestamp */
  since?: string;
  /** Only versions before this timestamp */
  until?: string;
}

/**
 * Options for rolling back to a previous version
 */
export interface RollbackOptions {
  /** Version to roll back to */
  target_version: number;
  /** Reason for rollback */
  reason?: string;
  /** Whether to preserve execution state */
  preserve_execution_state?: boolean;
}

/**
 * Result of a rollback operation
 */
export interface RollbackResult {
  /** Whether rollback succeeded */
  success: boolean;
  /** The restored plan */
  plan?: EnhancedPlanOutput;
  /** New version number after rollback */
  new_version?: number;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Phase 2: Combined State Types
// ============================================================================

/**
 * Complete state for a plan including execution and approval state
 */
export interface CompletePlanState {
  /** The plan itself */
  plan: EnhancedPlanOutput;
  /** Execution state */
  execution: PlanExecutionState;
  /** Pending approval requests */
  pending_approvals: ApprovalRequest[];
  /** History summary */
  version_count: number;
  /** Persisted metadata */
  metadata: PersistedPlanMetadata;
}

