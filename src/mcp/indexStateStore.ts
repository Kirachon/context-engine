import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getPreferredWorkspacePath, getReadableWorkspacePath } from '../runtime/compatPaths.js';

const INDEX_STATE_FILE_NAME = '.context-engine-index-state.json';
const LEGACY_INDEX_STATE_FILE_NAME = '.augment-index-state.json';
const DEFAULT_INDEX_STATE_VERSION = 1;
const DEFAULT_SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const DEFAULT_PROVIDER_ID = 'local_native';
const EPOCH_ISO = new Date(0).toISOString();

export interface IndexStateFileEntry {
  hash: string;
  indexed_at: string;
}

export interface IndexStateFile {
  version: number;
  schema_version: number;
  provider_id: string;
  updated_at: string;
  workspace_fingerprint?: string;
  feature_flags_snapshot?: string;
  files: Record<string, IndexStateFileEntry>;
}

export interface IndexStateLoadMetadata {
  warnings: string[];
  unsupported_schema_version?: number;
}

export interface IndexStateLoadResult {
  state: IndexStateFile;
  metadata: IndexStateLoadMetadata;
}

type IndexStateSaveInput = Omit<IndexStateFile, 'schema_version' | 'provider_id' | 'workspace_fingerprint' | 'feature_flags_snapshot'> &
  Partial<Pick<IndexStateFile, 'schema_version' | 'provider_id' | 'workspace_fingerprint' | 'feature_flags_snapshot'>>;

export class JsonIndexStateStore {
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  private getPath(): string {
    return getPreferredWorkspacePath(this.workspacePath, {
      preferred: INDEX_STATE_FILE_NAME,
      legacy: LEGACY_INDEX_STATE_FILE_NAME,
    });
  }

  private getReadablePath(): string {
    return getReadableWorkspacePath(this.workspacePath, {
      preferred: INDEX_STATE_FILE_NAME,
      legacy: LEGACY_INDEX_STATE_FILE_NAME,
    });
  }

  private getDefaultState(): IndexStateFile {
    return {
      version: DEFAULT_INDEX_STATE_VERSION,
      schema_version: DEFAULT_SCHEMA_VERSION,
      provider_id: DEFAULT_PROVIDER_ID,
      updated_at: EPOCH_ISO,
      workspace_fingerprint: this.buildWorkspaceFingerprint(),
      files: {},
    };
  }

  private buildWorkspaceFingerprint(): string {
    const normalizedWorkspacePath = path.resolve(this.workspacePath).replace(/\\/g, '/');
    return crypto.createHash('sha256').update(normalizedWorkspacePath).digest('hex').slice(0, 16);
  }

  load(): IndexStateFile {
    return this.loadWithMetadata().state;
  }

  loadWithMetadata(): IndexStateLoadResult {
    const p = this.getReadablePath();
    if (!fs.existsSync(p)) {
      return {
        state: this.getDefaultState(),
        metadata: { warnings: [] },
      };
    }
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<IndexStateFile>;
      if (!parsed || typeof parsed !== 'object') {
        return {
          state: this.getDefaultState(),
          metadata: { warnings: [] },
        };
      }
      const parsedSchemaVersion =
        typeof parsed.schema_version === 'number' ? parsed.schema_version : LEGACY_SCHEMA_VERSION;
      if (parsedSchemaVersion > DEFAULT_SCHEMA_VERSION) {
        return {
          state: this.getDefaultState(),
          metadata: {
            warnings: [
              `Unsupported index state schema_version=${parsedSchemaVersion}; resetting to empty default state.`,
            ],
            unsupported_schema_version: parsedSchemaVersion,
          },
        };
      }
      const files = (parsed.files && typeof parsed.files === 'object') ? (parsed.files as any) : {};
      return {
        state: {
          version: typeof parsed.version === 'number' ? parsed.version : DEFAULT_INDEX_STATE_VERSION,
          schema_version: parsedSchemaVersion,
          provider_id:
            typeof parsed.provider_id === 'string' && parsed.provider_id.trim().length > 0
              ? parsed.provider_id
              : DEFAULT_PROVIDER_ID,
          updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : EPOCH_ISO,
          workspace_fingerprint:
            typeof parsed.workspace_fingerprint === 'string' && parsed.workspace_fingerprint.trim().length > 0
              ? parsed.workspace_fingerprint
              : this.buildWorkspaceFingerprint(),
          feature_flags_snapshot:
            typeof parsed.feature_flags_snapshot === 'string' && parsed.feature_flags_snapshot.trim().length > 0
              ? parsed.feature_flags_snapshot
              : undefined,
          files,
        },
        metadata: { warnings: [] },
      };
    } catch {
      return {
        state: this.getDefaultState(),
        metadata: { warnings: [] },
      };
    }
  }

  save(data: IndexStateSaveInput): void {
    const p = this.getPath();
    const tmp = `${p}.tmp`;
    const payload: IndexStateFile = {
      version: data.version ?? DEFAULT_INDEX_STATE_VERSION,
      schema_version: data.schema_version ?? DEFAULT_SCHEMA_VERSION,
      provider_id:
        typeof data.provider_id === 'string' && data.provider_id.trim().length > 0
          ? data.provider_id
          : DEFAULT_PROVIDER_ID,
      updated_at: data.updated_at ?? new Date().toISOString(),
      workspace_fingerprint: data.workspace_fingerprint ?? this.buildWorkspaceFingerprint(),
      feature_flags_snapshot:
        typeof data.feature_flags_snapshot === 'string' && data.feature_flags_snapshot.trim().length > 0
          ? data.feature_flags_snapshot
          : undefined,
      files: data.files ?? {},
    };
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
      fs.renameSync(tmp, p);
    } catch {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
  }
}
