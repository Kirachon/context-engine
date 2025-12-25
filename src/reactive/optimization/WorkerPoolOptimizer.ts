/**
 * Worker Pool Optimizer (Phase 4)
 * 
 * Optimizes parallel execution by:
 * - Matching worker count to CPU cores
 * - Intelligent task partitioning
 * - Load balancing across workers
 * - Worker utilization tracking
 */

import os from 'os';

/**
 * Worker pool configuration
 */
export interface WorkerPoolConfig {
    /** Whether to optimize worker count based on CPU cores */
    optimize_workers: boolean;
    /** Override for max workers (0 = auto-detect) */
    max_workers_override: number;
    /** Enable load balancing */
    enable_load_balancing: boolean;
    /** Enable task partitioning for large files */
    enable_task_partitioning: boolean;
}

/**
 * Worker utilization metrics
 */
export interface WorkerUtilization {
    /** Number of available CPU cores */
    cpu_cores: number;
    /** Current active workers */
    active_workers: number;
    /** Optimal worker count */
    optimal_workers: number;
    /** Worker utilization percentage (0-1) */
    utilization: number;
    /** Tasks per worker (for load balancing) */
    tasks_per_worker: Map<number, number>;
}

/**
 * Task priority for load balancing
 */
export interface TaskPriority {
    task_id: string;
    priority: number;
    estimated_duration_ms: number;
    worker_id?: number;
}

/**
 * Worker Pool Optimizer
 * 
 * Provides intelligent worker allocation and load balancing
 */
export class WorkerPoolOptimizer {
    private config: WorkerPoolConfig;
    private cpuCores: number;
    private optimalWorkers: number;
    private workerLoads: Map<number, number>;

    constructor(config: Partial<WorkerPoolConfig> = {}) {
        this.config = {
            optimize_workers: config.optimize_workers ?? false,
            max_workers_override: config.max_workers_override ?? 0,
            enable_load_balancing: config.enable_load_balancing ?? true,
            enable_task_partitioning: config.enable_task_partitioning ?? false,
        };

        this.cpuCores = os.cpus().length;
        this.optimalWorkers = this.calculateOptimalWorkers();
        this.workerLoads = new Map();

        console.error(`[WorkerPoolOptimizer] CPU cores detected: ${this.cpuCores}`);
        console.error(`[WorkerPoolOptimizer] Optimal workers: ${this.optimalWorkers}`);
    }

    /**
     * Calculate optimal worker count based on CPU cores
     * 
     * Strategy:
     * - For I/O-bound tasks: CPU cores + 1 (to overlap I/O wait)
     * - Cap at reasonable maximum to avoid overhead
     * 
     * @returns Optimal number of workers
     */
    private calculateOptimalWorkers(): number {
        // If optimization disabled, use override or default
        if (!this.config.optimize_workers) {
            return this.config.max_workers_override || 3;
        }

        // If override specified, respect it
        if (this.config.max_workers_override > 0) {
            return Math.min(this.config.max_workers_override, this.cpuCores * 2);
        }

        // For AI code review (I/O + CPU):
        // Use CPU cores + 1 to overlap I/O operations
        // But cap at 2x CPU cores to avoid excessive context switching
        const optimal = this.cpuCores + 1;
        const maxReasonable = this.cpuCores * 2;

        return Math.min(optimal, maxReasonable);
    }

    /**
     * Get optimal worker count
     */
    getOptimalWorkers(): number {
        return this.optimalWorkers;
    }

    /**
     * Get CPU core count
     */
    getCPUCores(): number {
        return this.cpuCores;
    }

