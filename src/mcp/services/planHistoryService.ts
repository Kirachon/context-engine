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
// PlanHistoryService
// ============================================================================

export class PlanHistoryService {
  private histories: Map<string, PlanHistory> = new Map();
  private historyDir: string;

  constructor(workspaceRoot: string, historyDir?: string) {
    this.historyDir = path.join(workspaceRoot, historyDir || '.augment-plans', 'history');
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
      }
    }

    if (!history) return null;

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

    // Calculate step changes
    const fromSteps = new Set(fromPlan.steps.map(s => s.step_number));
    const toSteps = new Set(toPlan.steps.map(s => s.step_number));

    const stepsAdded = [...toSteps].filter(s => !fromSteps.has(s));
    const stepsRemoved = [...fromSteps].filter(s => !toSteps.has(s));
    const stepsModified = [...toSteps].filter(s => {
      if (!fromSteps.has(s)) return false;
      const fromStep = fromPlan.steps.find(st => st.step_number === s);
      const toStep = toPlan.steps.find(st => st.step_number === s);
      return JSON.stringify(fromStep) !== JSON.stringify(toStep);
    });

    // Calculate file changes
    const fromFiles = this.collectAllFiles(fromPlan);
    const toFiles = this.collectAllFiles(toPlan);
    const filesAdded = toFiles.filter(f => !fromFiles.includes(f));
    const filesRemoved = fromFiles.filter(f => !toFiles.includes(f));

    // Calculate scope changes
    const scopeChanges = {
      included_added: toPlan.scope.included.filter(i => !fromPlan.scope.included.includes(i)),
      included_removed: fromPlan.scope.included.filter(i => !toPlan.scope.included.includes(i)),
      excluded_added: toPlan.scope.excluded.filter(e => !fromPlan.scope.excluded.includes(e)),
      excluded_removed: fromPlan.scope.excluded.filter(e => !toPlan.scope.excluded.includes(e)),
    };

    // Calculate risk changes
    const fromRisks = fromPlan.risks.map(r => r.issue);
    const toRisks = toPlan.risks.map(r => r.issue);
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
    for (const step of plan.steps) {
      for (const f of step.files_to_modify) files.add(f.path);
      for (const f of step.files_to_create) files.add(f.path);
      for (const f of step.files_to_delete) files.add(f);
    }
    return Array.from(files).sort();
  }

  private generateFieldChanges(from: EnhancedPlanOutput, to: EnhancedPlanOutput): FieldChange[] {
    const changes: FieldChange[] = [];

    // Check top-level fields
    if (from.goal !== to.goal) {
      changes.push({ path: 'goal', type: 'modified', old_value: from.goal, new_value: to.goal });
    }
    if (from.confidence_score !== to.confidence_score) {
      changes.push({
        path: 'confidence_score',
        type: 'modified',
        old_value: from.confidence_score,
        new_value: to.confidence_score
      });
    }
    if (from.steps.length !== to.steps.length) {
      changes.push({
        path: 'steps.length',
        type: 'modified',
        old_value: from.steps.length,
        new_value: to.steps.length,
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
