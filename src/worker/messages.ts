export type WorkerFailureKind = 'job_error' | 'runtime_error' | 'abnormal_exit';

export type WorkerMessage =
  | { type: 'index_start'; files: string[] }
  | { type: 'index_progress'; current: number; total: number }
  | {
      type: 'index_complete';
      duration: number;
      count: number;
      skipped?: number;
      errors?: string[];
      totalIndexable?: number;
      unchangedSkipped?: number;
    }
  | {
      type: 'index_error';
      error: string;
      failureKind?: WorkerFailureKind;
      exitCode?: number;
    };

export interface WorkerPayload {
  workspacePath: string;
  files?: string[];
  mock?: boolean; // used only in tests
}