    /**
     * Assign task to least loaded worker
     * 
     * @param taskId Task identifier
     * @param estimatedDuration Estimated task duration (ms)
     * @returns Worker ID to assign to
     */
    assignTask(taskId: string, estimatedDuration: number = 10000): number {
        if (!this.config.enable_load_balancing) {
            // Round-robin assignment
            return Math.floor(Math.random() * this.optimalWorkers);
        }

        // Find worker with minimum load
        let minLoad = Infinity;
        let selectedWorker = 0;

        for (let i = 0; i < this.optimalWorkers; i++) {
            const load = this.workerLoads.get(i) || 0;
            if (load < minLoad) {
                minLoad = load;
                selectedWorker = i;
            }
        }

        // Update worker load
        const currentLoad = this.workerLoads.get(selectedWorker) || 0;
        this.workerLoads.set(selectedWorker, currentLoad + estimatedDuration);

        console.error(`[WorkerPoolOptimizer] Assigned task ${taskId} to worker ${selectedWorker} (load: ${currentLoad}ms)`);

        return selectedWorker;
    }

    /**
     * Mark task as complete and update worker load
     * 
     * @param workerId Worker ID
     * @param actualDuration Actual task duration (ms)
     */
    taskComplete(workerId: number, actualDuration: number): void {
        const currentLoad = this.workerLoads.get(workerId) || 0;
        const newLoad = Math.max(0, currentLoad - actualDuration);
        this.workerLoads.set(workerId, newLoad);

        console.error(`[WorkerPoolOptimizer] Task complete on worker ${workerId}, new load: ${newLoad}ms`);
    }

    /**
     * Partition large task into smaller subtasks
     * 
     * @param taskSize Size estimate (e.g., lines of code)
     * @param maxSubtaskSize Maximum size per subtask
     * @returns Number of subtasks
     */
    partitionTask(taskSize: number, maxSubtaskSize: number = 1000): number {
        if (!this.config.enable_task_partitioning) {
            return 1;
        }

        const subtasks = Math.ceil(taskSize / maxSubtaskSize);
        console.error(`[WorkerPoolOptimizer] Partitioned task (size ${taskSize}) into ${subtasks} subtasks`);

        return Math.min(subtasks, this.optimalWorkers);
    }

    /**
     * Get current worker utilization metrics
     */
    getUtilization(): WorkerUtilization {
        const totalLoad = Array.from(this.workerLoads.values()).reduce((sum, load) => sum + load, 0);
        const avgLoad = totalLoad / this.optimalWorkers;
        const maxPossibleLoad = this.optimalWorkers * 60000; // Assume 1 min max per worker

        return {
            cpu_cores: this.cpuCores,
            active_workers: this.workerLoads.size,
            optimal_workers: this.optimalWorkers,
            utilization: Math.min(totalLoad / maxPossibleLoad, 1),
            tasks_per_worker: new Map(this.workerLoads),
        };
    }

    /**
     * Reset all worker loads
     */
    reset(): void {
        this.workerLoads.clear();
        console.error('[WorkerPoolOptimizer] Worker loads reset');
    }

    /**
     * Get recommended max_workers for configuration
     * 
     * @param baseConfig Base max_workers value
     * @returns Optimized max_workers
     */
    static getRecommendedMaxWorkers(baseConfig: number): number {
        const cpuCores = os.cpus().length;

        // If optimize is enabled, use CPU-aware calculation
        // Otherwise use the provided config
        const optimal = cpuCores + 1;
        const maxReasonable = cpuCores * 2;

        // Return minimum of: base config, optimal, and max reasonable
        return Math.min(baseConfig, optimal, maxReasonable);
    }
}

/**
 * Create a worker pool optimizer from reactive config
 * 
 * @param reactiveConfig Reactive configuration
 * @returns Worker pool optimizer instance
 */
export function createWorkerPoolOptimizer(reactiveConfig: {
    optimize_workers?: boolean;
    max_workers?: number;
}): WorkerPoolOptimizer {
    return new WorkerPoolOptimizer({
        optimize_workers: reactiveConfig.optimize_workers ?? false,
        max_workers_override: reactiveConfig.max_workers ?? 0,
        enable_load_balancing: true,
        enable_task_partitioning: false, // Can be enabled in future
    });
}
