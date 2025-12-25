/**
 * Plan History Service
 *
 * Tracks version history for plans, generates diffs between versions,
 * and supports rollback to previous versions.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  EnhancedPlanOutput,
  PlanVersion,
  PlanHistory,
  PlanDiff,
  FieldChange,
  HistoryOptions,
  RollbackOptions,
  RollbackResult,
} from '../types/planning.js';

// ============================================================================
// Constants
// ============================================================================

const HISTORY_FILE_SUFFIX = '.history.json';

// ============================================================================
// Memory Management Constants
// ============================================================================

/** Maximum number of histories to keep in memory */
const MAX_HISTORIES_IN_MEMORY = 50;

/** Maximum number of versions to keep per history */
const MAX_VERSIONS_PER_HISTORY = 20;

// ============================================================================
// PlanHistoryService
// ============================================================================

export class PlanHistoryService {
  private histories: Map<string, PlanHistory> = new Map();
  private historyDir: string;

  /** Track last access time for LRU eviction */
  private lastAccessTime: Map<string, number> = new Map();

  constructor(workspaceRoot: string, historyDir?: string) {
    this.historyDir = path.join(workspaceRoot, historyDir || '.augment-plans', 'history');
  }

  // ============================================================================
  // Memory Management
  // ============================================================================

  /**
   * Evict least recently used histories if over the limit.
   */
  private evictIfNeeded(): void {
    if (this.histories.size <= MAX_HISTORIES_IN_MEMORY) {
      return;
    }

    // Sort by last access time (oldest first)
    const entries = Array.from(this.lastAccessTime.entries())
      .sort((a, b) => a[1] - b[1]);

    const toEvict = this.histories.size - MAX_HISTORIES_IN_MEMORY;
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      const planId = entries[i][0];
      this.histories.delete(planId);
      this.lastAccessTime.delete(planId);
    }

