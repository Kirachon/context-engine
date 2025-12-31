import * as fs from 'fs';
import * as path from 'path';

const INDEX_STATE_FILE_NAME = '.augment-index-state.json';

export interface IndexStateFileEntry {
  hash: string;
  indexed_at: string;
}

export interface IndexStateFile {
  version: number;
  updated_at: string;
  files: Record<string, IndexStateFileEntry>;
}

export class JsonIndexStateStore {
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  private getPath(): string {
    return path.join(this.workspacePath, INDEX_STATE_FILE_NAME);
  }

  load(): IndexStateFile {
    const p = this.getPath();
    if (!fs.existsSync(p)) {
      return { version: 1, updated_at: new Date(0).toISOString(), files: {} };
    }
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<IndexStateFile>;
      if (!parsed || typeof parsed !== 'object') {
        return { version: 1, updated_at: new Date(0).toISOString(), files: {} };
      }
      const files = (parsed.files && typeof parsed.files === 'object') ? (parsed.files as any) : {};
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : new Date(0).toISOString(),
        files,
      };
    } catch {
      return { version: 1, updated_at: new Date(0).toISOString(), files: {} };
    }
  }

  save(data: IndexStateFile): void {
    const p = this.getPath();
    const tmp = `${p}.tmp`;
    const payload: IndexStateFile = {
      version: data.version ?? 1,
      updated_at: data.updated_at ?? new Date().toISOString(),
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

