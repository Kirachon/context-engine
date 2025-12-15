/**
 * Plan Persistence Service
 *
 * Handles saving, loading, listing, and deleting plans from disk storage.
 * Plans are stored as JSON files in a configurable directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  EnhancedPlanOutput,
  PersistedPlanMetadata,
  SavePlanOptions,
  ListPlansOptions,
  PersistenceResult,
  PlanStatus,
} from '../types/planning.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PLANS_DIR = '.augment-plans';
const PLAN_FILE_EXTENSION = '.plan.json';
const INDEX_FILE = 'plans-index.json';

// ============================================================================
// Index Types
// ============================================================================

interface PlansIndex {
  version: number;
  plans: PersistedPlanMetadata[];
  last_updated: string;
}

// ============================================================================
// PlanPersistenceService
// ============================================================================

export class PlanPersistenceService {
  private plansDir: string;
  private indexPath: string;
  private cachedIndex: PlansIndex | null = null;

  constructor(workspaceRoot: string, plansDir?: string) {
    this.plansDir = path.join(workspaceRoot, plansDir || DEFAULT_PLANS_DIR);
    this.indexPath = path.join(this.plansDir, INDEX_FILE);
  }

  // ============================================================================
  // Directory Management
  // ============================================================================

  /**
   * Ensure the plans directory exists
   */
  private async ensureDirectory(): Promise<void> {
    if (!fs.existsSync(this.plansDir)) {
      fs.mkdirSync(this.plansDir, { recursive: true });
    }
  }

  /**
   * Get the file path for a plan
   */
  private getPlanFilePath(planId: string): string {
    // Sanitize plan ID for use as filename
    const safeId = planId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.plansDir, `${safeId}${PLAN_FILE_EXTENSION}`);
  }

  // ============================================================================
  // Index Management
  // ============================================================================

  /**
   * Load the plans index
   */
  private async loadIndex(): Promise<PlansIndex> {
    if (this.cachedIndex) {
      return this.cachedIndex;
    }

    try {
      if (fs.existsSync(this.indexPath)) {
        const content = fs.readFileSync(this.indexPath, 'utf-8');
        this.cachedIndex = JSON.parse(content) as PlansIndex;
        return this.cachedIndex;
      }
    } catch {
      // Index corrupted, create new one
    }

    // Create empty index
    this.cachedIndex = {
      version: 1,
      plans: [],
      last_updated: new Date().toISOString(),
    };
    return this.cachedIndex;
  }

  /**
   * Save the plans index
   */
  private async saveIndex(index: PlansIndex): Promise<void> {
    await this.ensureDirectory();
    index.last_updated = new Date().toISOString();
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
    this.cachedIndex = index;
  }

  /**
   * Clear the cached index
   */
  public clearCache(): void {
    this.cachedIndex = null;
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  /**
   * Save a plan to disk
   */
  async savePlan(
    plan: EnhancedPlanOutput,
    options: SavePlanOptions = {}
  ): Promise<PersistenceResult> {
    try {
      await this.ensureDirectory();
      const index = await this.loadIndex();

      // Check if plan already exists
      const existingIdx = index.plans.findIndex(p => p.id === plan.id);
      if (existingIdx >= 0 && !options.overwrite) {
        return {
          success: false,
          error: `Plan with ID ${plan.id} already exists. Use overwrite: true to replace.`,
          plan_id: plan.id,
        };
      }

      // Generate plan name from goal if not provided
      const name = options.name || this.generatePlanName(plan.goal);

      // Calculate files affected
      const filesAffected = this.countFilesAffected(plan);

      // Create metadata
      const metadata: PersistedPlanMetadata = {
        id: plan.id,
        name,
        goal: plan.goal,
        status: 'ready' as PlanStatus,
        version: plan.version,
        file_path: this.getPlanFilePath(plan.id),
        created_at: existingIdx >= 0 ? index.plans[existingIdx].created_at : new Date().toISOString(),
        updated_at: new Date().toISOString(),
        step_count: plan.steps.length,
        tags: options.tags,
      };

      // Save plan file
      fs.writeFileSync(metadata.file_path, JSON.stringify(plan, null, 2));

      // Update index
      if (existingIdx >= 0) {
        index.plans[existingIdx] = metadata;
      } else {
        index.plans.push(metadata);
      }
      await this.saveIndex(index);

      return {
        success: true,
        plan_id: plan.id,
        file_path: metadata.file_path,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        plan_id: plan.id,
      };
    }
  }

  /**
   * Load a plan from disk
   */
  async loadPlan(planId: string): Promise<EnhancedPlanOutput | null> {
    try {
      const index = await this.loadIndex();
      const metadata = index.plans.find(p => p.id === planId);

      if (!metadata) {
        return null;
      }

      if (!fs.existsSync(metadata.file_path)) {
        return null;
      }

      const content = fs.readFileSync(metadata.file_path, 'utf-8');
      return JSON.parse(content) as EnhancedPlanOutput;
    } catch {
      return null;
    }
  }

  /**
   * Load a plan by name
   */
  async loadPlanByName(name: string): Promise<EnhancedPlanOutput | null> {
    const index = await this.loadIndex();
    const metadata = index.plans.find(
      p => p.name.toLowerCase() === name.toLowerCase()
    );

    if (!metadata) {
      return null;
    }

    return this.loadPlan(metadata.id);
  }

  /**
   * Delete a plan from disk
   */
  async deletePlan(planId: string): Promise<PersistenceResult> {
    try {
      const index = await this.loadIndex();
      const existingIdx = index.plans.findIndex(p => p.id === planId);

      if (existingIdx < 0) {
        return {
          success: false,
          error: `Plan with ID ${planId} not found`,
          plan_id: planId,
        };
      }

      const metadata = index.plans[existingIdx];

      // Delete plan file
      if (fs.existsSync(metadata.file_path)) {
        fs.unlinkSync(metadata.file_path);
      }

      // Update index
      index.plans.splice(existingIdx, 1);
      await this.saveIndex(index);

      return {
        success: true,
        plan_id: planId,
        file_path: metadata.file_path,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        plan_id: planId,
      };
    }
  }

  /**
   * List all saved plans
   */
  async listPlans(options: ListPlansOptions = {}): Promise<PersistedPlanMetadata[]> {
    const index = await this.loadIndex();
    let plans = [...index.plans];

    // Filter by status
    if (options.status) {
      plans = plans.filter(p => p.status === options.status);
    }

    // Filter by tags
    if (options.tags && options.tags.length > 0) {
      plans = plans.filter(p =>
        p.tags?.some(tag => options.tags!.includes(tag))
      );
    }

    // Sort
    const sortField = options.sort_by || 'updated_at';
    const sortOrder = options.sort_order || 'desc';

    plans.sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;

      switch (sortField) {
        case 'name':
          aVal = a.name.toLowerCase();
          bVal = b.name.toLowerCase();
          break;
        case 'created_at':
          aVal = a.created_at;
          bVal = b.created_at;
          break;
        case 'updated_at':
        default:
          aVal = a.updated_at;
          bVal = b.updated_at;
          break;
      }

      if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    // Limit
    if (options.limit && options.limit > 0) {
      plans = plans.slice(0, options.limit);
    }

    return plans;
  }

  /**
   * Get metadata for a specific plan
   */
  async getPlanMetadata(planId: string): Promise<PersistedPlanMetadata | null> {
    const index = await this.loadIndex();
    return index.plans.find(p => p.id === planId) || null;
  }

  /**
   * Update plan status
   */
  async updatePlanStatus(planId: string, status: PlanStatus): Promise<PersistenceResult> {
    try {
      const index = await this.loadIndex();
      const existingIdx = index.plans.findIndex(p => p.id === planId);

      if (existingIdx < 0) {
        return {
          success: false,
          error: `Plan with ID ${planId} not found`,
          plan_id: planId,
        };
      }

      index.plans[existingIdx].status = status;
      index.plans[existingIdx].updated_at = new Date().toISOString();
      await this.saveIndex(index);

      return {
        success: true,
        plan_id: planId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        plan_id: planId,
      };
    }
  }

  /**
   * Check if a plan exists
   */
  async planExists(planId: string): Promise<boolean> {
    const index = await this.loadIndex();
    return index.plans.some(p => p.id === planId);
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Generate a plan name from the goal
   */
  private generatePlanName(goal: string): string {
    // Take first 50 chars, remove special chars, title case
    const cleaned = goal
      .substring(0, 50)
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .trim();

    // Title case
    return cleaned
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Count total files affected by a plan
   */
  private countFilesAffected(plan: EnhancedPlanOutput): number {
    const files = new Set<string>();

    for (const step of plan.steps) {
      for (const file of step.files_to_modify) {
        files.add(file.path);
      }
      for (const file of step.files_to_create) {
        files.add(file.path);
      }
      for (const file of step.files_to_delete) {
        files.add(file);
      }
    }

    return files.size;
  }

  /**
   * Get the plans directory path
   */
  getPlansDirectory(): string {
    return this.plansDir;
  }
}