    if (toEvict > 0) {
      console.error(`[PlanHistoryService] Evicted ${toEvict} histories, ${this.histories.size} remaining`);
    }
  }

  /**
   * Prune old versions from a history to stay within limits.
   */
  private pruneVersions(history: PlanHistory): void {
    if (history.versions.length <= MAX_VERSIONS_PER_HISTORY) {
      return;
    }

    // Keep the most recent versions
    const toRemove = history.versions.length - MAX_VERSIONS_PER_HISTORY;
    history.versions = history.versions.slice(toRemove);

    console.error(`[PlanHistoryService] Pruned ${toRemove} old versions from history ${history.plan_id}`);
  }

  /**
   * Update last access time for a history.
   */
  private touchHistory(planId: string): void {
    this.lastAccessTime.set(planId, Date.now());
  }

  /**
   * Get the current memory usage stats.
   */
  getMemoryStats(): { historiesInMemory: number; maxHistories: number; maxVersionsPerHistory: number } {
    return {
      historiesInMemory: this.histories.size,
      maxHistories: MAX_HISTORIES_IN_MEMORY,
      maxVersionsPerHistory: MAX_VERSIONS_PER_HISTORY,
    };
  }

  /**
   * Clear all in-memory histories (for testing or memory pressure).
   */
  clearMemoryCache(): void {
    this.histories.clear();
    this.lastAccessTime.clear();
    console.error('[PlanHistoryService] Cleared in-memory history cache');
  }

  // ============================================================================
  // Directory Management
  // ============================================================================

  private ensureDirectory(): void {
    if (!fs.existsSync(this.historyDir)) {
      fs.mkdirSync(this.historyDir, { recursive: true });
    }
  }

  private getHistoryFilePath(planId: string | undefined | null): string {
    // Handle undefined/null planId
    if (!planId || typeof planId !== 'string') {
      const fallbackId = `history_${Date.now()}`;
      return path.join(this.historyDir, `${fallbackId}${HISTORY_FILE_SUFFIX}`);
    }
    const safeId = planId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.historyDir, `${safeId}${HISTORY_FILE_SUFFIX}`);
  }

  // ============================================================================
  // History Management
  // ============================================================================

  /**
   * Record a new version of a plan
   */
  recordVersion(
    plan: EnhancedPlanOutput,
    changeType: PlanVersion['change_type'],
    changeSummary: string,
    changedBy?: string
  ): PlanVersion {
    let history = this.histories.get(plan.id);

    if (!history) {
      history = {
        plan_id: plan.id,
        current_version: 0,
        versions: [],
        created_at: new Date().toISOString(),
        last_modified_at: new Date().toISOString(),
      };
      this.histories.set(plan.id, history);
      // Touch the history first so it has an access time for LRU eviction
      this.touchHistory(plan.id);
      // Check if we need to evict old histories
      this.evictIfNeeded();
    }

    const version: PlanVersion = {
      version: plan.version,
      created_at: new Date().toISOString(),
      change_summary: changeSummary,
      change_type: changeType,
      changed_by: changedBy,
      plan: JSON.parse(JSON.stringify(plan)), // Deep copy
    };

    history.versions.push(version);
    history.current_version = plan.version;
    history.last_modified_at = new Date().toISOString();

    // Prune old versions if over limit
    this.pruneVersions(history);

    // Update access time
    this.touchHistory(plan.id);

    // Persist to disk
    this.saveHistory(history);

    return version;
  }

  /**
   * Get history for a plan
   */
  getHistory(planId: string, options: HistoryOptions = {}): PlanHistory | null {
    // Try to load from cache first
    let history: PlanHistory | null | undefined = this.histories.get(planId);

    // Try to load from disk
    if (!history) {
      history = this.loadHistory(planId);
      if (history) {
        this.histories.set(planId, history);
        // Touch the history first so it has an access time for LRU eviction
        this.touchHistory(planId);
        // Check if we need to evict old histories
        this.evictIfNeeded();
      }
    }

    if (!history) return null;

    // Update access time (for already-cached histories)
    this.touchHistory(planId);

    // Apply filters
    let versions = [...history.versions];

    if (options.since) {
      versions = versions.filter(v => v.created_at >= options.since!);
    }

    if (options.until) {
      versions = versions.filter(v => v.created_at <= options.until!);
    }

    if (options.limit) {
      versions = versions.slice(-options.limit);
    }

    // Strip plan content if not requested
    if (!options.include_plans) {
      versions = versions.map(v => ({
        ...v,
        plan: undefined as unknown as EnhancedPlanOutput,
      }));
    }

    return {
      ...history,
      versions,
    };
  }

  /**
   * Get a specific version of a plan
   */
  getVersion(planId: string, version: number): PlanVersion | null {
    const history = this.getHistory(planId, { include_plans: true });
    if (!history) return null;
    return history.versions.find(v => v.version === version) || null;
  }

  /**
   * Get the current version number
   */
  getCurrentVersion(planId: string): number {
    const history = this.histories.get(planId) || this.loadHistory(planId);
    return history?.current_version || 0;
  }

  // ============================================================================
  // Diff Generation
  // ============================================================================

  /**
   * Generate a diff between two versions
   */
  generateDiff(planId: string, fromVersion: number, toVersion: number): PlanDiff | null {
    const fromVer = this.getVersion(planId, fromVersion);
    const toVer = this.getVersion(planId, toVersion);

    if (!fromVer || !toVer) return null;

    const fromPlan = fromVer.plan;
    const toPlan = toVer.plan;

    // Safely handle undefined steps arrays - ensure they are arrays before processing
    const fromPlanSteps = Array.isArray(fromPlan.steps) ? fromPlan.steps : [];
    const toPlanSteps = Array.isArray(toPlan.steps) ? toPlan.steps : [];

    // Calculate step changes
    const fromSteps = new Set(fromPlanSteps.map(s => s.step_number));
    const toSteps = new Set(toPlanSteps.map(s => s.step_number));

    const stepsAdded = [...toSteps].filter(s => !fromSteps.has(s));
    const stepsRemoved = [...fromSteps].filter(s => !toSteps.has(s));
    const stepsModified = [...toSteps].filter(s => {
      if (!fromSteps.has(s)) return false;
      const fromStep = fromPlanSteps.find(st => st.step_number === s);
      const toStep = toPlanSteps.find(st => st.step_number === s);
      return JSON.stringify(fromStep) !== JSON.stringify(toStep);
    });

    // Calculate file changes
    const fromFiles = this.collectAllFiles(fromPlan);
    const toFiles = this.collectAllFiles(toPlan);
    const filesAdded = toFiles.filter(f => !fromFiles.includes(f));
    const filesRemoved = fromFiles.filter(f => !toFiles.includes(f));

    // Safely handle undefined scope arrays
    const fromScope = fromPlan.scope || { included: [], excluded: [] };
    const toScope = toPlan.scope || { included: [], excluded: [] };
    const fromIncluded = Array.isArray(fromScope.included) ? fromScope.included : [];
    const toIncluded = Array.isArray(toScope.included) ? toScope.included : [];
    const fromExcluded = Array.isArray(fromScope.excluded) ? fromScope.excluded : [];
    const toExcluded = Array.isArray(toScope.excluded) ? toScope.excluded : [];

    // Calculate scope changes
    const scopeChanges = {
      included_added: toIncluded.filter(i => !fromIncluded.includes(i)),
      included_removed: fromIncluded.filter(i => !toIncluded.includes(i)),
      excluded_added: toExcluded.filter(e => !fromExcluded.includes(e)),
      excluded_removed: fromExcluded.filter(e => !toExcluded.includes(e)),
    };

    // Safely handle undefined risks arrays
    const fromRisksArray = Array.isArray(fromPlan.risks) ? fromPlan.risks : [];
    const toRisksArray = Array.isArray(toPlan.risks) ? toPlan.risks : [];

    // Calculate risk changes
    const fromRisks = fromRisksArray.map(r => r?.issue || 'Unknown');
    const toRisks = toRisksArray.map(r => r?.issue || 'Unknown');
    const risksAdded = toRisks.filter(r => !fromRisks.includes(r));
    const risksRemoved = fromRisks.filter(r => !toRisks.includes(r));

    // Generate field changes
    const fieldChanges = this.generateFieldChanges(fromPlan, toPlan);

    // Generate summary
    const summary = this.generateDiffSummary(
      stepsAdded.length, stepsRemoved.length, stepsModified.length,
      filesAdded.length, filesRemoved.length
    );

    return {
      from_version: fromVersion,
      to_version: toVersion,
      summary,
      steps_added: stepsAdded,
      steps_removed: stepsRemoved,
      steps_modified: stepsModified,
      files_added: filesAdded,
      files_removed: filesRemoved,
      scope_changes: scopeChanges,
      risks_added: risksAdded,
      risks_removed: risksRemoved,
      field_changes: fieldChanges,
    };
  }

  // ============================================================================
  // Rollback
  // ============================================================================

  /**
   * Rollback to a previous version
   */
  rollback(planId: string, options: RollbackOptions): RollbackResult {
    const targetVersion = this.getVersion(planId, options.target_version);
    if (!targetVersion) {
      return {
        success: false,
        error: `Version ${options.target_version} not found for plan ${planId}`,
      };
    }

    const history = this.histories.get(planId);
    if (!history) {
      return {
        success: false,
        error: `No history found for plan ${planId}`,
      };
    }

    // Create rolled-back plan with new version number
    const rolledBackPlan: EnhancedPlanOutput = {
      ...JSON.parse(JSON.stringify(targetVersion.plan)),
      version: history.current_version + 1,
      updated_at: new Date().toISOString(),
    };

    // Record the rollback as a new version
    this.recordVersion(
      rolledBackPlan,
      'rolled_back',
      `Rolled back to version ${options.target_version}${options.reason ? `: ${options.reason}` : ''}`,
    );

    return {
      success: true,
      plan: rolledBackPlan,
      new_version: rolledBackPlan.version,
    };
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  private saveHistory(history: PlanHistory): void {
    this.ensureDirectory();
    const filePath = this.getHistoryFilePath(history.plan_id);
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
  }

  private loadHistory(planId: string): PlanHistory | null {
    const filePath = this.getHistoryFilePath(planId);
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as PlanHistory;
    } catch {
      return null;
    }
  }

  /**
   * Delete history for a plan
   */
  deleteHistory(planId: string): boolean {
    this.histories.delete(planId);
    const filePath = this.getHistoryFilePath(planId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private collectAllFiles(plan: EnhancedPlanOutput): string[] {
    const files = new Set<string>();

    // Safely handle undefined steps array
    const steps = plan.steps || [];

    for (const step of steps) {
      // Safely handle undefined file arrays - ensure they are arrays before iteration
      const filesToModify = Array.isArray(step.files_to_modify) ? step.files_to_modify : [];
      const filesToCreate = Array.isArray(step.files_to_create) ? step.files_to_create : [];
      const filesToDelete = Array.isArray(step.files_to_delete) ? step.files_to_delete : [];

      for (const f of filesToModify) {
        if (f?.path) files.add(f.path);
      }
      for (const f of filesToCreate) {
        if (f?.path) files.add(f.path);
      }
      for (const f of filesToDelete) {
        if (f) files.add(f);
      }
    }
    return Array.from(files).sort();
  }

  private generateFieldChanges(from: EnhancedPlanOutput, to: EnhancedPlanOutput): FieldChange[] {
    const changes: FieldChange[] = [];

    // Check top-level fields
    const fromGoal = from.goal || '';
    const toGoal = to.goal || '';
    if (fromGoal !== toGoal) {
      changes.push({ path: 'goal', type: 'modified', old_value: fromGoal, new_value: toGoal });
    }

    const fromConfidence = from.confidence_score ?? 0;
    const toConfidence = to.confidence_score ?? 0;
    if (fromConfidence !== toConfidence) {
      changes.push({
        path: 'confidence_score',
        type: 'modified',
        old_value: fromConfidence,
        new_value: toConfidence
      });
    }

    // Safely handle undefined steps arrays
    const fromSteps = Array.isArray(from.steps) ? from.steps : [];
    const toSteps = Array.isArray(to.steps) ? to.steps : [];
    if (fromSteps.length !== toSteps.length) {
      changes.push({
        path: 'steps.length',
        type: 'modified',
        old_value: fromSteps.length,
        new_value: toSteps.length,
      });
    }

    return changes;
  }

  private generateDiffSummary(
    stepsAdded: number,
    stepsRemoved: number,
    stepsModified: number,
    filesAdded: number,
    filesRemoved: number
  ): string {
    const parts: string[] = [];

    if (stepsAdded > 0) parts.push(`${stepsAdded} step(s) added`);
    if (stepsRemoved > 0) parts.push(`${stepsRemoved} step(s) removed`);
    if (stepsModified > 0) parts.push(`${stepsModified} step(s) modified`);
    if (filesAdded > 0) parts.push(`${filesAdded} file(s) added`);
    if (filesRemoved > 0) parts.push(`${filesRemoved} file(s) removed`);

    return parts.length > 0 ? parts.join(', ') : 'No significant changes';
  }

  /**
   * Clear cached history
   */
  clearCache(): void {
    this.histories.clear();
  }
}
