/**
 * Layer 2: Planning Service
 *
 * Service layer for AI-powered software planning and architecture design.
 * Integrates with the ContextServiceClient to leverage codebase context
 * and uses the Auggie SDK's searchAndAsk for AI-powered plan generation.
 *
 * Responsibilities:
 * - Generate structured implementation plans
 * - Refine plans based on user feedback
 * - Analyze task dependencies and parallelization opportunities
 * - Generate architecture diagrams
 * - Validate and parse LLM responses
 */

import { ContextServiceClient, ContextBundle } from '../serviceClient.js';
import {
  EnhancedPlanOutput,
  EnhancedPlanStep,
  PlanGenerationOptions,
  PlanRefinementOptions,
  PlanResult,
  PlanStatus,
  DependencyGraph,
  DependencyNode,
  DependencyEdge,
  PlanSummary,
} from '../types/planning.js';
import {
  PLANNING_SYSTEM_PROMPT,
  REFINEMENT_SYSTEM_PROMPT,
  buildPlanningPrompt,
  buildRefinementPrompt,
  extractJsonFromResponse,
} from '../prompts/planning.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum retries for JSON parsing failures */
const MAX_PARSE_RETRIES = 2;

/** Default options for plan generation */
const DEFAULT_OPTIONS: Required<PlanGenerationOptions> = {
  max_refinements: 3,
  max_context_files: 10,
  context_token_budget: 12000,
  include_related_files: true,
  generate_diagrams: true,
  analyze_parallelism: true,
  mvp_only: false,
};

// ============================================================================
// Planning Service Class
// ============================================================================

export class PlanningService {
  private contextClient: ContextServiceClient;

  constructor(contextClient: ContextServiceClient) {
    this.contextClient = contextClient;
  }

  // ==========================================================================
  // Core Planning Methods
  // ==========================================================================

  /**
   * Generate an implementation plan for a given task
   */
  async generatePlan(
    task: string,
    options?: PlanGenerationOptions
  ): Promise<PlanResult> {
    const startTime = Date.now();
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Safely handle potentially undefined task
    const taskPreview = task && typeof task === 'string' ? task.substring(0, 100) : 'undefined task';
    console.error(`[PlanningService] Generating plan for: "${taskPreview}..."`);

    try {
      // Step 1: Get relevant codebase context
      const context = await this.getRelevantContext(task, opts);
      console.error(`[PlanningService] Retrieved context from ${context.files.length} files`);

      // Step 2: Build the planning prompt with context
      const contextSummary = this.formatContextForPrompt(context);
      const planningPrompt = buildPlanningPrompt(task, contextSummary);

      // Step 3: Combine system prompt with planning prompt for searchAndAsk
      const fullPrompt = `${PLANNING_SYSTEM_PROMPT}\n\n${planningPrompt}`;

      // Step 4: Call AI to generate the plan
      const response = await this.contextClient.searchAndAsk(task, fullPrompt);

      // =========================================================================
      // PARALLELIZATION: Parse plan and prepare dependency analysis concurrently
      //
      // Strategy: Parse the full plan while also doing an early extraction of
      // steps from the raw JSON for dependency analysis preparation. This allows
      // us to start dependency graph construction as soon as steps are available.
      //
      // Estimated time savings: 1-2 seconds for complex plans
      // =========================================================================

      // Step 5: Early JSON extraction for parallel processing
      const jsonStr = extractJsonFromResponse(response);
      if (!jsonStr) {
        throw new Error('Failed to extract JSON from LLM response');
      }

      // Parse JSON once and share between validation and dependency analysis
      let parsedJson: Record<string, unknown>;
      try {
        parsedJson = JSON.parse(jsonStr);
      } catch (error) {
        throw new Error(`Failed to parse plan JSON: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Step 6: Concurrent post-processing using Promise.all
      // - Full plan validation (async)
      // - Early dependency graph computation (if enabled)
      const [plan, earlyDependencyGraph] = await Promise.all([
        // Parse and validate the full plan
        this.parseAndValidatePlanFromJson(parsedJson, context),

        // Pre-compute dependency graph from raw steps (if enabled)
        // This runs concurrently with validation, saving time
        opts.analyze_parallelism
          ? Promise.resolve(this.earlyAnalyzeDependencies(parsedJson.steps))
          : Promise.resolve(null),
      ]);

      // Apply pre-computed dependency graph if available
      if (earlyDependencyGraph && opts.analyze_parallelism) {
        plan.dependency_graph = earlyDependencyGraph;
      }

      // Step 7: Determine status based on clarification questions
      const status: PlanStatus = plan.questions_for_clarification.length > 0
        ? 'needs_clarification'
        : 'ready';

      console.error(`[PlanningService] Plan generated successfully (${plan.steps.length} steps)`);

      return {
        success: true,
        plan,
        status,
        duration_ms: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PlanningService] Failed to generate plan: ${errorMessage}`);

      return {
        success: false,
        status: 'failed',
        error: errorMessage,
        duration_ms: Date.now() - startTime,
      };
    }
  }

  /**
   * Refine an existing plan based on feedback
   */
  async refinePlan(
    currentPlan: EnhancedPlanOutput,
    options: PlanRefinementOptions
  ): Promise<PlanResult> {
    const startTime = Date.now();

    console.error(`[PlanningService] Refining plan v${currentPlan.version}`);

    try {
      // Build refinement prompt
      const feedback = options.feedback || 'Please refine based on the clarifications provided.';
      const currentPlanJson = JSON.stringify(currentPlan, null, 2);
      const refinementPrompt = buildRefinementPrompt(
        currentPlanJson,
        feedback,
        options.clarifications
      );

      // Combine with refinement system prompt
      const fullPrompt = `${REFINEMENT_SYSTEM_PROMPT}\n\n${refinementPrompt}`;

      // Call AI to refine
      const response = await this.contextClient.searchAndAsk(currentPlan.goal, fullPrompt);

      // Parse the refined plan
      const refinedPlan = await this.parseAndValidatePlan(response, null, currentPlan);

      // Ensure version is incremented
      refinedPlan.version = currentPlan.version + 1;
      refinedPlan.updated_at = new Date().toISOString();

      return {
        success: true,
        plan: refinedPlan,
        status: refinedPlan.questions_for_clarification.length > 0 ? 'needs_clarification' : 'ready',
        duration_ms: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PlanningService] Failed to refine plan: ${errorMessage}`);

      return {
        success: false,
        status: 'failed',
        error: errorMessage,
        duration_ms: Date.now() - startTime,
      };
    }
  }

  // ==========================================================================
  // Context Retrieval
  // ==========================================================================

  /**
   * Get relevant codebase context for planning
   */
  private async getRelevantContext(
    task: string,
    options: Required<PlanGenerationOptions>
  ): Promise<ContextBundle> {
    return this.contextClient.getContextForPrompt(task, {
      maxFiles: options.max_context_files,
      tokenBudget: options.context_token_budget,
      includeRelated: options.include_related_files,
      minRelevance: 0.2,
      includeSummaries: true,
    });
  }

  /**
   * Format context bundle for inclusion in the planning prompt
   */
  private formatContextForPrompt(context: ContextBundle): string {
    let formatted = `### Summary\n${context.summary}\n\n`;

    if (context.hints.length > 0) {
      formatted += `### Key Insights\n`;
      for (const hint of context.hints) {
        formatted += `- ${hint}\n`;
      }
      formatted += '\n';
    }

    formatted += `### Relevant Files (${context.files.length} files)\n\n`;

    for (const file of context.files) {
      formatted += `#### ${file.path}\n`;
      formatted += `> ${file.summary}\n\n`;

      for (const snippet of file.snippets) {
        formatted += `Lines ${snippet.lines}:\n`;
        formatted += '```\n';
        formatted += snippet.text;
        formatted += '\n```\n\n';
      }
    }

    return formatted;
  }

  // ==========================================================================
  // Plan Parsing and Validation
  // ==========================================================================

  /**
   * Parse and validate the LLM response into a structured plan
   */
  private async parseAndValidatePlan(
    response: string,
    context: ContextBundle | null,
    previousPlan?: EnhancedPlanOutput
  ): Promise<EnhancedPlanOutput> {
    // Extract JSON from response
    const jsonStr = extractJsonFromResponse(response);
    if (!jsonStr) {
      throw new Error('Failed to extract JSON from LLM response');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (error) {
      throw new Error(`Failed to parse plan JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Build the validated plan with defaults
    const now = new Date().toISOString();
    const plan: EnhancedPlanOutput = {
      // Metadata
      id: previousPlan?.id || this.generatePlanId(),
      version: previousPlan ? previousPlan.version + 1 : 1,
      created_at: previousPlan?.created_at || now,
      updated_at: now,

      // Core plan
      goal: String(parsed.goal || ''),
      scope: this.validateScope(parsed.scope),

      // Features
      mvp_features: this.validateFeatures(parsed.mvp_features),
      nice_to_have_features: this.validateFeatures(parsed.nice_to_have_features),

      // Architecture
      architecture: this.validateArchitecture(parsed.architecture),

      // Risks
      risks: this.validateRisks(parsed.risks),

      // Milestones and steps
      milestones: this.validateMilestones(parsed.milestones),
      steps: this.validateSteps(parsed.steps),

      // Dependency graph (will be populated later)
      dependency_graph: {
        nodes: [],
        edges: [],
        critical_path: [],
        parallel_groups: [],
        execution_order: [],
      },

      // Quality
      testing_strategy: this.validateTestingStrategy(parsed.testing_strategy),
      acceptance_criteria: this.validateAcceptanceCriteria(parsed.acceptance_criteria),

      // Confidence
      confidence_score: this.validateConfidenceScore(parsed.confidence_score),
      questions_for_clarification: this.validateStringArray(parsed.questions_for_clarification),
      alternative_approaches: this.validateAlternatives(parsed.alternative_approaches),

      // Context
      context_files: context?.files.map(f => f.path) || previousPlan?.context_files || [],
      codebase_insights: this.validateStringArray(parsed.codebase_insights),
    };

    return plan;
  }

  /**
   * Parse and validate plan from already-parsed JSON object
   *
   * This is an optimized version of parseAndValidatePlan that skips the
   * JSON extraction/parsing step since it's already done. Used for
   * concurrent post-processing where JSON is parsed once and shared.
   *
   * @param parsed - Already-parsed JSON object from the LLM response
   * @param context - Context bundle used for the planning request
   * @param previousPlan - Optional previous plan for version tracking
   */
  private async parseAndValidatePlanFromJson(
    parsed: Record<string, unknown>,
    context: ContextBundle | null,
    previousPlan?: EnhancedPlanOutput
  ): Promise<EnhancedPlanOutput> {
    // Build the validated plan with defaults
    const now = new Date().toISOString();
    const plan: EnhancedPlanOutput = {
      // Metadata
      id: previousPlan?.id || this.generatePlanId(),
      version: previousPlan ? previousPlan.version + 1 : 1,
      created_at: previousPlan?.created_at || now,
      updated_at: now,

      // Core plan
      goal: String(parsed.goal || ''),
      scope: this.validateScope(parsed.scope),

      // Features
      mvp_features: this.validateFeatures(parsed.mvp_features),
      nice_to_have_features: this.validateFeatures(parsed.nice_to_have_features),

      // Architecture
      architecture: this.validateArchitecture(parsed.architecture),

      // Risks
      risks: this.validateRisks(parsed.risks),

      // Milestones and steps
      milestones: this.validateMilestones(parsed.milestones),
      steps: this.validateSteps(parsed.steps),

      // Dependency graph (will be populated later or concurrently)
      dependency_graph: {
        nodes: [],
        edges: [],
        critical_path: [],
        parallel_groups: [],
        execution_order: [],
      },

      // Quality
      testing_strategy: this.validateTestingStrategy(parsed.testing_strategy),
      acceptance_criteria: this.validateAcceptanceCriteria(parsed.acceptance_criteria),

      // Confidence
      confidence_score: this.validateConfidenceScore(parsed.confidence_score),
      questions_for_clarification: this.validateStringArray(parsed.questions_for_clarification),
      alternative_approaches: this.validateAlternatives(parsed.alternative_approaches),

      // Context
      context_files: context?.files.map(f => f.path) || previousPlan?.context_files || [],
      codebase_insights: this.validateStringArray(parsed.codebase_insights),
    };

    return plan;
  }

  /**
   * Early dependency analysis from raw parsed JSON steps
   *
   * This method performs dependency analysis directly from the raw JSON steps
   * array, allowing it to run concurrently with full plan validation. It's
   * designed to be fault-tolerant and will return an empty graph on errors.
   *
   * @param rawSteps - Raw steps array from parsed JSON (may be invalid)
   * @returns DependencyGraph or null if steps are invalid
   */
  private earlyAnalyzeDependencies(rawSteps: unknown): DependencyGraph | null {
    try {
      // Quick validation - must be an array with at least one item
      if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        return null;
      }

      // Validate that steps have minimum required structure
      const hasValidSteps = rawSteps.every((step: unknown) =>
        step && typeof step === 'object' && 'step_number' in step
      );

      if (!hasValidSteps) {
        return null;
      }

      // Use the existing analyzeDependencies with validated steps
      // Note: validateSteps is called to ensure proper structure
      const validatedSteps = this.validateSteps(rawSteps);
      return this.analyzeDependencies(validatedSteps);
    } catch (error) {
      // On any error, return null - the main flow will handle it
      console.error('[PlanningService] Early dependency analysis failed:', error);
      return null;
    }
  }

  // ==========================================================================
  // Validation Helpers
  // ==========================================================================

  private validateScope(scope: unknown): EnhancedPlanOutput['scope'] {
    if (!scope || typeof scope !== 'object') {
      return { included: [], excluded: [], assumptions: [], constraints: [] };
    }
    const s = scope as Record<string, unknown>;
    return {
      included: this.validateStringArray(s.included),
      excluded: this.validateStringArray(s.excluded),
      assumptions: this.validateStringArray(s.assumptions),
      constraints: this.validateStringArray(s.constraints),
    };
  }

  private validateFeatures(features: unknown): EnhancedPlanOutput['mvp_features'] {
    if (!Array.isArray(features)) return [];
    return features.map(f => ({
      name: String(f?.name || ''),
      description: String(f?.description || ''),
      steps: Array.isArray(f?.steps) ? f.steps.filter((n: unknown) => typeof n === 'number') : [],
    }));
  }

  private validateArchitecture(arch: unknown): EnhancedPlanOutput['architecture'] {
    if (!arch || typeof arch !== 'object') {
      return { notes: '', patterns_used: [], diagrams: [] };
    }
    const a = arch as Record<string, unknown>;
    return {
      notes: String(a.notes || ''),
      patterns_used: this.validateStringArray(a.patterns_used),
      diagrams: Array.isArray(a.diagrams)
        ? a.diagrams.map(d => ({
            type: String(d?.type || 'architecture') as 'architecture',
            title: String(d?.title || ''),
            mermaid: String(d?.mermaid || ''),
          }))
        : [],
    };
  }

  private validateRisks(risks: unknown): EnhancedPlanOutput['risks'] {
    if (!Array.isArray(risks)) return [];
    return risks.map(r => ({
      issue: String(r?.issue || ''),
      mitigation: String(r?.mitigation || ''),
      likelihood: this.validateLikelihood(r?.likelihood),
      impact: r?.impact ? String(r.impact) : undefined,
    }));
  }

  private validateLikelihood(l: unknown): 'low' | 'medium' | 'high' {
    if (l === 'low' || l === 'medium' || l === 'high') return l;
    return 'medium';
  }

  private validateMilestones(milestones: unknown): EnhancedPlanOutput['milestones'] {
    if (!Array.isArray(milestones)) return [];
    return milestones.map(m => ({
      name: String(m?.name || ''),
      steps_included: Array.isArray(m?.steps_included) ? m.steps_included : [],
      estimated_time: String(m?.estimated_time || ''),
      deliverables: Array.isArray(m?.deliverables) ? m.deliverables : undefined,
    }));
  }

  private validateSteps(steps: unknown): EnhancedPlanStep[] {
    if (!Array.isArray(steps)) return [];
    return steps.map((s, index) => ({
      step_number: typeof s?.step_number === 'number' ? s.step_number : index + 1,
      id: String(s?.id || `step_${index + 1}`),
      title: String(s?.title || ''),
      description: String(s?.description || ''),
      files_to_modify: this.validateFileChanges(s?.files_to_modify),
      files_to_create: this.validateFileChanges(s?.files_to_create),
      files_to_delete: this.validateStringArray(s?.files_to_delete),
      depends_on: Array.isArray(s?.depends_on) ? s.depends_on.filter((n: unknown) => typeof n === 'number') : [],
      blocks: Array.isArray(s?.blocks) ? s.blocks.filter((n: unknown) => typeof n === 'number') : [],
      can_parallel_with: Array.isArray(s?.can_parallel_with) ? s.can_parallel_with : [],
      priority: this.validatePriority(s?.priority),
      estimated_effort: String(s?.estimated_effort || ''),
      acceptance_criteria: this.validateStringArray(s?.acceptance_criteria),
      rollback_strategy: s?.rollback_strategy ? String(s.rollback_strategy) : undefined,
      outputs: Array.isArray(s?.outputs) ? s.outputs : undefined,
      input_refs: Array.isArray(s?.input_refs) ? s.input_refs : undefined,
    }));
  }

  private validateFileChanges(changes: unknown): EnhancedPlanStep['files_to_modify'] {
    if (!Array.isArray(changes)) return [];
    return changes.map(c => ({
      path: String(c?.path || ''),
      change_type: this.validateChangeType(c?.change_type),
      estimated_loc: typeof c?.estimated_loc === 'number' ? c.estimated_loc : 0,
      complexity: this.validateComplexity(c?.complexity),
      reason: String(c?.reason || ''),
    }));
  }

  private validateChangeType(t: unknown): 'create' | 'modify' | 'rename' | 'delete' {
    if (t === 'create' || t === 'modify' || t === 'rename' || t === 'delete') return t;
    return 'modify';
  }

  private validateComplexity(c: unknown): 'trivial' | 'simple' | 'moderate' | 'complex' {
    if (c === 'trivial' || c === 'simple' || c === 'moderate' || c === 'complex') return c;
    return 'moderate';
  }

  private validatePriority(p: unknown): 'critical' | 'high' | 'medium' | 'low' {
    if (p === 'critical' || p === 'high' || p === 'medium' || p === 'low') return p;
    return 'medium';
  }

  private validateTestingStrategy(strategy: unknown): EnhancedPlanOutput['testing_strategy'] {
    if (!strategy || typeof strategy !== 'object') {
      return { unit: '', integration: '', coverage_target: '80%' };
    }
    const s = strategy as Record<string, unknown>;
    return {
      unit: String(s.unit || ''),
      integration: String(s.integration || ''),
      e2e: s.e2e ? String(s.e2e) : undefined,
      coverage_target: String(s.coverage_target || '80%'),
      test_files: Array.isArray(s.test_files) ? s.test_files : undefined,
    };
  }

  private validateAcceptanceCriteria(criteria: unknown): EnhancedPlanOutput['acceptance_criteria'] {
    if (!Array.isArray(criteria)) return [];
    return criteria.map(c => ({
      description: String(c?.description || ''),
      verification: String(c?.verification || ''),
    }));
  }

  private validateConfidenceScore(score: unknown): number {
    if (typeof score === 'number' && score >= 0 && score <= 1) return score;
    return 0.5;
  }

  private validateStringArray(arr: unknown): string[] {
    if (!Array.isArray(arr)) return [];
    return arr.filter(s => typeof s === 'string').map(s => String(s));
  }

  private validateAlternatives(alts: unknown): EnhancedPlanOutput['alternative_approaches'] {
    if (!Array.isArray(alts)) return undefined;
    return alts.map(a => ({
      name: String(a?.name || ''),
      description: String(a?.description || ''),
      reason_not_chosen: String(a?.reason_not_chosen || ''),
      pros: this.validateStringArray(a?.pros),
      cons: this.validateStringArray(a?.cons),
    }));
  }

  private generatePlanId(): string {
    return `plan_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  // ==========================================================================
  // Dependency Analysis (DAG)
  // ==========================================================================

  /**
   * Analyze step dependencies and build the dependency graph
   */
  analyzeDependencies(steps: EnhancedPlanStep[]): DependencyGraph {
    // Safely handle undefined/null steps array
    const safeSteps = Array.isArray(steps) ? steps : [];

    // Build nodes
    const nodes: DependencyNode[] = safeSteps.map(s => ({
      id: s.id || `step_${s.step_number || 'unknown'}`,
      step_number: s.step_number || 0,
    }));

    // Build edges from depends_on and blocks relationships
    const edges: DependencyEdge[] = [];
    const stepMap = new Map(safeSteps.map(s => [s.step_number, s]));

    for (const step of safeSteps) {
      // Safely handle undefined depends_on and blocks arrays
      const dependsOn = Array.isArray(step.depends_on) ? step.depends_on : [];
      const blocks = Array.isArray(step.blocks) ? step.blocks : [];

      // Add edges for dependencies
      for (const depNum of dependsOn) {
        const depStep = stepMap.get(depNum);
        if (depStep) {
          edges.push({
            from: depStep.id,
            to: step.id,
            type: 'blocks',
          });
        }
      }

      // Add edges for blocks (if not already covered by depends_on)
      for (const blockedNum of blocks) {
        const blockedStep = stepMap.get(blockedNum);
        if (blockedStep) {
          const exists = edges.some(
            e => e.from === step.id && e.to === blockedStep.id
          );
          if (!exists) {
            edges.push({
              from: step.id,
              to: blockedStep.id,
              type: 'blocks',
            });
          }
        }
      }
    }

    // Calculate execution order (topological sort)
    const executionOrder = this.topologicalSort(steps, edges);

    // Find critical path
    const criticalPath = this.findCriticalPath(steps, edges);

    // Find parallel groups
    const parallelGroups = this.findParallelGroups(steps, edges);

    return {
      nodes,
      edges,
      critical_path: criticalPath,
      parallel_groups: parallelGroups,
      execution_order: executionOrder,
    };
  }

  /**
   * Topological sort of steps based on dependencies
   */
  private topologicalSort(steps: EnhancedPlanStep[], edges: DependencyEdge[]): number[] {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    // Initialize
    for (const step of steps) {
      inDegree.set(step.id, 0);
      adjacency.set(step.id, []);
    }

    // Build adjacency and in-degree
    for (const edge of edges) {
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
      adjacency.get(edge.from)?.push(edge.to);
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const result: number[] = [];
    const stepMap = new Map(steps.map(s => [s.id, s.step_number]));

    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(stepMap.get(current)!);

      for (const neighbor of adjacency.get(current) || []) {
        inDegree.set(neighbor, (inDegree.get(neighbor) || 0) - 1);
        if (inDegree.get(neighbor) === 0) {
          queue.push(neighbor);
        }
      }
    }

    return result;
  }

  /**
   * Find the critical path (longest dependency chain)
   */
  private findCriticalPath(steps: EnhancedPlanStep[], edges: DependencyEdge[]): number[] {
    // Safely handle undefined/null arrays
    const safeSteps = Array.isArray(steps) ? steps : [];
    const safeEdges = Array.isArray(edges) ? edges : [];

    if (safeSteps.length === 0) return [];

    const stepMap = new Map(safeSteps.map(s => [s.id, s]));
    const distances = new Map<string, number>();
    const predecessors = new Map<string, string | null>();

    // Initialize distances
    for (const step of safeSteps) {
      // Safely check depends_on array
      const dependsOn = Array.isArray(step.depends_on) ? step.depends_on : [];
      distances.set(step.id, dependsOn.length === 0 ? 0 : -Infinity);
      predecessors.set(step.id, null);
    }

    // Topological order
    const order = this.topologicalSort(safeSteps, safeEdges);
    const idOrder = order.map(n => {
      const found = safeSteps.find(s => s.step_number === n);
      return found?.id || `step_${n}`;
    });

    // Relax edges in topological order
    for (const id of idOrder) {
      const step = stepMap.get(id);
      if (!step) continue;
      for (const edge of safeEdges) {
        if (edge.from === id) {
          const newDist = (distances.get(id) || 0) + 1;
          if (newDist > (distances.get(edge.to) || -Infinity)) {
            distances.set(edge.to, newDist);
            predecessors.set(edge.to, id);
          }
        }
      }
    }

    // Find the endpoint with maximum distance
    let maxDist = -1;
    let endId = '';
    for (const [id, dist] of distances) {
      if (dist > maxDist) {
        maxDist = dist;
        endId = id;
      }
    }

    // Reconstruct path
    const path: number[] = [];
    let current: string | null = endId;
    while (current) {
      const step = stepMap.get(current);
      if (step) {
        path.unshift(step.step_number);
      }
      current = predecessors.get(current) || null;
    }

    return path;
  }

  /**
   * Find groups of steps that can run in parallel
   */
  private findParallelGroups(steps: EnhancedPlanStep[], edges: DependencyEdge[]): number[][] {
    // Safely handle undefined/null arrays
    const safeSteps = Array.isArray(steps) ? steps : [];
    const safeEdges = Array.isArray(edges) ? edges : [];

    if (safeSteps.length === 0) return [];

    const groups: number[][] = [];
    const assigned = new Set<number>();

    // Group by dependency level
    const levels = new Map<string, number>();
    const stepMap = new Map(safeSteps.map(s => [s.id, s]));

    for (const step of safeSteps) {
      // Safely check depends_on array
      const dependsOn = Array.isArray(step.depends_on) ? step.depends_on : [];
      if (dependsOn.length === 0) {
        levels.set(step.id, 0);
      }
    }

    // Calculate levels
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of safeEdges) {
        const fromLevel = levels.get(edge.from);
        if (fromLevel !== undefined) {
          const currentLevel = levels.get(edge.to);
          const newLevel = fromLevel + 1;
          if (currentLevel === undefined || newLevel > currentLevel) {
            levels.set(edge.to, newLevel);
            changed = true;
          }
        }
      }
    }

    // Group by level
    const levelGroups = new Map<number, number[]>();
    for (const [id, level] of levels) {
      const step = stepMap.get(id);
      if (!step) continue;
      const stepNum = step.step_number;
      if (!levelGroups.has(level)) {
        levelGroups.set(level, []);
      }
      levelGroups.get(level)!.push(stepNum);
    }

    // Convert to array of arrays
    const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b);
    for (const level of sortedLevels) {
      const group = levelGroups.get(level)!;
      if (group.length > 1) {
        groups.push(group);
      }
    }

    return groups;
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Create a summary of a plan
   */
  getPlanSummary(plan: EnhancedPlanOutput): PlanSummary {
    const filesAffected = new Set<string>();

    // Safely handle potentially undefined arrays
    const steps = plan.steps || [];
    const questions = plan.questions_for_clarification || [];

    for (const step of steps) {
      // Safely iterate file arrays
      const filesToModify = step.files_to_modify || [];
      const filesToCreate = step.files_to_create || [];
      const filesToDelete = step.files_to_delete || [];

      for (const file of filesToModify) {
        if (file?.path) filesAffected.add(file.path);
      }
      for (const file of filesToCreate) {
        if (file?.path) filesAffected.add(file.path);
      }
      for (const file of filesToDelete) {
        if (file) filesAffected.add(file);
      }
    }

    // Safely handle potentially undefined goal
    const goal = plan.goal || '';
    const goalSummary = goal.length > 100 ? goal.substring(0, 97) + '...' : goal;

    return {
      id: plan.id || '',
      goal: goalSummary,
      status: questions.length > 0 ? 'needs_clarification' : 'ready',
      step_count: steps.length,
      files_affected: filesAffected.size,
      total_estimated_effort: this.sumEstimatedEffort(steps),
      confidence_score: plan.confidence_score || 0,
      created_at: plan.created_at || new Date().toISOString(),
    };
  }

  /**
   * Sum up estimated effort from all steps
   */
  private sumEstimatedEffort(steps: EnhancedPlanStep[]): string {
    // Simple approach: count number of steps and estimate
    if (steps.length === 0) return '0 hours';
    if (steps.length <= 3) return '2-4 hours';
    if (steps.length <= 6) return '4-8 hours';
    if (steps.length <= 10) return '1-2 days';
    return '2+ days';
  }

  /**
   * Generate a Mermaid diagram for the dependency graph
   */
  generateDependencyDiagram(plan: EnhancedPlanOutput): string {
    let mermaid = 'graph TD\n';

    // Safely handle undefined steps and dependency_graph
    const steps = plan.steps || [];
    const dependencyGraph = plan.dependency_graph || { nodes: [], edges: [], critical_path: [], parallel_groups: [], execution_order: [] };
    const edges = dependencyGraph.edges || [];
    const criticalPath = dependencyGraph.critical_path || [];

    // Add nodes
    for (const step of steps) {
      // Safely handle potentially undefined title
      const title = step.title || `Step ${step.step_number || 'unknown'}`;
      const label = title.length > 30 ? title.substring(0, 27) + '...' : title;
      const style = step.priority === 'critical' ? ':::critical' : '';
      const stepId = step.id || `step_${step.step_number || Date.now()}`;
      mermaid += `    ${stepId}["${step.step_number || '?'}. ${label}"]${style}\n`;
    }

    // Add edges
    for (const edge of edges) {
      if (edge.from && edge.to) {
        mermaid += `    ${edge.from} --> ${edge.to}\n`;
      }
    }

    // Add styling for critical path
    if (criticalPath.length > 0) {
      mermaid += '\n    classDef critical fill:#ff6b6b,stroke:#c0392b\n';
    }

    return mermaid;
  }
}
